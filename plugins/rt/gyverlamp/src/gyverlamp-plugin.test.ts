import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, it } from 'node:test';

import { VariableStore, createActionRegistry } from '@easydeck/engine';
import type { ActionContext } from '@easydeck/engine';

import { PluginRuntime, PluginSettingsStore, installForTest } from '../../../../testing/core.js';

import { FakeLamp } from './fake-lamp.js';
import { activateWith, gyverLampManifest } from './gyverlamp-plugin.js';

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
  /** Effects the stand-in lamp will list; unset, it has no registry. */
  readonly effects?: readonly string[];
  /** Leaves the known-lamps setting empty, for the rescan test. */
  readonly unknown?: boolean;
}

/**
 * A runtime with the plugin installed and one stand-in lamp behind it.
 *
 * The lamp is remembered rather than discovered — discovery sweeps a real
 * subnet, and what these tests are about is what happens once a lamp is
 * known. The rescan test hands the sweep a stand-in of its own.
 */
async function bench(options: BenchOptions = {}) {
  const lamp = new FakeLamp();
  if (options.effects) lamp.effects = options.effects;
  const port = await lamp.listen();
  const key = `127.0.0.1:${port}`;

  const dir = `${process.env['TEMP'] ?? '/tmp'}/easydeck-gyverlamp-${port}`;
  const settings = new PluginSettingsStore(undefined, `${dir}/open`, `${dir}/sealed`);
  await settings.save(
    'rt.gyverlamp',
    {
      enabled: true,
      ...(options.unknown ? {} : { lamps: JSON.stringify([{ host: '127.0.0.1', port }]) }),
    },
    gyverLampManifest.settings ?? [],
  );

  const variables = new VariableStore();
  const registry = createActionRegistry();
  const runtime = new PluginRuntime({ settings, variables });
  runtime.on('error', () => undefined);

  const activation = activateWith({
    pollMs: 60,
    idlePollMs: 60,
    requestTimeoutMs: 250,
    sweep: async () => [{ host: '127.0.0.1', port }],
  });

  await installForTest(gyverLampManifest, activation, registry, runtime);

  let closed = false;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    await runtime.stopAll();
    await lamp.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(
      () => undefined,
    );
  };
  benches.push(dispose);

  return {
    lamp,
    key,
    variables,
    settings,
    activation,
    dispose,
    run: (type: string, params: Record<string, unknown> = {}) =>
      registry.run({ type, params }, context(variables)),
    /** What a key actually asked for — the poll's GETs and the LIST reads left out. */
    sent: () => lamp.commands.filter((command) => command !== 'GET' && !command.startsWith('LIST')),
    async until(what: string, holds: () => boolean, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (holds()) return;
        await delay(20);
      }
      assert.fail(`Timed out waiting for ${what}`);
    },
  };
}

