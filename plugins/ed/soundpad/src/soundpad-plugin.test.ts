import assert from 'node:assert/strict';
import { PluginRuntime, PluginSettingsStore, installForTest } from '../../../../testing/core.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { VariableStore, createActionRegistry } from '@easydeck/engine';
import type { ActionContext } from '@easydeck/engine';

import { FakeSoundpad, soundlist } from './fake-soundpad.js';
import { isComplete } from './soundpad-connection.js';
import {
  SOUNDPAD_PLUGIN_ID,
  findSound,
  activateWith,
  soundOptions,
  soundpadManifest,
} from './soundpad-plugin.js';

/**
 * The plugin through a real runtime, a real registry and a real socket, with
 * only Soundpad itself replaced.
 *
 * What is worth being wrong about here is the arrangement between an answer
 * with nothing framing it, what is being watched, and what a key receives —
 * none of which a stubbed connection could see.
 */

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Why an action failed, rather than that it did.
 *
 * The registry wraps whatever a handler throws in an `ActionFailedError` naming
 * the key, so the sentence worth asserting on is one level down.
 */
async function refusal(act: () => Promise<unknown>): Promise<string> {
  try {
    await act();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }

  assert.fail('expected that to be refused');
}

/** Everything a running Soundpad answers, in the shape it really answers it. */
const ANSWERS: Record<string, string> = {
  'GetPlayStatus()': 'STOPPED',
  'GetVolume()': '80',
  'IsMuted()': '0',
  'GetSoundFileCount()': '3',
  'GetPlaybackPositionInMs()': '4200',
  'GetPlaybackDurationInMs()': '65000',
  'GetSoundlist()': soundlist([
    { index: 1, title: 'ba dum tss' },
    { index: 2, title: '', url: 'C:\\sounds\\firework.mp3' },
    { index: 3, title: 'Кофе & чай' },
  ]),
  'DoPlaySound(1)': 'R-200',
  'DoPlaySound(2)': 'R-200',
  'DoPlaySound(3)': 'R-200',
  'DoPlaySound(2, true, false)': 'R-200',
  'DoPlaySound(2, false, true)': 'R-200',
  'DoPlaySound(2, true, true)': 'R-200',
  'DoPlaySound(99)': 'R-204',
  'DoPlayRandomSound()': 'R-200',
  'DoStopSound()': 'R-200',
  'DoTogglePause()': 'R-200',
  'DoToggleMute()': 'R-200',
  'DoStartRecording()': 'R-200',
  'DoStopRecording()': 'R-200',
  'DoJumpMs(5000)': 'R-200',
  'DoSeekMs(12000)': 'R-200',
  'SetVolume(30)': 'R-200',
  'SetVolume(70)': 'R-200',
  'SetVolume(100)': 'R-200',
  'SetVolume(0)': 'R-200',
};

function context(): ActionContext {
  return {
    variables: new VariableStore(),
    deckId: 'test',
    button: { id: 'b', key: 0 },
    location: { folderId: 'root', pageId: 'main' },
    profileId: 'p',
    openFolder: () => undefined,
    goToPage: () => undefined,
    goUp: () => undefined,
    goHome: () => undefined,
    goBack: () => undefined,
    setButtonState: () => undefined,
    setWidgetParam: () => undefined,
  } as unknown as ActionContext;
}

