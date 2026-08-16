import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, it } from 'node:test';

import { VariableStore, createActionRegistry } from '@easydeck/engine';
import type { ActionContext } from '@easydeck/engine';

import { PluginRuntime, PluginSettingsStore, installForTest } from '../../../../testing/core.js';
import { FakeDiscord } from './fake-discord.js';
import type { FakeChannel } from './fake-discord.js';
import { activateWith, discordManifest } from './discord-plugin.js';

const TOKEN = 'granted-token';

/** A channel with two people in it, one of whom is us. */
const CHANNEL: FakeChannel = {
  id: 'c-voice',
  name: 'Общий',
  voice_states: [
    { user: { id: 'me', username: 'tester', global_name: 'Тестер' } },
    { user: { id: 'friend', username: 'friend' }, nick: 'Сосед' },
  ],
};

/**
 * A room with more people in it than a key has tiles for.
 *
 * Each with an avatar hash of their own, which the fake CDN below answers
 * with — so a face in the picture can be told from the face beside it.
 */
const CROWD: FakeChannel = {
  id: 'c-voice',
  name: 'Общий',
  voice_states: ['me', 'a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ({
    user: { id, username: id, avatar: id },
  })),
};

/**
 * Discord's picture server, as a test may have one.
 *
 * Answers with the avatar hash as the bytes of the picture, which is not a
 * PNG and does not need to be: nothing here decodes one, and it means the
 * face drawn into a tile can be read back and named.
 */
function cdn(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const address = String(input);
    const hash = /avatars\/[^/]+\/([^.]+)\.png/.exec(address)?.[1] ?? 'default';
    return new Response(Buffer.from(hash, 'utf8'), { headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;
}

/** The markup of a frame, whichever way the runtime wrapped it. */
function svgOf(frame: { source: string } | undefined): string {
  if (!frame) return '';
  if (!frame.source.startsWith('data:')) return frame.source;

  const [head, body = ''] = frame.source.split(',');
  return head?.includes('base64')
    ? Buffer.from(body, 'base64').toString('utf8')
    : decodeURIComponent(body);
}

/** Who is in the picture, in the order their tiles were drawn. */
function facesIn(svg: string): string[] {
  return [...svg.matchAll(/href="data:[^;]+;base64,([^"]+)"/g)].map((found) =>
    Buffer.from(found[1] ?? '', 'base64').toString('utf8'),
  );
}

function context(variables: VariableStore): ActionContext {
  return {
    variables,
    deckId: 'test',
    button: { id: 'b', key: 0 },
    location: { folderId: 'root', pageId: 'main' },
    profileId: 'test',
  } as unknown as ActionContext;
}

const benches: Array<() => Promise<void>> = [];

after(async () => {
  for (const close of benches) await close();
  benches.length = 0;
});

interface BenchOptions {
  readonly enabled?: boolean;
  /** Omitted means the plugin has never been authorised. */
  readonly token?: string;
  readonly channel?: FakeChannel;
  readonly refuse?: Readonly<Record<string, string>>;
}

async function bench(options: BenchOptions = {}) {
  const discord = new FakeDiscord({
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.refuse ? { refuse: options.refuse } : {}),
  });
  const path = await discord.listen();

  const dir = `${process.env['TEMP'] ?? '/tmp'}/easydeck-discord-${Date.now()}-${Math.random()}`;
  const settings = new PluginSettingsStore(undefined, `${dir}/open`, `${dir}/sealed`);
  await settings.save(
    'ed.discord',
    {
      enabled: options.enabled ?? true,
      clientId: 'app-id',
      clientSecret: 'app-secret',
      token: options.token ?? '',
    },
    discordManifest.settings ?? [],
  );

  const variables = new VariableStore();
  const registry = createActionRegistry();
  const runtime = new PluginRuntime({ settings, variables });
  runtime.on('error', () => undefined);

  await installForTest(
    discordManifest,
    // A fetcher of our own, or drawing a face would reach Discord's CDN from
    // a test.
    activateWith({ path, retryDelaysMs: [50, 100], fetcher: cdn() }),
    registry,
    runtime,
  );

  let closed = false;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    await runtime.stopAll();
    await discord.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(
      () => undefined,
    );
  };
  benches.push(dispose);

  return {
    discord,
    variables,
    runtime,
    dispose,
    run: (type: string, params: Record<string, unknown> = {}) =>
      registry.run({ type, params }, context(variables)),
    /** The widget, drawn for one key, as the faces that ended up in it. */
    async faces(params: Record<string, unknown> = {}): Promise<string[]> {
      const frame = await runtime.drawSurface({
        type: 'ed.discord.speakers',
        params,
        cols: 1,
        rows: 1,
        buttons: ['b'],
      });
      return facesIn(svgOf(frame));
    },
    async frame(params: Record<string, unknown> = {}) {
      return runtime.drawSurface({
        type: 'ed.discord.speakers',
        params,
        cols: 1,
        rows: 1,
        buttons: ['b'],
      });
    },
    /** What a key asked for, with the plumbing left out. */
    sent: () =>
      discord.commands.filter(
        (command) => !['AUTHENTICATE', 'GET_GUILDS', 'GET_CHANNELS'].includes(command.cmd),
      ),
    async until(what: string, holds: () => boolean | Promise<boolean>, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await holds()) return;
        await delay(20);
      }
      assert.fail(`timed out waiting for ${what}`);
    },
  };
}

