import assert from 'node:assert/strict';
import { PluginRuntime, PluginSettingsStore, installForTest } from '../../../../testing/core.js';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, it } from 'node:test';

import { VariableStore, createActionRegistry } from '@easydeck/engine';
import type { ActionContext } from '@easydeck/engine';

import { FakeStation, playingState } from './fake-station.js';
import { discoverSpeakers } from './glagol-discovery.js';
import type { DiscoveredSpeaker } from './glagol-discovery.js';
import { activateWith, yandexManifest } from './yandex-plugin.js';

const TOKEN = 'device-token';

function context(variables: VariableStore): ActionContext {
  return {
    variables,
    deckId: 'test',
    button: { id: 'b', key: 0 },
    location: { folderId: 'root', pageId: 'main' },
    profileId: 'test',
    openFolder: () => undefined,
    goToPage: () => undefined,
    goUp: () => undefined,
    goHome: () => undefined,
    goBack: () => undefined,
    setButtonState: () => undefined,
    setWidgetParam: () => undefined,
  } as unknown as ActionContext;
}

/** Every bench built, closed at the end whatever happened. */
const benches: Array<() => Promise<void>> = [];

after(async () => {
  for (const close of benches) await close();
  benches.length = 0;
});

interface BenchOptions {
  readonly enabled?: boolean;
  readonly signedIn?: boolean;
  /** Which speaker the settings name; omitted means none was chosen. */
  readonly chosen?: string;
  readonly state?: ReturnType<typeof playingState>;
  /** How long the stand-in speaker waits before reporting a change. */
  readonly lagMs?: number;
  /** Adds one of ours that is switched off, to see how it is offered. */
  readonly offline?: boolean;
}

/**
 * A runtime with the plugin installed and one stand-in speaker behind it.
 *
 * The speaker is remembered rather than discovered: discovery needs a network
 * and an account, and what these tests are about is what happens once it has
 * been done.
 */