async function bench(options: { enabled?: boolean; inPieces?: boolean } = {}) {
  const soundpad = new FakeSoundpad({
    answers: ANSWERS,
    ...(options.inPieces === undefined ? {} : { inPieces: options.inPieces }),
  });
  const path = await soundpad.listen();

  const dir = await mkdtemp(join(tmpdir(), 'easydeck-sp-'));
  const settings = new PluginSettingsStore(undefined, join(dir, 'open'), join(dir, 'sealed'));
  await settings.save(
    SOUNDPAD_PLUGIN_ID,
    { enabled: options.enabled ?? true },
    soundpadManifest.settings ?? [],
  );

  const variables = new VariableStore();
  const registry = createActionRegistry();
  const runtime = new PluginRuntime({ settings, variables });
  runtime.on('error', () => undefined);

  await installForTest(soundpadManifest, activateWith({ pipe: path, retryDelaysMs: [40, 80] }), registry, runtime);

  return {
    soundpad,
    variables,
    runtime,
    watch: (...keys: string[]) => runtime.setWatched(keys),
    options: (name: string) => runtime.optionsFor(SOUNDPAD_PLUGIN_ID, name),
    run: (type: string, params: Record<string, unknown> = {}) =>
      registry.run({ type, params }, context()),
    value: (name: string) => variables.snapshot()[name],
    async until(what: string, holds: () => boolean, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (holds()) return;
        await delay(20);
      }
      assert.fail(`timed out waiting for ${what}`);
    },
    async dispose() {
      await runtime.stopAll();
      await soundpad.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('the Soundpad plugin', () => {
  it('connects and says so', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status(SOUNDPAD_PLUGIN_ID)?.status === 'ready');

    assert.equal(bed.value('ed.soundpad.connected'), true);
    await bed.dispose();
  });

  it('stays off until somebody turns it on', async () => {
    // A machine with no Soundpad on it should not have something knocking on a
    // pipe every half minute for ever.
    const bed = await bench({ enabled: false });
    await delay(120);

    assert.equal(bed.runtime.status(SOUNDPAD_PLUGIN_ID)?.status, 'off');
    assert.deepEqual(bed.soundpad.commands, [], 'nothing was asked of Soundpad');
    assert.equal(bed.value('ed.soundpad.connected'), false);

    await bed.dispose();
  });

  it('connects as soon as it is turned on, without a restart', async () => {
    const bed = await bench({ enabled: false });
    await delay(80);

    await bed.runtime.configure(SOUNDPAD_PLUGIN_ID, { enabled: true });
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    await bed.dispose();
  });

  it('plays the sound a key names, by looking up which row it is on', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    await bed.run('ed.soundpad.play', { sound: 'ba dum tss' });
    assert.ok(bed.soundpad.commands.includes('DoPlaySound(1)'));

    await bed.dispose();
  });

  it('plays the same sound after the list has been rearranged', async () => {
    /*
     * The whole reason a key holds a name. Soundpad's list is meant to be
     * dragged about, and a row number is a promise that breaks the moment
     * somebody does — silently, and into playing the wrong sound rather than
     * none, which is the worse of the two.
     */
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    await bed.run('ed.soundpad.play', { sound: 'Кофе & чай' });
    assert.ok(bed.soundpad.commands.includes('DoPlaySound(3)'));

    // The same three sounds, dragged into a different order.
    bed.soundpad.answers['GetSoundlist()'] = soundlist([
      { index: 1, title: 'Кофе & чай' },
      { index: 2, title: 'ba dum tss' },
      { index: 3, title: '', url: 'C:\\sounds\\firework.mp3' },
    ]);

    await bed.run('ed.soundpad.play', { sound: 'Кофе & чай' });
    assert.ok(bed.soundpad.commands.includes('DoPlaySound(1)'), 'it followed the sound, not the row');

    await bed.dispose();
  });

  it('still takes a plain row number, for anybody who wants one', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    await bed.run('ed.soundpad.play', { sound: '2' });
    assert.ok(bed.soundpad.commands.includes('DoPlaySound(2)'));
    assert.ok(
      !bed.soundpad.commands.includes('GetSoundlist()'),
      'a number needs no looking up',
    );

    await bed.dispose();
  });

  it('says so rather than playing something else when the name is gone', async () => {
    // A sound deleted from the list since the profile named it. A key that
    // quietly did nothing is the one failure a deck cannot afford.
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    assert.match(
      await refusal(() => bed.run('ed.soundpad.play', { sound: 'что-то удалённое' })),
      /no sound called/i,
    );

    /*
     * And a row number that is out of range, which is the one thing the number
     * path cannot check for itself: Soundpad answers `R-204` and that reaches
     * the caller.
     */
    assert.match(await refusal(() => bed.run('ed.soundpad.play', { sound: '99' })), /R-204/);

    await bed.dispose();
  });

  it('says nothing about the lines unless a key asked to', async () => {
    /*
     * Soundpad has "speakers and microphone" in its own window. The default is
     * the one-argument form, which leaves that setting alone; overriding it
     * silently would make Soundpad's own window a lie.
     */
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    await bed.run('ed.soundpad.play', { sound: 'firework.mp3', lines: '' });
    await bed.run('ed.soundpad.play', { sound: 'firework.mp3', lines: 'microphone' });
    await bed.run('ed.soundpad.play', { sound: 'firework.mp3', lines: 'speakers' });
    await bed.run('ed.soundpad.play', { sound: 'firework.mp3', lines: 'both' });

    assert.deepEqual(
      bed.soundpad.commands.filter((command) => command.startsWith('DoPlaySound')),
      [
        'DoPlaySound(2)',
        'DoPlaySound(2, false, true)',
        'DoPlaySound(2, true, false)',
        'DoPlaySound(2, true, true)',
      ],
    );

    await bed.dispose();
  });

  it('offers the sounds Soundpad has, held by name', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    const sounds = await bed.options('sounds');
    assert.deepEqual(
      sounds.map((option) => option.value),
      ['ba dum tss', 'firework.mp3', 'Кофе & чай'],
      'the name is what survives the list being rearranged',
    );
    assert.deepEqual(
      sounds.map((option) => option.label?.en),
      ['1. ba dum tss', '2. firework.mp3', '3. Кофе & чай'],
      'the number is still shown, for finding the row in Soundpad itself',
    );

    await bed.dispose();
  });

  it('reads a list that arrives in pieces', async () => {
    // Nothing frames these answers, so a document split across two writes is
    // the case the framing exists for — and the case a small list never shows.
    const bed = await bench({ inPieces: true });
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    const sounds = await bed.options('sounds');
    assert.equal(sounds.length, 3);

    await bed.dispose();
  });

  it('asks only for what a key is showing', async () => {
    /*
     * The point of the whole polling arrangement. Every value is a round trip
     * of its own, so a page showing the volume must not cost five questions a
     * beat for ever.
     */
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    bed.watch('ed.soundpad.volume');
    await bed.until('the volume', () => bed.value('ed.soundpad.volume') === 80);

    assert.equal(bed.value('ed.soundpad.status'), undefined, 'nobody asked what it was doing');
    assert.ok(!bed.soundpad.commands.includes('GetPlayStatus()'));
    assert.ok(!bed.soundpad.commands.includes('GetPlaybackPositionInMs()'));

    await bed.dispose();
  });

  it('publishes nothing at all while nothing is watched', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);
    await delay(150);

    const asked = bed.soundpad.commands.filter((command) => command.startsWith('Get'));
    assert.deepEqual(asked, [], 'a deck showing no Soundpad key asks it nothing');

    await bed.dispose();
  });

  it('turns what it reads into what a key can show', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    bed.watch(
      'ed.soundpad.status',
      'ed.soundpad.playing',
      'ed.soundpad.muted',
      'ed.soundpad.sound-count',
      'ed.soundpad.position',
      'ed.soundpad.duration',
    );

    await bed.until('the status', () => bed.value('ed.soundpad.status') === 'stopped');
    assert.equal(bed.value('ed.soundpad.playing'), false);
    assert.equal(bed.value('ed.soundpad.muted'), false);
    assert.equal(bed.value('ed.soundpad.sound-count'), 3);
    // Milliseconds are what Soundpad answers; a key shows minutes and seconds.
    assert.equal(bed.value('ed.soundpad.position'), '0:04');
    assert.equal(bed.value('ed.soundpad.duration'), '1:05');

    await bed.dispose();
  });

  it('clears what it knew when Soundpad goes away', async () => {
    /*
     * A key showing `80%` for a Soundpad that has been closed for an hour is
     * worse than a key showing nothing: it is the same picture as a Soundpad
     * that is running and set to eighty.
     */
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    bed.watch('ed.soundpad.volume');
    await bed.until('the volume', () => bed.value('ed.soundpad.volume') === 80);

    await bed.soundpad.close();
    await bed.until('the loss', () => bed.value('ed.soundpad.connected') === false);

    assert.equal(bed.value('ed.soundpad.volume'), undefined);
    await bed.dispose();
  });

  it('comes back on its own after Soundpad restarts', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    bed.soundpad.dropConnections();
    await bed.until('the loss', () => bed.value('ed.soundpad.connected') === false);
    await bed.until('the reconnection', () => bed.value('ed.soundpad.connected') === true, 5_000);

    await bed.dispose();
  });

  it('changes the volume against what it already is', async () => {
    // "Quieter" only means something against the current level, so the action
    // reads before it writes.
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    await bed.run('ed.soundpad.adjust-volume', { by: -10 });
    assert.ok(bed.soundpad.commands.includes('SetVolume(70)'));

    await bed.dispose();
  });

  it('keeps a volume inside the range Soundpad accepts', async () => {
    /*
     * Measured against the real thing: `SetVolume(abc)` answers `R-200` and
     * leaves the volume at zero. Soundpad accepts nonsense and reports success,
     * so the only place that can refuse it is here.
     *
     * A form cannot send an out-of-range number — the manifest declares the
     * bounds and the registry checks them before the handler runs. Adding to
     * the current level can, and does: eighty plus forty is not a volume.
     */
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    await bed.run('ed.soundpad.adjust-volume', { by: 40 });
    await bed.run('ed.soundpad.adjust-volume', { by: -100 });
    await bed.run('ed.soundpad.set-volume', { percent: 30.4 });

    assert.deepEqual(
      bed.soundpad.commands.filter((command) => command.startsWith('SetVolume')),
      ['SetVolume(100)', 'SetVolume(0)', 'SetVolume(30)'],
    );

    await bed.dispose();
  });

  it('seeks to a place and by an amount, which are different commands', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    await bed.run('ed.soundpad.seek', { how: 'by', seconds: 5 });
    await bed.run('ed.soundpad.seek', { how: 'to', seconds: 12 });

    assert.ok(bed.soundpad.commands.includes('DoJumpMs(5000)'));
    assert.ok(bed.soundpad.commands.includes('DoSeekMs(12000)'));

    await bed.dispose();
  });

  it('starts and stops recording, and never claims to know which', async () => {
    // Soundpad has no `IsRecording`, so this offers the two orders and
    // publishes no state — a variable for it would be a guess.
    const bed = await bench();
    await bed.until('a connection', () => bed.value('ed.soundpad.connected') === true);

    await bed.run('ed.soundpad.record', { do: 'start' });
    await bed.run('ed.soundpad.record', { do: 'stop' });

    assert.ok(bed.soundpad.commands.includes('DoStartRecording()'));
    assert.ok(bed.soundpad.commands.includes('DoStopRecording()'));
    assert.ok(
      !(soundpadManifest.variables ?? []).some((variable) => variable.name.includes('record')),
      'nothing here reports whether it is recording',
    );

    await bed.dispose();
  });

  it('refuses to act at all while Soundpad is closed', async () => {
    // Rather than swallowing it: the key shows a warning, which is the only
    // way anybody finds out that the soundboard is not running.
    const bed = await bench({ enabled: false });
    await delay(80);

    assert.match(await refusal(() => bed.run('ed.soundpad.stop')), /not connected/i);
    await bed.dispose();
  });
});

