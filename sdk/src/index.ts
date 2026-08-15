/**
 * @easydeck/plugin-sdk — what a plugin is written against.
 *
 * A re-export, deliberately. The contract lives in the engine and this
 * package adds nothing to it: a plugin author gets the same types the
 * built-in plugins compile against, down to the version number. When
 * `PLUGIN_API_VERSION` moves, this package and every plugin in this
 * repository move in the same pull request.
 *
 * A workspace package rather than an npm one, for as long as every plugin
 * lives in this repository. Publishing is a decision for the day somebody
 * wants to build a plugin outside it — see docs/plugin-distribution.md in
 * the main repository.
 *
 * The helpers are runtime values and get bundled into each plugin's
 * `main.mjs`. That is correct, not wasteful: the copy of `stringParam`
 * inside a plugin is the one its author tested against, and the constant
 * `PLUGIN_API_VERSION` frozen into the bundle is precisely "the version this
 * plugin was built against" — which is what the loader checks.
 */

export {
  PLUGIN_API_VERSION,
  definePlugin,
  localized,
  numberParam,
  parseVariableKey,
  readList,
  stringParam,
  valueParam,
  variableKey,
} from '@easydeck/engine';

export type {
  ActionDefinition,
  ActionHandler,
  ButtonPreset,
  LocalizedText,
  OptionLoader,
  ParamDefinition,
  ParamOption,
  Plugin,
  PluginActivation,
  PluginCommand,
  PluginHost,
  PluginManifest,
  PluginModule,
  PluginStatus,
  PresetButton,
  SurfaceDefinition,
  SurfaceFrame,
  SurfaceRequest,
  SurfaceSpec,
  Ticker,
  VariableDeclaration,
  VariableValue,
  WidgetOnScreen,
} from '@easydeck/engine';