describe('the Discord plugin', () => {
  it('stays off until somebody turns it on', async () => {
    const bed = await bench({ enabled: false });

    assert.equal(bed.runtime.status('ed.discord')?.status, 'off');
    await bed.dispose();
  });

  it('connects but does nothing until it has been authorised', async () => {
    const bed = await bench();

    // The ordinary state before the button has ever been pressed: the pipe is
    // open and the plugin is allowed to do nothing through it.
    await bed.until('the plugin to ask to be authorised', () => {
      const status = bed.runtime.status('ed.discord');
      return status?.status === 'error' && /authoris/i.test(status.message?.en ?? '');
    });

    assert.equal(bed.variables.get('ed.discord.connected'), false);
    await bed.dispose();
  });

  it('says who it is once it has a token, and reads the room', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });

    await bed.until('the connection', () => bed.variables.get('ed.discord.connected') === true);
    await bed.until('the channel', () => bed.variables.get('ed.discord.channel') === 'Общий');

    assert.equal(bed.variables.get('ed.discord.members'), 2);
    assert.equal(bed.runtime.status('ed.discord')?.status, 'ready');
    // The name Discord answered with, so the settings window can show it.
    assert.equal(bed.runtime.status('ed.discord')?.message?.en, 'Тестер');

    await bed.dispose();
  });

  it('mutes, and says so before Discord has confirmed it', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    await bed.until('the connection', () => bed.variables.get('ed.discord.muted') === false);

    await bed.run('ed.discord.mute', { mode: 'toggle' });

    // Published at once: the update event follows, and a key that waited for
    // a round trip would look broken.
    assert.equal(bed.variables.get('ed.discord.muted'), true);
    assert.deepEqual(bed.sent().at(-1), { cmd: 'SET_VOICE_SETTINGS', args: { mute: true } });

    await bed.dispose();
  });

  it('reports the microphone as off when deafening turns it off', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    await bed.until('the connection', () => bed.variables.get('ed.discord.deafened') === false);

    await bed.run('ed.discord.deafen', { mode: 'toggle' });

    // Discord mutes along with deafening. A key bound to the microphone must
    // not wait for the event to find that out.
    assert.equal(bed.variables.get('ed.discord.deafened'), true);
    assert.equal(bed.variables.get('ed.discord.muted'), true);

    await bed.dispose();
  });

  it('keeps each volume inside the ceiling Discord allows it', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    await bed.until('the connection', () => bed.variables.get('ed.discord.connected') === true);

    // The microphone stops at 100 and the output goes to 200: Discord's own
    // limits, and it refuses rather than clamping.
    await bed.run('ed.discord.volume', { which: 'input', mode: 'set', value: 180 });
    assert.deepEqual(bed.sent().at(-1), { cmd: 'SET_VOICE_SETTINGS', args: { input: { volume: 100 } } });

    await bed.run('ed.discord.volume', { which: 'output', mode: 'set', value: 180 });
    assert.deepEqual(bed.sent().at(-1), { cmd: 'SET_VOICE_SETTINGS', args: { output: { volume: 180 } } });

    await bed.run('ed.discord.volume', { which: 'output', mode: 'down', value: 30 });
    assert.deepEqual(bed.sent().at(-1), { cmd: 'SET_VOICE_SETTINGS', args: { output: { volume: 150 } } });

    await bed.dispose();
  });

  it('leaves a channel by joining nothing at all', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    await bed.until('the connection', () => bed.variables.get('ed.discord.connected') === true);

    await bed.run('ed.discord.join', { channel: 'c-voice' });
    assert.deepEqual(bed.sent().at(-2), {
      cmd: 'SELECT_VOICE_CHANNEL',
      args: { channel_id: 'c-voice', force: true },
    });

    // Null rather than an empty string: Discord reads that field for a
    // channel id, and an empty string is not one.
    await bed.run('ed.discord.join', {});
    assert.deepEqual(bed.sent().at(-2), {
      cmd: 'SELECT_VOICE_CHANNEL',
      args: { channel_id: null, force: true },
    });

    await bed.dispose();
  });

  it('moves somebody who is already in a call, which is most of the time', async () => {
    /*
     * Regression, and one a log found rather than a test: without `force`,
     * Discord answers "User is already joined to a voice channel" and does
     * nothing — so the key worked from the lobby and failed from anywhere
     * else, which is the half of the time nobody presses it.
     */
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    await bed.until('the connection', () => bed.variables.get('ed.discord.connected') === true);

    await bed.run('ed.discord.join', { channel: 'c-other' });

    assert.deepEqual(bed.sent().at(-2), {
      cmd: 'SELECT_VOICE_CHANNEL',
      args: { channel_id: 'c-other', force: true },
    });

    await bed.dispose();
  });

  it('names who is talking, and knows when it is you', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    await bed.until('the channel', () => bed.variables.get('ed.discord.members') === 2);

    bed.discord.emit('SPEAKING_START', { user_id: 'friend' });
    await bed.until('the neighbour', () => bed.variables.get('ed.discord.speaking') === 'Сосед');
    // Somebody else talking is not you talking.
    assert.equal(bed.variables.get('ed.discord.talking'), false);

    bed.discord.emit('SPEAKING_START', { user_id: 'me' });
    await bed.until('yourself', () => bed.variables.get('ed.discord.talking') === true);
    // Two at once, which is what a set is for.
    assert.match(String(bed.variables.get('ed.discord.speaking')), /Сосед/);
    assert.match(String(bed.variables.get('ed.discord.speaking')), /Тестер/);

    bed.discord.emit('SPEAKING_STOP', { user_id: 'friend' });
    bed.discord.emit('SPEAKING_STOP', { user_id: 'me' });
    await bed.until('quiet', () => bed.variables.get('ed.discord.speaking') === '');
    assert.equal(bed.variables.get('ed.discord.talking'), false);

    await bed.dispose();
  });

  it('offers the voice channels and nothing else', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    await bed.until('the connection', () => bed.variables.get('ed.discord.connected') === true);
    await bed.until('the list', async () => (await bed.runtime.optionsFor('ed.discord', 'channels')).length > 0);

    const channels = await bed.runtime.optionsFor('ed.discord', 'channels');
    // Type 2 is voice; a text channel cannot be joined by voice and is not
    // offered as though it could.
    assert.deepEqual(
      channels.map((option) => option.value),
      ['c-voice'],
    );
    assert.equal(channels[0]?.label?.en, 'Дом · Общий');

    const members = await bed.runtime.optionsFor('ed.discord', 'members');
    assert.deepEqual(
      members.map((option) => option.label?.en),
      ['Тестер', 'Сосед'],
    );

    await bed.dispose();
  });

  it('says what Discord said when Discord refuses', async () => {
    const bed = await bench({
      token: TOKEN,
      refuse: { AUTHENTICATE: 'Invalid access token' },
    });

    // A token revoked in Discord's own settings is the everyday cause, and
    // "press Authorise again" is the only useful thing to say about it.
    await bed.until('the refusal to be reported', () => {
      const status = bed.runtime.status('ed.discord');
      return status?.status === 'error' && /Invalid access token/.test(status.message?.en ?? '');
    });

    await bed.dispose();
  });
});