describe('reading what Soundpad says', () => {
  it('knows a whole answer from half of one', () => {
    assert.equal(isComplete('R-200'), true);
    assert.equal(isComplete('80'), true);
    assert.equal(isComplete('STOPPED'), true);

    const list = soundlist([{ index: 1, title: 'one' }]);
    assert.equal(isComplete(list), true);
    assert.equal(isComplete(list.slice(0, list.length - 20)), false);

    // A document with nothing in it is already finished.
    assert.equal(isComplete('<?xml version="1.0"?>\n<Categories/>'), true);
  });

  it('finds a row by its title, its tag or its file', () => {
    const list = soundlist([
      { index: 1, title: 'Fanfare', tag: 'победа' },
      { index: 2, title: '', url: 'D:\\audio\\airhorn.mp3' },
    ]);

    assert.equal(findSound(list, 'Fanfare'), 1);
    assert.equal(findSound(list, 'победа'), 1, 'the tag Soundpad searches by');
    assert.equal(findSound(list, 'airhorn.mp3'), 2);
    // A name typed by hand rarely matches the capitals of a downloaded file.
    assert.equal(findSound(list, 'fanfare'), 1);
    assert.equal(findSound(list, 'AIRHORN.MP3'), 2);
    assert.equal(findSound(list, 'nothing like it'), undefined);
  });

  it('prefers a title to a tag, and the lowest row where several match', () => {
    /*
     * Titles are not unique — two copies of the same file are an ordinary
     * thing to have — so "whichever" is not an answer. The first row is at
     * least the same answer every time.
     */
    const list = soundlist([
      { index: 1, title: 'Applause', tag: 'Horn' },
      { index: 2, title: 'Horn', tag: 'brass' },
      { index: 3, title: 'Horn', tag: 'brass' },
    ]);

    assert.equal(findSound(list, 'Horn'), 2, 'the one titled that, not the one tagged that');

    const twice = soundlist([
      { index: 4, title: 'Boo' },
      { index: 7, title: 'Boo' },
    ]);
    assert.equal(findSound(twice, 'Boo'), 4);
  });

  it('falls back to the file name where Soundpad has no title for a row', () => {
    // Soundpad leaves the title empty for a file with no tags, and a list of
    // blank rows is no list at all.
    const options = soundOptions(
      soundlist([
        { index: 1, title: 'ba dum tss' },
        { index: 2, title: '', url: 'C:\\sounds\\firework.mp3' },
      ]),
    );

    assert.deepEqual(
      options.map((option) => option.label?.en),
      ['1. ba dum tss', '2. firework.mp3'],
    );
  });

  it('puts the characters back that XML took away', () => {
    const options = soundOptions(
      '<?xml version="1.0"?><Soundlist><Sound index="7" title="Кофе &amp; чай"/></Soundlist>',
    );

    assert.equal(options[0]?.label?.en, '7. Кофе & чай');
  });
});
