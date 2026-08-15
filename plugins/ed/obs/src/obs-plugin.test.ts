import assert from 'node:assert/strict';
import { PluginRuntime, PluginSettingsStore, installForTest } from '../../../../testing/core.js';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { VariableStore, createActionRegistry } from '@easydeck/engine';
import type { ActionContext } from '@easydeck/engine';

import { FakeObs } from './fake-obs.js';
import { activateWith, obsManifest } from './obs-plugin.js';

/** Everything a connected OBS answers when the plugin first reads its state. */
const STATE = {
  GetSceneList: {
    currentProgramSceneName: 'Intro',
    scenes: [{ sceneName: 'Ending' }, { sceneName: 'Game' }, { sceneName: 'Intro' }],
  },
  GetStreamStatus: { outputActive: false },
  GetRecordStatus: { outputActive: false, outputPaused: false },
  GetReplayBufferStatus: { outputActive: true },
  GetVirtualCamStatus: { outputActive: false },
  SetCurrentProgramScene: {},
  ToggleStream: {},
  ToggleRecord: {},
  GetInputList: {
    inputs: [
      { inputName: 'Mic', inputKind: 'wasapi_input_capture' },
      { inputName: 'Desktop', inputKind: 'wasapi_output_capture' },
      // Both have sound and neither is an audio device: the pair this list
      // used to leave out, because it went by kind.
      { inputName: 'Заставка', inputKind: 'ffmpeg_source' },
      { inputName: 'Чат', inputKind: 'browser_source' },
      { inputName: 'Логотип', inputKind: 'image_source' },
    ],
  },
  GetInputAudioTracks: { inputAudioTracks: { '1': true } },
  GetSourceScreenshot: { imageData: 'data:image/jpg;base64,AAAA' },
  ToggleInputMute: {},
  GetSourceFilterList: { filters: [{ filterName: 'Noise gate' }, { filterName: 'Colour' }] },
  GetSourceFilter: { filterEnabled: true },
  SetSourceFilterEnabled: {},
  GetInputVolume: { inputVolumeDb: -6 },
  SetInputVolume: {},
  GetInputMute: { inputMuted: true },
  GetInputAudioMonitorType: { monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY' },
  SetInputAudioMonitorType: {},
  GetSceneItemId: { sceneItemId: 7 },
  GetSceneItemEnabled: { sceneItemEnabled: true },
  GetCurrentSceneTransition: { transitionName: 'Fade', transitionDuration: 300 },
};

/** Everything an action is handed, of which OBS actions use only the first. */
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
  };
}

/** A runtime with the plugin installed, pointed at a fake OBS on a free port. */
async function bench(
  options: { password?: string; serverPassword?: string; enabled?: boolean } = {},
) {
  const obs = new FakeObs({
    ...(options.serverPassword === undefined ? {} : { password: options.serverPassword }),
    responses: STATE,
  });
  const port = await obs.listen();

  const dir = `${process.env['TEMP'] ?? '/tmp'}/easydeck-obs-${port}`;
  const settings = new PluginSettingsStore(undefined, `${dir}/open`, `${dir}/sealed`);
  await settings.save(
    'ed.obs',
    {
      enabled: options.enabled ?? true,
      host: '127.0.0.1',
      port,
      password: options.password ?? '',
    },
    obsManifest.settings ?? [],
  );

  const variables = new VariableStore();
  const registry = createActionRegistry();
  const runtime = new PluginRuntime({ settings, variables });
  runtime.on('error', () => undefined);

  await installForTest(obsManifest, activateWith({ retryDelaysMs: [50, 100] }), registry, runtime);

  return {
    obs,
    variables,
    registry,
    runtime,
    /** Waits until the condition holds, or gives up loudly. */
    async until(what: string, holds: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await holds()) return;
        await delay(20);
      }
      assert.fail(`timed out waiting for ${what}`);
    },
    async dispose() {
      await runtime.stopAll();
      await obs.close();
    },
  };
}