describe('GyverLamp plugin', () => {
  it('mirrors the lamp into variables, under both names', async () => {
    const it = await bench();

    await it.until(
      'the poll to publish',
      () => it.variables.get(`rt.gyverlamp.on(${it.key})`) === true,
    );

    // The only lamp is the chosen lamp, so the bare names say the same.
    assert.equal(it.variables.get('rt.gyverlamp.on'), true);
    assert.equal(it.variables.get('rt.gyverlamp.brightness'), 145);
    assert.equal(it.variables.get('rt.gyverlamp.speed'), 203);
    assert.equal(it.variables.get('rt.gyverlamp.scale'), 1);
    assert.equal(it.variables.get('rt.gyverlamp.effect'), 42);
    // Effect 42 of the shipped registry — the lamp listed nothing, so the
    // fallback names it.
    assert.equal(it.variables.get('rt.gyverlamp.effect-name'), 'Oгoнь');
    assert.equal(it.variables.get('rt.gyverlamp.connected'), true);

    await it.dispose();
  });

  it('toggles power from the mirrored state', async () => {
    const it = await bench();
    await it.until('the poll', () => it.variables.get('rt.gyverlamp.on') === true);

    await it.run('rt.gyverlamp.power', { mode: 'toggle' });

    assert.deepEqual(it.sent(), ['P_OFF']);
    assert.equal(it.lamp.state.on, false);
    assert.equal(it.variables.get('rt.gyverlamp.on'), false);

    await it.dispose();
  });

  it('mirrors the reply of an effect switch, not the request', async () => {
    const it = await bench();
    await it.until('the poll', () => it.variables.get('rt.gyverlamp.on') === true);

    await it.run('rt.gyverlamp.effect', { mode: 'set', effect: '2' });

    // The stand-in loads effect 2's own stored settings, exactly as the
    // firmware does — and the variables must say what the lamp said.
    assert.deepEqual(it.sent(), ['EFF2']);
    assert.equal(it.variables.get('rt.gyverlamp.effect'), 2);
    assert.equal(it.variables.get('rt.gyverlamp.brightness'), 12);
    assert.equal(it.variables.get('rt.gyverlamp.speed'), 22);

    await it.dispose();
  });

  it('steps brightness from the current value', async () => {
    const it = await bench();
    await it.until('the poll', () => it.variables.get('rt.gyverlamp.brightness') === 145);

    await it.run('rt.gyverlamp.brightness', { mode: 'up', value: 25 });

    assert.deepEqual(it.sent(), ['BRI170']);
    assert.equal(it.variables.get('rt.gyverlamp.brightness'), 170);

    await it.dispose();
  });

  it('steps scale from the current value', async () => {
    const it = await bench();
    await it.until('the poll', () => it.variables.get('rt.gyverlamp.scale') === 1);

    await it.run('rt.gyverlamp.scale', { mode: 'up', value: 10 });

    assert.deepEqual(it.sent(), ['SCA11']);
    assert.equal(it.variables.get('rt.gyverlamp.scale'), 11);

    await it.dispose();
  });

  it('drops a late reply instead of crediting the next command', async () => {
    const it = await bench();
    await it.until('the poll', () => it.variables.get('rt.gyverlamp.on') === true);

    // The next reply leaves the lamp well after the asker's deadline — the
    // shape of the real-lamp failure this guards against: one late answer
    // after a busy moment, and every reply after it credited one command on.
    it.lamp.delayOnceMs = 400;
    await delay(320); // a poll GET has timed out by now; its reply is still airborne

    await it.run('rt.gyverlamp.brightness', { mode: 'set', value: 99 });

    // The key's variable says what the lamp answered *to this command*,
    // not what the stray said about an earlier world.
    assert.equal(it.variables.get('rt.gyverlamp.brightness'), 99);

    await it.dispose();
  });

  it('reports a lamp that stops answering', async () => {
    const it = await bench();
    await it.until('the poll', () => it.variables.get('rt.gyverlamp.connected') === true);

    it.lamp.silent = true;

    await it.until(
      'the misses to add up',
      () => it.variables.get('rt.gyverlamp.connected') === false,
    );
    assert.equal(it.variables.get('rt.gyverlamp.on'), undefined);

    await it.dispose();
  });

  it('reads the effect list from the lamp and keeps it', async () => {
    const it = await bench({ effects: ['Alpha', 'Beta', 'Gamma'] });
    it.lamp.state.effect = 1;

    await it.until(
      'the list to be read',
      () => it.variables.get('rt.gyverlamp.effect-name') === 'Beta',
    );

    const kept = await it.settings.load('rt.gyverlamp');
    assert.match(String(kept['lamps']), /Gamma/);

    await it.dispose();
  });

  it('finds, remembers and chooses a lamp on rescan', async () => {
    const it = await bench({ unknown: true });

    await it.activation.commands!['rescan']!();

    const kept = await it.settings.load('rt.gyverlamp');
    assert.equal(kept['lamp'], it.key);
    assert.match(String(kept['lamps']), /127\.0\.0\.1/);

    await it.until('the poll', () => it.variables.get('rt.gyverlamp.on') === true);

    await it.dispose();
  });
});
