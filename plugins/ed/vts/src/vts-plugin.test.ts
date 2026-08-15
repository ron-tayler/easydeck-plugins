import assert from 'node:assert/strict';
import { PluginRuntime, PluginSettingsStore, installForTest } from '../../../../testing/core.js';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, it } from 'node:test';

import { VariableStore, createActionRegistry } from '@easydeck/engine';
import type { ActionContext } from '@easydeck/engine';

import { FakeVts } from './fake-vts.js';
import { activateWith, vtsManifest } from './vts-plugin.js';

const TOKEN = 'granted-token';

/** What a connected VTube Studio answers while the model is loaded. */
const STATE = {
  CurrentModelRequest: { modelLoaded: true, modelName: 'Аканэ', modelID: 'model-1' },
  ExpressionStateRequest: {
    modelLoaded: true,
    expressions: [
      { name: 'Смущение', file: 'blush.exp3.json', active: false },
      { name: 'Злость', file: 'angry.exp3.json', active: true },
    ],
  },
  HotkeysInCurrentModelRequest: {
    modelLoaded: true,
    availableHotkeys: [
      { name: 'Помахать', type: 'TriggerAnimation', hotkeyID: 'hk-1' },
      { name: '', type: 'ToggleExpression', hotkeyID: 'hk-2' },
    ],
  },
  AvailableModelsRequest: {
    numberOfModels: 2,
    availableModels: [
      { modelName: 'Аканэ', modelID: 'model-1', modelLoaded: true },
      { modelName: 'Котик', modelID: 'model-2', modelLoaded: false },
    ],
  },
  HotkeyTriggerRequest: { hotkeyID: 'hk-1' },
  ExpressionActivationRequest: {},
  ModelLoadRequest: { modelID: 'model-2' },
};

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

/**
 * Every bench built, closed at the end whatever happened.
 *
 * A test that fails before its own `dispose` would otherwise leave a listening
 * socket behind, and node's runner waits for the handle rather than exiting —
 * so one failed assertion turns into a run that hangs and prints nothing.
 */
const benches: Array<() => Promise<void>> = [];

after(async () => {
  for (const close of benches) await close();
  benches.length = 0;
});

/** A runtime with the plugin installed, pointed at a fake VTS on a free port. */
async function bench(options: { token?: string; stored?: string; enabled?: boolean } = {}) {
  const vts = new FakeVts({
    ...(options.token === undefined ? {} : { token: options.token }),
    responses: STATE,
  });
  const port = await vts.listen();

  const dir = `${process.env['TEMP'] ?? '/tmp'}/easydeck-vts-${port}`;
  const settings = new PluginSettingsStore(undefined, `${dir}/open`, `${dir}/sealed`);
  await settings.save(
    'ed.vts',
    {
      enabled: options.enabled ?? true,
      host: '127.0.0.1',
      port,
      token: options.stored ?? '',
    },
    vtsManifest.settings ?? [],
  );

  const variables = new VariableStore();
  const registry = createActionRegistry();
  const runtime = new PluginRuntime({ settings, variables });
  runtime.on('error', () => undefined);

  await installForTest(vtsManifest, activateWith({ retryDelaysMs: [50, 100] }), registry, runtime);

  let closed = false;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    await runtime.stopAll();
    await vts.close();
    // Retried: a settings write started on the way down may still have the
    // folder open on Windows, and a failed cleanup should not fail a run.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(
      () => undefined,
    );
  };
  benches.push(dispose);

  return {
    vts,
    variables,
    registry,
    runtime,
    settings,
    async until(what: string, holds: () => boolean, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (holds()) return;
        await delay(20);
      }
      assert.fail(`timed out waiting for ${what}`);
    },
    /** The socket is up and the plugin is waiting to be authorised. */
    async waitUnauthorised() {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const state = runtime.status('ed.vts');
        if (state?.status === 'error' && /authoris/i.test(state.message?.en ?? '')) return;
        await delay(20);
      }
      assert.fail('timed out waiting for the plugin to report it needs authorising');
    },
    dispose,
  };
}