async function bench(options: BenchOptions = {}) {
  const station = new FakeStation({
    token: TOKEN,
    ...(options.state ? { state: options.state } : {}),
    ...(options.lagMs === undefined ? {} : { lagMs: options.lagMs }),
  });
  const port = await station.listen();

  const known = [
    {
      deviceId: 'office',
      platform: 'yandexmini_2',
      name: 'Яндекс станция',
      room: 'Кабинет',
      host: '127.0.0.1',
      port,
    },
    {
      deviceId: 'stranger',
      platform: 'cucumber',
      name: 'stranger',
      host: '127.0.0.1',
      port: 1,
      foreign: true,
    },
    ...(options.offline
      ? [{ deviceId: 'bedroom', platform: 'yandexmicro', name: 'Лайм', room: 'Спальня' }]
      : []),
  ];

  const dir = `${process.env['TEMP'] ?? '/tmp'}/easydeck-yandex-${port}`;
  const settings = new PluginSettingsStore(undefined, `${dir}/open`, `${dir}/sealed`);
  await settings.save(
    'ed.yandex',
    {
      enabled: options.enabled ?? true,
      token: options.signedIn === false ? '' : 'x-token',
      devices: JSON.stringify(known),
      ...(options.chosen ? { speaker: options.chosen } : {}),
    },
    yandexManifest.settings ?? [],
  );

  const variables = new VariableStore();
  const registry = createActionRegistry();
  const runtime = new PluginRuntime({ settings, variables });
  runtime.on('error', () => undefined);

  await installForTest(
    yandexManifest,
    activateWith({
      retryDelaysMs: [50, 100],
      secure: false,
      // The key is asked for when a socket opens, because a real one lasts
      // less than a day. A test has no account to ask, so it answers here.
      deviceToken: async (speaker) => (speaker.deviceId === 'office' ? TOKEN : ''),
    }),
    registry,
    runtime,
  );

  let closed = false;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    await runtime.stopAll();
    await station.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(
      () => undefined,
    );
  };
  benches.push(dispose);

  return {
    station,
    variables,
    registry,
    runtime,
    dispose,
    run: (type: string, params: Record<string, unknown> = {}) =>
      registry.run({ type, params }, context(variables)),
    /**
     * What a key actually asked for, keepalives left out.
     *
     * The connection pings on open and every half minute after, and a test
     * reading "the last command" would otherwise be reading the heartbeat.
     */
    sent: () => station.commands.filter((command) => command['command'] !== 'ping'),
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

describe('the Yandex Station plugin', () => {
  it('stays off until somebody turns it on', async () => {
    const bed = await bench({ enabled: false });

    assert.equal(bed.runtime.status('ed.yandex')?.status, 'off');
    await bed.dispose();
  });

  it('says what is missing rather than just failing', async () => {
    const bed = await bench({ signedIn: false });

    await bed.until('the plugin to ask for a sign-in', () => {
      const status = bed.runtime.status('ed.yandex');
      return status?.status === 'error' && /sign in|Вход/i.test(status.message?.en ?? '');
    });

    await bed.dispose();
  });

  it('connects to a remembered speaker and publishes what it plays', async () => {
    const bed = await bench({ state: playingState() });

    await bed.until('the track to appear', () => bed.variables.get('ed.yandex.title') === 'TAKE ME');

    assert.equal(bed.variables.get('ed.yandex.artist'), 'D A N N Y');
    assert.equal(bed.variables.get('ed.yandex.playing'), true);
    // Reported as a person reads it, not as the speaker sends it.
    assert.equal(bed.variables.get('ed.yandex.volume'), 40);
    assert.equal(bed.variables.get('ed.yandex.speaker'), 'Яндекс станция');
    assert.equal(bed.variables.get('ed.yandex.source'), 'Playlist');

    // And the same values under the speaker's own name, which is what lets a
    // profile show four rooms at once rather than whichever one was chosen.
    assert.equal(bed.variables.get('ed.yandex.title(office)'), 'TAKE ME');
    assert.equal(bed.variables.get('ed.yandex.playing(office)'), true);
    assert.equal(bed.variables.get('ed.yandex.connected(office)'), true);
    assert.equal(bed.runtime.status('ed.yandex')?.status, 'ready');

    await bed.dispose();
  });

  it('writes the position as a clock as well as a number', async () => {
    const bed = await bench({ state: playingState() });
    await bed.until('the position', () => bed.variables.get('ed.yandex.progress') === 16);

    assert.equal(bed.variables.get('ed.yandex.progress-time'), '0:16');
    assert.equal(bed.variables.get('ed.yandex.progress-time(office)'), '0:16');
    // The pair a label is written from: "0:16 / 2:09".
    assert.equal(bed.variables.get('ed.yandex.duration-time'), '2:09');

    // Two digits of seconds throughout, so a label does not jump about; the
    // hour appears only once something is long enough to have one.
    bed.station.publish({ ...playingState(), playerState: { ...playingState().playerState, progress: 3727 } });
    await bed.until('the longer position', () => bed.variables.get('ed.yandex.progress') === 3727);
    assert.equal(bed.variables.get('ed.yandex.progress-time'), '1:02:07');

    await bed.dispose();
  });

  it('offers our speakers and nobody else’s', async () => {
    const bed = await bench({ offline: true });
    await bed.until('the connection', () => bed.runtime.status('ed.yandex')?.status === 'ready');

    const offered = await bed.runtime.optionsFor('ed.yandex', 'speakers');
    const values = offered.map((option) => option.value);

    // The stranger on the network is somebody else's and never appears; the
    // one of ours that is switched off does, and says so. Ordered by room, so
    // Кабинет comes before Спальня — the list reads as a plan of the flat.
    assert.deepEqual(values, ['office', 'bedroom']);
    assert.equal(offered[0]?.label?.en, 'Кабинет · Яндекс станция');
    assert.match(offered[1]?.label?.ru ?? '', /Спальня · Лайм \(не в сети\)/);

    await bed.dispose();
  });

  it('never touches a speaker that is not in the account', async () => {
    const bed = await bench();

    await bed.until('the connection to settle', () => bed.runtime.status('ed.yandex')?.status === 'ready');
    // The stranger's port would refuse anything; reaching it at all is the bug.
    await failsWith(() => bed.run('ed.yandex.next-track', { speaker: 'stranger' }), /not connected/i);

    await bed.dispose();
  });

  it('pauses what is playing and starts what is not', async () => {
    // The speaker takes its time answering, as the real one does — which is
    // the whole point: a key must show the press before it is confirmed.
    const bed = await bench({ state: playingState(), lagMs: 400 });
    await bed.until('the state to arrive', () => bed.variables.get('ed.yandex.playing') === true);

    await bed.run('ed.yandex.play-pause', { mode: 'toggle' });

    // Read straight after the press: the command is still crossing the wire,
    // let alone being answered, and the key has already changed.
    assert.equal(bed.variables.get('ed.yandex.playing'), false);

    await bed.until('the command to arrive', () => bed.sent().length > 0);
    assert.equal(last(bed.sent())['command'], 'stop');

    // And still false once it does speak, which is what makes the optimism
    // safe rather than a guess that gets overwritten.
    await delay(600);
    assert.equal(bed.variables.get('ed.yandex.playing'), false);

    await bed.dispose();
  });

  it('moves the volume by a step the speaker can actually keep', async () => {
    const bed = await bench({ state: playingState() });
    await bed.until('the volume to arrive', () => bed.variables.get('ed.yandex.volume') === 40);

    await bed.run('ed.yandex.volume', { mode: 'up', value: 15 });
    await bed.until('a command to reach the speaker', () => bed.sent().length > 0);

    const command = last(bed.sent());
    assert.equal(command['command'], 'setVolume');
    // 0.4 + 0.15 is 0.55, and the speaker keeps one decimal place: sending the
    // unrounded number would have the key twitch back on the next state.
    assert.equal(command['volume'], 0.6);

    await bed.dispose();
  });

  it('seeks from where the track actually is', async () => {
    const bed = await bench({ state: playingState() });
    await bed.until('the position to arrive', () => bed.variables.get('ed.yandex.progress') === 16);

    await bed.run('ed.yandex.rewind', { mode: 'forward', seconds: 30 });
    await bed.until('a command to reach the speaker', () => bed.sent().length > 0);

    assert.deepEqual(last(bed.sent()), { command: 'rewind', position: 46 });

    await bed.dispose();
  });

  it('cycles repeat through the modes the speaker names', async () => {
    const bed = await bench({ state: playingState() });
    await bed.until('the state to arrive', () => bed.variables.get('ed.yandex.source') === 'Playlist');

    await bed.run('ed.yandex.repeat', { mode: 'cycle' });
    await bed.until('a command to reach the speaker', () => bed.sent().length > 0);

    // None → All → One, which is the order the speaker's own app offers.
    assert.deepEqual(last(bed.sent()), { command: 'repeat', mode: 'All' });

    await bed.dispose();
  });

  it('keeps a spoken phrase apart from a command to Alice', async () => {
    const bed = await bench();
    await bed.until('the connection', () => bed.runtime.status('ed.yandex')?.status === 'ready');

    await bed.run('ed.yandex.command', { text: 'включи ночник' });
    await bed.until('the command', () => bed.sent().length > 0);
    assert.deepEqual(last(bed.sent()), { command: 'sendText', text: 'включи ночник' });

    const before = bed.sent().length;
    await bed.run('ed.yandex.say', { text: 'привет' });
    await bed.until('the phrase', () => bed.sent().length > before);

    // Not sendText: that would have Alice carry the words out and answer,
    // where this one has the speaker read them and stop.
    const spoken = last(bed.sent());
    assert.equal(spoken['command'], 'serverAction');
    assert.match(JSON.stringify(spoken), /repeat_phrase/);
    assert.match(JSON.stringify(spoken), /привет/);

    await bed.dispose();
  });

  it('draws the album art of whatever is on', async () => {
    const bed = await bench({ state: playingState() });
    const asked: string[] = [];
    const restore = stubFetch(asked);

    try {
      await bed.until('the track', () => bed.variables.get('ed.yandex.title') === 'TAKE ME');

      let frame;
      await bed.until('the art to be fetched', async () => {
        frame = await bed.runtime.drawSurface({
          type: 'ed.yandex.cover',
          params: {},
          cols: 1,
          rows: 1,
          buttons: ['b'],
        });
        return frame !== undefined;
      });

      assert.match(frame!.source, /^data:image\/png;base64,/);
      // The identity is the cover's own address, which is what lets the panel
      // skip writing a key that has been showing the same sleeve for an hour.
      assert.equal(frame!.id, 'avatars.example/cover/200x200');

      // Fetched once per size, however many times a key asks. A repaint
      // happens whenever anything moves anywhere on the page.
      await bed.runtime.drawSurface({
        type: 'ed.yandex.cover',
        params: {},
        cols: 1,
        rows: 1,
        buttons: ['b'],
      });
      assert.equal(asked.filter((url) => url.endsWith('200x200')).length, 1);
    } finally {
      restore();
      await bed.dispose();
    }
  });

  it('refuses to guess which speaker a key meant', async () => {
    // Two usable speakers and no choice made: acting on either would be a coin
    // toss, and a coin toss that turns on music in the wrong room.
    const bed = await bench();
    await bed.until('the connection', () => bed.runtime.status('ed.yandex')?.status === 'ready');

    await failsWith(() => bed.run('ed.yandex.next-track', { speaker: 'nobody' }), /No speaker/i);

    await bed.dispose();
  });
});

describe('finding speakers on the network', () => {
  it('is one speaker however many interfaces saw it', async () => {
    const seen: DiscoveredSpeaker = {
      deviceId: 'office',
      platform: 'yandexmini_2',
      host: '192.168.1.114',
      port: 1961,
    };

    const speakers = await discoverSpeakers({
      forMs: 5,
      browse: (_address, found) => {
        found(seen);
        found({ ...seen, host: '10.0.0.7' });
        return () => undefined;
      },
    });

    assert.equal(speakers.length, 1);
    assert.equal(speakers[0]?.host, '192.168.1.114');
  });

  it('stops listening even when the wait is cut short', async () => {
    let stopped = 0;

    await discoverSpeakers({
      forMs: 5,
      browse: () => () => {
        stopped += 1;
      },
    });

    // One per interface: a browser left running holds a socket for the life of
    // the program.
    assert.ok(stopped > 0);
  });
});

/**
 * Serves a one-pixel picture for any address, and records who was asked.
 *
 * The covers live on Yandex's own image hosts, which a test must not depend on
 * being reachable — and the thing under test is what the plugin does with the
 * bytes, not where they came from.
 */
function stubFetch(asked: string[]): () => void {
  const real = globalThis.fetch;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    asked.push(String(input));
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = real;
  };
}