describe('the OBS plugin', () => {
  it('connects, authenticates and reads the state it will show', async () => {
    const bed = await bench({ password: 'hunter2', serverPassword: 'hunter2' });
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    assert.equal(bed.variables.get('ed.obs.connected'), true);
    await bed.until('the scene', () => bed.variables.get('ed.obs.scene') === 'Intro');
    assert.equal(bed.variables.get('ed.obs.streaming'), false);
    assert.equal(bed.variables.get('ed.obs.replay-buffer'), true);

    await bed.dispose();
  });

  it('stays off until somebody turns it on', async () => {
    // A machine with no OBS on it should not have something knocking on port
    // 4455 every half minute for ever, and a plugin that connects the moment
    // it is installed fails before anybody has configured it.
    const bed = await bench({ enabled: false });
    await delay(120);

    assert.equal(bed.runtime.status('ed.obs')?.status, 'off');
    assert.equal(bed.obs.requests.length, 0, 'nothing was asked of OBS');
    assert.equal(bed.variables.get('ed.obs.connected'), false);

    await bed.dispose();
  });

  it('connects as soon as it is turned on, without a restart', async () => {
    const bed = await bench({ enabled: false });
    await delay(80);
    assert.equal(bed.runtime.status('ed.obs')?.status, 'off');

    await bed.runtime.configure('ed.obs', { enabled: true });

    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');
    await bed.dispose();
  });

  it('says so, in words, when the password is wrong', async () => {
    // The one failure a user can fix, so it must not read as "OBS is broken".
    const bed = await bench({ password: 'wrong', serverPassword: 'hunter2' });
    await bed.until('a failure', () => bed.runtime.status('ed.obs')?.status === 'error');

    assert.equal(bed.variables.get('ed.obs.connected'), false);
    await bed.dispose();
  });

  it('follows what OBS reports, whoever caused it', async () => {
    // The whole point of events over polling: pressing Record in OBS's own
    // window has to light the key on the desk.
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.obs.emit('RecordStateChanged', { outputActive: true });
    await bed.until('the recording flag', () => bed.variables.get('ed.obs.recording') === true);

    bed.obs.emit('CurrentProgramSceneChanged', { sceneName: 'Game' });
    await bed.until('the scene', () => bed.variables.get('ed.obs.scene') === 'Game');

    bed.obs.emit('StreamStateChanged', { outputActive: true });
    await bed.until('the streaming flag', () => bed.variables.get('ed.obs.streaming') === true);

    await bed.dispose();
  });

  it('clears the pause when the recording stops', async () => {
    // OBS sends no separate event for it, and a key left saying "paused"
    // after the recording ended is a key telling a lie.
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.obs.emit('RecordStateChanged', { outputActive: true });
    bed.obs.emit('RecordStateChangedPaused', { outputPaused: true });
    await bed.until('the pause', () => bed.variables.get('ed.obs.recording-paused') === true);

    bed.obs.emit('RecordStateChanged', { outputActive: false });
    await bed.until('the pause clearing', () => bed.variables.get('ed.obs.recording-paused') === false);

    await bed.dispose();
  });

  it('runs an action against OBS', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    await bed.registry.run(
      { type: 'ed.obs.set-scene', params: { scene: 'Game' } },
      context(bed.variables),
    );

    const sent = bed.obs.requests.find((request) => request.type === 'SetCurrentProgramScene');
    assert.deepEqual(sent?.data, { sceneName: 'Game' });

    await bed.dispose();
  });

  it('refuses an action while OBS is not there, rather than doing nothing', async () => {
    // A key that silently did nothing is the failure this plugin exists to
    // avoid; a rejected action puts a warning on the key.
    const bed = await bench();
    await bed.obs.close();
    await bed.until('the loss', () => bed.runtime.status('ed.obs')?.status !== 'ready');

    await assert.rejects(
      bed.registry.run({ type: 'ed.obs.toggle-stream' }, context(bed.variables)),
      (error: Error) => {
        // The engine wraps a failed action and keeps the reason as its cause,
        // which is what the configurator unwraps to show on the key.
        assert.match(String((error.cause as Error)?.message), /OBS/);
        return true;
      },
    );

    await bed.runtime.stopAll();
  });

  it('clears what it published when the connection goes', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');
    bed.obs.emit('CurrentProgramSceneChanged', { sceneName: 'Game' });
    await bed.until('the scene', () => bed.variables.get('ed.obs.scene') === 'Game');

    bed.obs.dropConnections();

    await bed.until('the scene clearing', () => bed.variables.get('ed.obs.scene') === '');
    assert.equal(bed.variables.get('ed.obs.connected'), false);

    await bed.dispose();
  });

  it('comes back on its own after OBS restarts', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.obs.dropConnections();
    await bed.until('the loss', () => bed.runtime.status('ed.obs')?.status !== 'ready');

    await bed.until('the reconnection', () => bed.runtime.status('ed.obs')?.status === 'ready', 5_000);
    assert.equal(bed.variables.get('ed.obs.scene'), 'Intro');

    await bed.dispose();
  });

  it('offers the scenes OBS has, newest last as a person would list them', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    const scenes = await bed.runtime.optionsFor('ed.obs', 'scenes');
    assert.deepEqual(
      scenes.map((option) => option.value),
      ['Intro', 'Game', 'Ending'],
    );

    await bed.dispose();
  });

  it('offers everything OBS will let you mute, whatever kind of source it is', async () => {
    /*
     * The list went by input kind, so it held the audio devices and nothing
     * else. A media source and a browser source both sit in OBS's own mixer
     * and were missing from every mute, volume and monitoring field — and from
     * `obs.mute(…)`, which offers the same list.
     */
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.obs.silent.add('Логотип');

    const audio = await bed.runtime.optionsFor('ed.obs', 'audio-inputs');
    assert.deepEqual(
      audio.map((option) => option.value),
      ['Mic', 'Desktop', 'Заставка', 'Чат'],
      'a picture is not something to mute; the media and the browser are',
    );

    await bed.dispose();
  });

  it('offers the filters of the source that was picked, and none before one is', async () => {
    // The list depends on another parameter, which is why the loader is given
    // what has been filled in so far. Asked with nothing chosen, it has
    // nothing to say — and must not answer with every filter in OBS.
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    assert.deepEqual(await bed.runtime.optionsFor('ed.obs', 'filters', {}), []);

    const filters = await bed.runtime.optionsFor('ed.obs', 'filters', { source: 'Webcam' });
    assert.deepEqual(
      filters.map((option) => option.value),
      ['Noise gate', 'Colour'],
    );

    const asked = bed.obs.requests.find((request) => request.type === 'GetSourceFilterList');
    assert.deepEqual(asked?.data, { sourceName: 'Webcam' });

    await bed.dispose();
  });

  it('changes a volume relative to what it already is', async () => {
    // "Quieter" only means something against the current level, so the action
    // reads before it writes.
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    await bed.registry.run(
      { type: 'ed.obs.adjust-volume', params: { input: 'Mic', db: -4 } },
      context(bed.variables),
    );

    const sent = bed.obs.requests.find((request) => request.type === 'SetInputVolume');
    assert.deepEqual(sent?.data, { inputName: 'Mic', inputVolumeDb: -10 });

    await bed.dispose();
  });

  it('toggles a filter, whichever kind OBS considers it', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    await bed.registry.run(
      { type: 'ed.obs.toggle-filter', params: { source: 'Webcam', filter: 'Noise gate' } },
      context(bed.variables),
    );

    const sent = bed.obs.requests.find((request) => request.type === 'SetSourceFilterEnabled');
    assert.deepEqual(sent?.data, {
      sourceName: 'Webcam',
      filterName: 'Noise gate',
      filterEnabled: false,
    });

    await bed.dispose();
  });

  it('knows while a transition is running', async () => {
    // Both edges come from OBS, so this is known rather than timed — a
    // transition can be cut short, and a key counting down would go on
    // claiming it was running.
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    assert.equal(bed.variables.get('ed.obs.transition-name'), 'Fade');
    assert.equal(bed.variables.get('ed.obs.transition-duration'), 300);
    assert.equal(bed.variables.get('ed.obs.transitioning'), false);

    bed.obs.emit('SceneTransitionStarted', { transitionName: 'Stinger' });
    await bed.until('the start', () => bed.variables.get('ed.obs.transitioning') === true);
    assert.equal(bed.variables.get('ed.obs.transition-name'), 'Stinger');

    bed.obs.emit('SceneTransitionEnded', { transitionName: 'Stinger' });
    await bed.until('the end', () => bed.variables.get('ed.obs.transitioning') === false);

    await bed.dispose();
  });

  it('reads only the family keys a profile actually uses', async () => {
    // The whole point of families: OBS may have fifty inputs, and a deck
    // showing one microphone should cost one question, not fifty.
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.obs.requests.length = 0;
    bed.runtime.setWatched(['ed.obs.mute(Mic)', 'ed.obs.volume(Mic)', 'hardware.cpu']);
    await bed.until('the mute', () => bed.variables.get('ed.obs.mute(Mic)') === true);

    assert.equal(bed.variables.get('ed.obs.volume(Mic)'), -6);
    assert.equal(
      bed.obs.requests.filter((request) => request.type === 'GetInputMute').length,
      1,
      'one question about the one input a profile reads',
    );
    assert.equal(
      bed.variables.has('ed.obs.mute(Desktop)'),
      false,
      'nothing was published about an input nobody reads',
    );

    await bed.dispose();
  });

  it('follows the mixer by event, and only for what is watched', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');
    bed.runtime.setWatched(['ed.obs.mute(Mic)']);
    await bed.until('the first read', () => bed.variables.get('ed.obs.mute(Mic)') === true);

    bed.obs.emit('InputMuteStateChanged', { inputName: 'Mic', inputMuted: false });
    await bed.until('the change', () => bed.variables.get('ed.obs.mute(Mic)') === false);

    bed.obs.emit('InputMuteStateChanged', { inputName: 'Desktop', inputMuted: true });
    await delay(60);
    assert.equal(bed.variables.has('ed.obs.mute(Desktop)'), false, 'still nobody reads it');

    await bed.dispose();
  });

  it('reads a pair, where the key names two things', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.runtime.setWatched(['ed.obs.visible(Game, Webcam)']);
    await bed.until('the visibility', () => bed.variables.get('ed.obs.visible(Game, Webcam)') === true);

    const asked = bed.obs.requests.find((request) => request.type === 'GetSceneItemId');
    assert.deepEqual(asked?.data, { sceneName: 'Game', sourceName: 'Webcam' });

    await bed.dispose();
  });

  it('clears a key whose source has gone, rather than leaving it stale', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.runtime.setWatched(['ed.obs.mute(Mic)']);
    await bed.until('the mute', () => bed.variables.get('ed.obs.mute(Mic)') === true);

    // A source that is not there any more, which OBS answers with a refusal
    // rather than a value.
    bed.obs.unknown.add('Ghost');
    bed.runtime.setWatched(['ed.obs.filter(Ghost, Gate)']);
    await delay(120);

    assert.equal(bed.variables.has('ed.obs.filter(Ghost, Gate)'), false);
    await bed.dispose();
  });

  it('photographs only what a key on screen is showing, and only when due', async () => {
    /*
     * A surface is asked for on every repaint, and a repaint happens whenever
     * anything at all moves — so a thumbnail drawn straight from OBS would take
     * a screenshot every time a clock ticked elsewhere on the page. The picture
     * is kept and refreshed on its own beat, and this is that beat.
     */
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    const shots = () => bed.obs.requests.filter((request) => request.type === 'GetSourceScreenshot');
    assert.equal(shots().length, 0, 'nothing on screen, nothing photographed');

    bed.runtime.setWidgets([
      { buttonId: 'b1', type: 'ed.obs.thumbnail', params: { source: 'Game', every: '1' } },
    ]);

    await bed.until('the first picture', () => shots().length === 1);
    assert.deepEqual(shots()[0]?.data?.['sourceName'], 'Game');

    // The key is still there, but a second has not passed.
    await delay(120);
    assert.equal(shots().length, 1, 'not due yet');

    await bed.dispose();
  });

  it('follows the switch when a key shows whatever is on air', async () => {
    // A key showing the live scene must not name one, or it stops being about
    // the live scene the moment somebody switches.
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.runtime.setWidgets([
      { buttonId: 'b1', type: 'ed.obs.thumbnail', params: { source: '@program', every: '1' } },
    ]);

    await bed.until(
      'a picture of the live scene',
      () =>
        bed.obs.requests.some(
          (request) => request.type === 'GetSourceScreenshot' && request.data['sourceName'] === 'Intro',
        ),
    );

    await bed.dispose();
  });

  it('hands the same picture over as often as it is asked for', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.runtime.setWidgets([
      { buttonId: 'b1', type: 'ed.obs.thumbnail', params: { source: 'Game', every: '60' } },
    ]);
    await bed.until('the first picture', () =>
      bed.obs.requests.some((request) => request.type === 'GetSourceScreenshot'),
    );

    const request = { type: 'ed.obs.thumbnail', params: { source: 'Game' }, cols: 1, rows: 1, buttons: ['b1'] };
    const first = await bed.runtime.drawSurface(request);
    const second = await bed.runtime.drawSurface(request);

    assert.equal(first?.source, 'data:image/jpg;base64,AAAA');
    assert.equal(second?.source, first?.source);
    assert.equal(
      bed.obs.requests.filter((each) => each.type === 'GetSourceScreenshot').length,
      1,
      'drawing twice is not photographing twice',
    );

    await bed.dispose();
  });

  it('offers what can be photographed, the standing answers first', async () => {
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    const options = await bed.runtime.optionsFor('ed.obs', 'shootable');
    assert.deepEqual(options.slice(0, 2).map((option) => option.value), ['@program', '@preview']);
    // Scenes as a person lists them, then the sources.
    assert.deepEqual(
      options.slice(2).map((option) => option.value),
      ['Intro', 'Game', 'Ending', 'Mic', 'Desktop', 'Заставка', 'Чат', 'Логотип'],
    );

    await bed.dispose();
  });

  it('asks for levels only while a meter is on a page, and holds the peak', async () => {
    /*
     * Twenty events a second carrying every input is exactly the flood the
     * ordinary subscription set leaves out, so it is asked for when a meter
     * appears and dropped when the page turns. And what reaches the key is the
     * loudest moment of the half-second, not the latest sample — a clap
     * between two samples is what a meter is for.
     */
    const bed = await bench();
    await bed.until('a connection', () => bed.runtime.status('ed.obs')?.status === 'ready');

    bed.runtime.setWidgets([
      {
        buttonId: 'b1',
        type: 'ed.obs.meter',
        // No trough, so what is measured below is the level and nothing else.
        params: { inputs: 'Mic\nDesktop', direction: 'bottom', thickness: 100, track: '' },
      },
    ]);

    // Loud, then quiet, inside one publishing interval. The desktop stays
    // silent throughout, so the two bars must not come out alike.
    bed.obs.emit('InputVolumeMeters', {
      inputs: [
        { inputName: 'Mic', inputLevelsMul: [[0, 0, 0.7]] },
        { inputName: 'Desktop', inputLevelsMul: [[0, 0, 0]] },
      ],
    });
    bed.obs.emit('InputVolumeMeters', {
      inputs: [{ inputName: 'Mic', inputLevelsMul: [[0, 0, 0.001]] }],
    });

    const drawn = async (): Promise<string> => {
      const frame = await bed.runtime.drawSurface({
        type: 'ed.obs.meter',
        // No trough, so what is measured below is the level and nothing else.
        params: { inputs: 'Mic\nDesktop', direction: 'bottom', thickness: 100, track: '' },
        cols: 1,
        rows: 1,
        buttons: ['b1'],
      });
      const source = String(frame?.source ?? '');
      return Buffer.from(source.split(',')[1] ?? '', 'base64').toString('utf8');
    };

    await bed.until('a level', async () => (await drawn()).includes('<rect'), 3_000);

    const svg = await drawn();
    const lit = [...svg.matchAll(/<rect [^>]*width="([\d.]+)"/g)].reduce(
      (total, match) => total + Number(match[1]),
      0,
    );

    // 0.7 of full scale is about −3 dB, which is most of one bar. The 0.001
    // that arrived after it is silence and would have drawn nothing, and the
    // desktop was silent all along — so this is one bar's worth, not two.
    assert.ok(lit > 80 && lit <= 100, `the loud moment survived, alone (${lit})`);

    await bed.dispose();
  });

  it('answers with an empty list when OBS is closed, so a key can still be set up', async () => {
    const bed = await bench();
    await bed.obs.close();
    await bed.until('the loss', () => bed.runtime.status('ed.obs')?.status !== 'ready');

    assert.deepEqual(await bed.runtime.optionsFor('ed.obs', 'scenes'), []);
    await bed.runtime.stopAll();
  });
});