describe('the faces of whoever is talking', () => {
  it('shows nothing at all while the room is quiet', async () => {
    const bed = await bench({ token: TOKEN, channel: CROWD });
    await bed.until('the room', () => bed.variables.get('ed.discord.members') === 6);

    // Not an empty picture: no picture, so the key shows whatever it was
    // given — its own background and label.
    assert.equal(await bed.frame(), undefined);

    await bed.dispose();
  });

  it('gives four people four tiles, and the newest takes the stalest', async () => {
    const bed = await bench({ token: TOKEN, channel: CROWD });
    await bed.until('the room', () => bed.variables.get('ed.discord.members') === 6);

    for (const id of ['a1', 'a2', 'a3', 'a4']) bed.discord.emit('SPEAKING_START', { user_id: id });
    await bed.until('four faces', async () => (await bed.faces()).length === 4);
    assert.deepEqual(await bed.faces(), ['a1', 'a2', 'a3', 'a4']);

    /*
     * A fifth voice, and only four tiles.
     *
     * The newcomer takes the tile of whoever has been going longest, and takes
     * it *in place*: nobody else moves. A face that slid across the key every
     * time somebody else spoke would be unreadable in exactly the situation
     * this widget exists for.
     */
    bed.discord.emit('SPEAKING_START', { user_id: 'a5' });
    await bed.until('the fifth voice', async () => (await bed.faces()).includes('a5'));
    assert.deepEqual(await bed.faces(), ['a5', 'a2', 'a3', 'a4']);

    // And somebody dropped that way was only off screen, not forgotten: a1
    // never stopped talking, and takes the first tile to come free.
    bed.discord.emit('SPEAKING_STOP', { user_id: 'a2' });
    await bed.until('the tile to free up', async () => !(await bed.faces()).includes('a2'));
    assert.deepEqual(await bed.faces(), ['a5', 'a3', 'a4', 'a1']);

    await bed.dispose();
  });

  it('holds the last faces faded, for a key that asked not to blink', async () => {
    const bed = await bench({ token: TOKEN, channel: CROWD });
    await bed.until('the room', () => bed.variables.get('ed.discord.members') === 6);

    bed.discord.emit('SPEAKING_START', { user_id: 'a1' });
    await bed.until('the face', async () => (await bed.faces({ quiet: 'last' })).length === 1);

    bed.discord.emit('SPEAKING_STOP', { user_id: 'a1' });
    await bed.until('the room to go quiet', () => bed.variables.get('ed.discord.speaking') === '');

    // A pause between two sentences is about a second, and a key that goes
    // blank for it does not read as quiet — it reads as broken.
    const svg = svgOf(await bed.frame({ quiet: 'last' }));
    assert.deepEqual(facesIn(svg), ['a1']);
    assert.match(svg, /<g opacity="0\.35">/);

    // The other way round, the same moment is nothing at all.
    assert.equal(await bed.frame({ quiet: 'nothing' }), undefined);

    await bed.dispose();
  });

  it('forgets the room when you leave it', async () => {
    const bed = await bench({ token: TOKEN, channel: CROWD });
    await bed.until('the room', () => bed.variables.get('ed.discord.members') === 6);

    bed.discord.emit('SPEAKING_START', { user_id: 'a1' });
    await bed.until('the face', async () => (await bed.faces()).length === 1);

    // Leaving mid-sentence is normal, and Discord sends no stop for it. A key
    // still showing that face afterwards would be showing a different call.
    bed.discord.channel = undefined as unknown as FakeChannel;
    bed.discord.emit('VOICE_CHANNEL_SELECT', { channel_id: null });
    await bed.until('the picture to empty', async () => (await bed.faces({ quiet: 'last' })).length === 0);

    await bed.dispose();
  });

  it('names the picture by what is in it, so a still is written once', async () => {
    const bed = await bench({ token: TOKEN, channel: CROWD });
    await bed.until('the room', () => bed.variables.get('ed.discord.members') === 6);

    bed.discord.emit('SPEAKING_START', { user_id: 'a1' });
    await bed.until('the face', async () => (await bed.faces()).length === 1);

    // Two repaints of an unchanged call are one picture: the panel compares
    // these and skips the write. On a quiet call that is minutes of silence.
    const first = await bed.frame();
    const again = await bed.frame();
    assert.equal(typeof first?.id, 'string');
    assert.equal(first?.id, again?.id);

    bed.discord.emit('SPEAKING_START', { user_id: 'a2' });
    await bed.until('the second face', async () => (await bed.faces()).length === 2);
    assert.notEqual((await bed.frame())?.id, first?.id);

    await bed.dispose();
  });
});