describe('the VTube Studio plugin', () => {
  it('stays off until somebody turns it on', async () => {
    const bed = await bench({ enabled: false });

    assert.equal(bed.runtime.status('ed.vts')?.status, 'off');
    assert.equal(bed.vts.requests.length, 0, 'nothing may be sent to a plugin nobody enabled');

    await bed.dispose();
  });

  it('waits to be authorised rather than throwing a dialog at whoever is live', async () => {
    /*
     * The one thing this plugin must not do on its own. Asking for a token
     * makes VTube Studio put a window in front of the streamer, and doing that
     * on connect — or worse, on every reconnect — is exactly the behaviour
     * that gets a plugin uninstalled.
     */
    const bed = await bench({ token: TOKEN });

    await bed.until('the plugin to report it needs authorising', () => {
      const state = bed.runtime.status('ed.vts');
      return state?.status === 'error' && /authoris/i.test(state.message?.en ?? '');
    });

    assert.equal(
      bed.vts.requests.some((request) => request.type === 'AuthenticationTokenRequest'),
      false,
    );

    await bed.dispose();
  });

  it('authorises when asked, keeps the token, and connects with it', async () => {
    const bed = await bench({ token: TOKEN });
    await bed.waitUnauthorised();

    await bed.runtime.runCommand('ed.vts', 'authorise');

    // The state arrives after the session, not with it: waiting on the status
    // alone would read the variables while they were still being fetched.
    await bed.until('the model to be read', () => bed.variables.get('ed.vts.model') === 'Аканэ');
    assert.equal(bed.variables.get('ed.vts.connected'), true);

    // Kept where every other secret is kept, so the next start is silent.
    assert.deepEqual(await bed.settings.filledSecrets('ed.vts'), ['token']);
    assert.equal((await bed.settings.load('ed.vts'))['token'], TOKEN);

    await bed.dispose();
  });

  it('connects without a word when the token is already stored', async () => {
    const bed = await bench({ token: TOKEN, stored: TOKEN });
    await bed.until('a session', () => bed.runtime.status('ed.vts')?.status === 'ready');

    assert.equal(
      bed.vts.requests.some((request) => request.type === 'AuthenticationTokenRequest'),
      false,
      'a stored token must not put a dialog in front of anybody',
    );

    await bed.dispose();
  });

  it('says so when the user presses Deny', async () => {
    // No token configured on the fake: its answer to a token request is the
    // refusal a real one sends when somebody presses Deny.
    const bed = await bench();
    await bed.waitUnauthorised();

    await assert.rejects(bed.runtime.runCommand('ed.vts', 'authorise'), /denied|refused/i);
    assert.equal(bed.runtime.status('ed.vts')?.status, 'error');

    await bed.dispose();
  });

  it('refuses a token VTube Studio no longer recognises, in words', async () => {
    const bed = await bench({ token: TOKEN, stored: 'stale-token' });

    await bed.until('a complaint about the token', () => {
      const state = bed.runtime.status('ed.vts');
      return state?.status === 'error' && /token/i.test(state.message?.en ?? '');
    });

    await bed.dispose();
  });
});