/**
 * Runs something that must fail, and checks *why*.
 *
 * The registry wraps whatever an action threw in an `ActionFailedError` naming
 * the button, so matching on the outer message only ever proves that something
 * went wrong — which every misspelt action type would also prove.
 */
async function failsWith(run: () => Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await run();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    assert.match((cause as Error).message, expected);
    return;
  }

  assert.fail(`expected a failure matching ${expected}`);
}

function last(commands: Record<string, unknown>[]): Record<string, unknown> {
  const command = commands.at(-1);
  assert.ok(command, 'no command reached the speaker');
  return command;
}

describe('a key that goes stale overnight', () => {
  it('asks for a new one instead of giving up', async () => {
    /*
     * Measured, not imagined: a speaker stops accepting its key within a day,
     * and the key used to be written into the settings and reused for ever.
     * A deck that worked in the evening was refused in the morning and stayed
     * refused until somebody pressed "Find speakers" — which nobody does,
     * because nothing says to.
     */
    const station = new FakeStation({ token: 'the-new-one' });
    const port = await station.listen();

    const dir = `${process.env['TEMP'] ?? '/tmp'}/easydeck-stale-${port}`;
    const settings = new PluginSettingsStore(undefined, `${dir}/open`, `${dir}/sealed`);
    await settings.save(
      'ed.yandex',
      {
        enabled: true,
        token: 'x-token',
        devices: JSON.stringify([
          { deviceId: 'office', platform: 'yandexmini_2', name: 'Кабинет', host: '127.0.0.1', port },
        ]),
      },
      yandexManifest.settings ?? [],
    );

    const variables = new VariableStore();
    const registry = createActionRegistry();
    const runtime = new PluginRuntime({ settings, variables });
    runtime.on('error', () => undefined);

    // The first key is the one the speaker refuses; the second is the one it
    // takes. Which is the shape of a token that expired while nobody looked.
    const handed: string[] = [];
    const keys = ['the-stale-one', 'the-new-one'];

    await installForTest(
      yandexManifest,
      activateWith({
        retryDelaysMs: [20, 20],
        secure: false,
        deviceToken: async () => {
          const key = keys.shift() ?? 'the-new-one';
          handed.push(key);
          return key;
        },
      }),
      registry,
      runtime,
    );

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && variables.get('ed.yandex.connected') !== true) {
      await delay(20);
    }

    assert.equal(variables.get('ed.yandex.connected'), true);
    // Refused once, asked again, connected — with no key kept on disk to go
    // stale in the first place.
    assert.deepEqual(handed, ['the-stale-one', 'the-new-one']);
    assert.equal(JSON.stringify(await settings.load('ed.yandex')).includes('the-new-one'), false);

    await runtime.stopAll();
    await station.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => undefined);
  });
});
