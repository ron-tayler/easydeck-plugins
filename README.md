# easydeck-plugins

EasyDeck's plugins, one folder per plugin under its author:
`plugins/<author>/<name>/`. The plugin's id is those two names joined —
`plugins/ed/soundpad` is `ed.soundpad`, and its keys store action types like
`ed.soundpad.play`.

How any of this travels — the build, the registry, the store, what happens
when two authors pick one name — is written up in the main repository, in
`docs/plugin-distribution.md`. This file is only the part you touch.

## Building

```bash
pnpm install
pnpm build
```

`build/<id>/` then holds what an installed plugin is: one `main.mjs` with
every dependency bundled in, a `plugin.json` generated from the manifest the
code actually exports, and whatever `icons/`, `locales/`, `assets/` or
`natives/` the plugin carries. `registry/index.json` is the store's view of
all of it.

To try one against a running EasyDeck, copy `build/<id>` into the app's
plugins folder (`%APPDATA%/EasyDeck/plugins/` on Windows) and restart.

## Writing one

Start from `plugins/ed/soundpad` — it is deliberately the smallest. The shape:

- `src/index.ts` default-exports `definePlugin({ manifest, activate })`;
- the manifest declares everything a person sees: actions, variables,
  settings, commands, presets, surfaces;
- `activate()` builds the running parts and returns them; the host does all
  wiring.

The SDK (`@easydeck/plugin-sdk`, the `sdk/` folder here) is the contract's
types re-exported and nothing else. It follows the engine of the main
repository checked out *beside* this folder — `../EasyDeck` — via a `link:`
dependency, so a contract change there is a type error here, immediately.

Native code is allowed in exactly two forms: a DLL called through koffi, or
an N-API module. Nothing built against a specific runtime's ABI.