describe('what the VTube Studio plugin offers and does', () => {
  it('offers the hotkeys, expressions and models it can see', async () => {
    const bed = await bench({ token: TOKEN, stored: TOKEN });
    await bed.until('a session', () => bed.runtime.status('ed.vts')?.status === 'ready');

    const hotkeys = await bed.runtime.optionsFor('ed.vts', 'hotkeys', {});
    const expressions = await bed.runtime.optionsFor('ed.vts', 'expressions', {});
    const models = await bed.runtime.optionsFor('ed.vts', 'models', {});

    // The id is stored, the name is shown: a hotkey renamed in VTube Studio
    // keeps working, which is not true the other way round.
    assert.deepEqual(hotkeys.map((option) => option.value), ['hk-1', 'hk-2']);
    assert.equal(hotkeys[0]?.label.en, 'Помахать');
    assert.equal(hotkeys[1]?.label.en, 'ToggleExpression', 'an unnamed hotkey still needs a label');

    assert.deepEqual(expressions.map((option) => option.value), ['blush.exp3.json', 'angry.exp3.json']);
    assert.deepEqual(models.map((option) => option.label.en), ['Аканэ', 'Котик']);

    await bed.dispose();
  });

  it('answers with an empty list when VTube Studio is closed, so a key can still be set up', async () => {
    const bed = await bench({ enabled: false });
    assert.deepEqual(await bed.runtime.optionsFor('ed.vts', 'hotkeys', {}), []);
    await bed.dispose();
  });

  it('triggers a hotkey and loads a model', async () => {
    const bed = await bench({ token: TOKEN, stored: TOKEN });
    await bed.until('a session', () => bed.runtime.status('ed.vts')?.status === 'ready');

    await bed.registry.run(
      { type: 'ed.vts.trigger-hotkey', params: { hotkey: 'hk-1' } },
      context(bed.variables),
    );
    await bed.registry.run(
      { type: 'ed.vts.load-model', params: { model: 'model-2' } },
      context(bed.variables),
    );

    const sent = bed.vts.requests.filter((request) => request.type === 'HotkeyTriggerRequest');
    assert.deepEqual(sent[0]?.data, { hotkeyID: 'hk-1' });
    assert.deepEqual(
      bed.vts.requests.find((request) => request.type === 'ModelLoadRequest')?.data,
      { modelID: 'model-2' },
    );

    await bed.dispose();
  });

  it('refuses an action while VTube Studio is not there, rather than doing nothing', async () => {
    const bed = await bench({ enabled: false });

    await assert.rejects(
      bed.registry.run({ type: 'ed.vts.trigger-hotkey', params: { hotkey: 'hk-1' } }, context(bed.variables)),
      (error: Error) => {
        // The engine wraps a failed action and keeps the reason as its cause,
        // which is what the configurator unwraps to show on the key.
        assert.match(String((error.cause as Error)?.message), /VTube Studio/);
        return true;
      },
    );

    await bed.dispose();
  });

  it('toggles an expression against what it is now, not against what a key thinks', async () => {
    // `angry` is active in the fake's state, so toggling it must turn it off.
    const bed = await bench({ token: TOKEN, stored: TOKEN });
    await bed.until('a session', () => bed.runtime.status('ed.vts')?.status === 'ready');

    await bed.registry.run(
      { type: 'ed.vts.set-expression', params: { expression: 'angry.exp3.json', mode: 'toggle' } },
      context(bed.variables),
    );

    const sent = bed.vts.requests.find((request) => request.type === 'ExpressionActivationRequest');
    assert.equal(sent?.data['expressionFile'], 'angry.exp3.json');
    assert.equal(sent?.data['active'], false);

    await bed.dispose();
  });

  it('reads only the expressions a profile actually uses', async () => {
    /*
     * A model may have dozens, and publishing every one of them would mean
     * keeping values current that nothing shows. The watched keys are what
     * decides, exactly as with OBS.
     */
    const bed = await bench({ token: TOKEN, stored: TOKEN });
    await bed.until('a session', () => bed.runtime.status('ed.vts')?.status === 'ready');

    bed.runtime.setWatched(['ed.vts.expression(angry.exp3.json)']);
    await bed.until('the watched expression', () => bed.variables.get('ed.vts.expression(angry.exp3.json)') === true);

    assert.equal(bed.variables.get('ed.vts.expression(blush.exp3.json)'), undefined);

    await bed.dispose();
  });

  it('follows the model changing under it, whoever caused it', async () => {
    const bed = await bench({ token: TOKEN, stored: TOKEN });
    await bed.until('a session', () => bed.runtime.status('ed.vts')?.status === 'ready');

    bed.vts.emit('ModelLoadedEvent', { modelLoaded: true, modelName: 'Котик', modelID: 'model-2' });
    await bed.until('the new model', () => bed.variables.get('ed.vts.model') === 'Котик');

    bed.vts.emit('TrackingStatusChangedEvent', { faceFound: true });
    await bed.until('tracking', () => bed.variables.get('ed.vts.tracking') === true);

    await bed.dispose();
  });

  it('notices an expression a hotkey turned on, whoever pressed it', async () => {
    /*
     * The case this was missing. VTube Studio has no event for expressions at
     * all, so an expression toggled by a hotkey — from the keyboard, a hand
     * gesture, or another plugin acting on a Twitch reward — changed nothing
     * on the deck. The hotkey event is the only notice there is, and it fires
     * for every one of those.
     */
    const bed = await bench({ token: TOKEN, stored: TOKEN });
    await bed.until('a session', () => bed.runtime.status('ed.vts')?.status === 'ready');

    bed.runtime.setWatched(['ed.vts.expression(blush.exp3.json)']);
    await bed.until('the watched expression', () => bed.variables.get('ed.vts.expression(blush.exp3.json)') === false);

    // The model's state changes underneath us, exactly as it would in VTube
    // Studio, and then a hotkey says something happened.
    STATE.ExpressionStateRequest.expressions[0]!.active = true;
    bed.vts.emit('HotkeyTriggeredEvent', {
      hotkeyID: 'hk-2',
      hotkeyName: 'Смущение',
      hotkeyTriggeredByAPI: true,
    });

    await bed.until('the expression to follow', () => bed.variables.get('ed.vts.expression(blush.exp3.json)') === true);
    assert.equal(bed.variables.get('ed.vts.hotkey'), 'Смущение');

    STATE.ExpressionStateRequest.expressions[0]!.active = false;
    await bed.dispose();
  });

  it('follows an animation for as long as it plays, and ignores the idle one', async () => {
    // An animation is not an expression: it starts, plays and ends, and both
    // ends are reported. An idle animation runs for ever by design, so a key
    // lit up for the whole stream would say nothing.
    const bed = await bench({ token: TOKEN, stored: TOKEN });
    await bed.until('a session', () => bed.runtime.status('ed.vts')?.status === 'ready');

    bed.vts.emit('ModelAnimationEvent', {
      animationEventType: 'Start',
      animationName: 'Помахать',
      isIdleAnimation: false,
    });
    await bed.until('the animation', () => bed.variables.get('ed.vts.animation') === 'Помахать');
    assert.equal(bed.variables.get('ed.vts.animation-active(Помахать)'), true);

    bed.vts.emit('ModelAnimationEvent', {
      animationEventType: 'End',
      animationName: 'Помахать',
      isIdleAnimation: false,
    });
    await bed.until('the end of it', () => bed.variables.get('ed.vts.animation-active(Помахать)') === false);
    assert.equal(bed.variables.get('ed.vts.animation'), '');

    bed.vts.emit('ModelAnimationEvent', {
      animationEventType: 'Start',
      animationName: 'Дыхание',
      isIdleAnimation: true,
    });
    await delay(50);
    assert.equal(bed.variables.get('ed.vts.animation'), '', 'an idle animation is not news');

    // And the names it has seen are what the editor can offer, since VTube
    // Studio has no request that lists them.
    const offered = await bed.runtime.optionsFor('ed.vts', 'animations', {});
    assert.deepEqual(offered.map((option) => option.value), ['Помахать']);

    await bed.dispose();
  });

  it('clears what it published when the connection goes', async () => {
    // A key showing the last model of a program that closed an hour ago is the
    // deck stating something untrue.
    const bed = await bench({ token: TOKEN, stored: TOKEN });
    await bed.until('a session', () => bed.runtime.status('ed.vts')?.status === 'ready');

    await bed.vts.close();
    await bed.until('the model to be cleared', () => bed.variables.get('ed.vts.model') === undefined);
    assert.equal(bed.variables.get('ed.vts.connected'), false);

    await bed.dispose();
  });
});