describe('counting heads in a channel you are not in', () => {
  it('answers for the channel named, and for the one you are in', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    // A room somebody might go and join: four people, and we are in none of it.
    bed.discord.rooms['c-other'] = { voice_states: [{}, {}, {}, {}] };

    await bed.until('the channel', () => bed.variables.get('ed.discord.members') === 2);

    /*
     * Nothing is asked about a channel until a key asks.
     *
     * Otherwise showing one number would mean polling every voice channel of
     * every server this person is in, for ever.
     */
    assert.equal(bed.discord.commands.some((command) => command.cmd === 'GET_CHANNEL'), false);

    bed.runtime.setWatched(['ed.discord.members(c-other)']);
    await bed.until('the other room', () => bed.variables.get('ed.discord.members(c-other)') === 4);

    // And the bare name still means the room you are standing in.
    assert.equal(bed.variables.get('ed.discord.members'), 2);

    await bed.dispose();
  });

  it('listens to that channel rather than only polling it', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    bed.discord.rooms['c-other'] = { voice_states: [{}] };
    await bed.until('the connection', () => bed.variables.get('ed.discord.connected') === true);

    bed.runtime.setWatched(['ed.discord.members(c-other)']);
    await bed.until('the other room', () => bed.variables.get('ed.discord.members(c-other)') === 1);

    // Comings and goings, and nothing else. Speech in a room you are not in is
    // a flood of events answering a question nobody asked.
    assert.deepEqual(
      bed.discord.subscriptions.filter((one) => one.channel === 'c-other'),
      [
        { cmd: 'SUBSCRIBE', evt: 'VOICE_STATE_CREATE', channel: 'c-other' },
        { cmd: 'SUBSCRIBE', evt: 'VOICE_STATE_DELETE', channel: 'c-other' },
      ],
    );

    /*
     * A friend joins a channel next door.
     *
     * Regression: this only moved when the fifteen-second poll came round,
     * because the channel was polled and never listened to — so the number sat
     * still while somebody watched it. The wait below is far shorter than that
     * poll, which is what makes this a test of the subscription.
     */
    bed.discord.rooms['c-other'] = { voice_states: [{}, {}] };
    bed.discord.emit('VOICE_STATE_CREATE', { user: { id: 'friend' } });
    await bed.until(
      'the headcount to follow the event',
      () => bed.variables.get('ed.discord.members(c-other)') === 2,
      2000,
    );

    // And it is let go of when the key showing it goes away.
    bed.runtime.setWatched([]);
    await bed.until('the subscription to be dropped', () =>
      bed.discord.subscriptions.some(
        (one) => one.cmd === 'UNSUBSCRIBE' && one.channel === 'c-other',
      ),
    );

    await bed.dispose();
  });

  it('clears a channel it can no longer see rather than leaving a stale number', async () => {
    const bed = await bench({ token: TOKEN, channel: CHANNEL });
    bed.discord.rooms['c-other'] = { voice_states: [{}] };
    await bed.until('the connection', () => bed.variables.get('ed.discord.connected') === true);

    bed.runtime.setWatched(['ed.discord.members(c-other)']);
    await bed.until('the other room', () => bed.variables.get('ed.discord.members(c-other)') === 1);

    // Deleted, renamed, or simply not visible to this account any more. A key
    // showing yesterday's headcount is worse than one showing none.
    delete bed.discord.rooms['c-other'];
    // Asked again by way of a different list: the runtime tells a plugin only
    // when what it watches has actually changed, which is the whole point of
    // that bargain and not something to work around in the plugin.
    bed.runtime.setWatched([]);
    bed.runtime.setWatched(['ed.discord.members(c-other)']);
    await bed.until('it to be cleared', () => bed.variables.get('ed.discord.members(c-other)') === 0);

    await bed.dispose();
  });
});
