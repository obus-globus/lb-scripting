# @lb-ide/core

The shared LB build pipeline, single-sourced so both editor modes (lean and
heavy) consume the same code. Pure ESM, no bundler of its own.

## Modules (`src/`)

- `build-plugin.js`: `buildPlugins(files, cfg, injectBundle)`, the esbuild plugin
  that implements the template conventions (JVM value-import to `Java.type(...)`,
  `lb-inject` inlining, type-only `@wunk` erasure) over an in-memory vfs.
- `build.js`: `runBuild({esbuild, files, cfg, entry, injectBundle})` returning
  `{name, code, warnings}`; plus `DEFAULT_BUILD` and `resolveEntry`.
- `typings.js`: `getClosure(url, fetchImpl)` + `toExtraLibs(closure, extras)`, the
  lean RUNTIME typings adapter (Monaco `setExtraLibs`).
- `bridge.js`: `createBridge({base, token, fetchImpl})`, the ScriptManager host
  client over HTTP or WebSocket (auto-selected by the base), token-headered. Ops:
  `ping`, `projects`, `scripts`, `script`, `templates`, `saveTemplate`,
  `deleteTemplate`, `save`, `load`, `repl`, and `subscribeLog` (the live-log
  stream).
- `templates.js`: template-source parsing/normalization shared by the editors.

## `scripts/gen-barrel.mjs`

Generates the heavy editor's BUILD-TIME typings artifact: an ambient-module-per-path
barrel `.d.ts` from a `@wunk` closure, so deep imports resolve without per-file
tsserver FS probing. Parameterized (`--bundle`/`--wunk`/`--out`/`--pkg`/`--ambient`).

## How each mode consumes it

- Lean ([`apps/editor`](../../apps/editor/)) is buildless: `main.js` loads these
  modules via dynamic `import()`. Typings come from `typings.js` at runtime.
- Heavy ([`apps/editor-heavy`](../../apps/editor-heavy/)) bundles `build.js` and
  `bridge.js` into its `lb-glue` / `lb-fs` web extensions; typings come from the
  build-time barrel above, not the runtime adapter.
