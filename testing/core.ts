/**
 * The host's side of the bench, borrowed from the main repository.
 *
 * A plugin's tests need what a plugin never touches: the runtime that hosts
 * it and the store that keeps its settings. Those live in `@easydeck/core`,
 * which is not a dependency of any plugin and must not become one — so the
 * tests reach for the built files of the checkout sitting beside this
 * repository, the same one the SDK's `link:` already points into.
 *
 * Deep file paths rather than the package, deliberately: core's index pulls
 * in the whole daemon, native bindings included, and a test bench wants two
 * classes from it.
 */
export { PluginRuntime } from '../../EasyDeck/packages/core/dist/application/plugin-runtime.js';
export { PluginSettingsStore } from '../../EasyDeck/packages/core/dist/infrastructure/plugins/plugin-settings-store.js';

// Types by the same relative road: this file belongs to no package, so bare
// specifiers have no node_modules to resolve from here.
import type {
  ActionRegistry,
  PluginActivation,
  PluginManifest,
} from '../../EasyDeck/packages/engine/dist/index.js';
import type { PluginRuntime as Runtime } from '../../EasyDeck/packages/core/dist/application/plugin-runtime.js';

/**
 * Wires an activation the way the host's loader does.
 *
 * Tests build the activation themselves — `activateWith(...)` with short
 * retries and a fake to connect to — and this does the rest, so the wiring
 * they run under is the wiring the plugin ships under.
 */
export async function installForTest(
  manifest: PluginManifest,
  activation: PluginActivation,
  registry: ActionRegistry,
  runtime: Runtime,
): Promise<void> {
  registry.installPlugin(manifest, activation.handlers ?? {});
  await runtime.install(manifest, activation.plugin ?? {});
  if (activation.commands) runtime.registerCommands(manifest.id, activation.commands);
}
