# 03 — Monaco Editor + TypeScript Web Worker (browser-only)

> **One-line verdict:** Real IDE-grade type-checking against our `.d.ts` with
> **zero backend**, per-tab isolation free, `esbuild-wasm` for the build.
> **Strong, arguably ideal fit** for "author + type-check + build, isolated, zero
> infra." All-MIT.
>
> **✅ VERIFIED** by the spike in [`../spikes/monaco-typings/`](../spikes/monaco-typings/):
> our package resolves in a real headless-chrome Monaco worker — `good.ts` 0
> errors, `bad.ts` 3 errors (incl. typed-event rejection), `mc.*` → 234
> completions. The closure to ship is ~6 k files / **10.6 MB raw / ~1.2 MB
> gzipped** (slice it from the package's 96 MB via `tsc --listFiles`). The
> module-resolution caveat below was avoided by mirroring a `node_modules/@wunk/…`
> layout + including the package `package.json` and using `NodeJs` resolution.

## 1. What Monaco ships out of the box

`monaco-editor` bundles a **modified TypeScript compiler** and runs the **TS
Language Service inside a dedicated web worker** (`ts.worker`). Main-thread
adapters implement Monaco's provider interfaces and talk to the worker (which
implements `ts.LanguageServiceHost`). This gives real **autocomplete,
hover/quick-info, signature help, and semantic + syntactic diagnostics fully
in-browser, no server**. For TypeScript, **semantic validation is on by default**
(off for plain JS). Documented architecture, not assumption.

**Bundled TS version:** Monaco vendors a *specific* TS build (not npm
`typescript`). v0.50.0 (June 2024) upgraded to **TS 5.4.5** (recent 0.52.x still
~5.4). **Cannot be swapped at runtime** — changing it requires a fork/rebuild;
the practical route is the **`@live-codes/monaco-editor`** rebuild (same machinery
as the TS Playground): `npm run build 5.4.5`/`next`. TS 5.4 is fine for typical
`.d.ts` consumption, so v0.38.4 of our typings likely needs no custom build unless
they use very new TS syntax.

## 2. Loading `@wunk/lb-script-api-types`

Two supported mechanisms on `monaco.languages.typescript.typescriptDefaults`:

- `addExtraLib(content, filePath)` — inject one `.d.ts` as a string.
- `setExtraLibs([{ content, filePath }, …])` — inject **multiple** files at once.

Merged into the worker's virtual file registry alongside editor models;
`setCompilerOptions(...)` / `setDiagnosticsOptions(...)` control `target`,
`module`, `moduleResolution`, error suppression, etc.

**⚠ Critical caveat — our package exports BOTH ambient globals AND importable
modules:**

- **Ambient globals** (`mc`, `Client`, `Setting` via `declare global {}` /
  top-level `declare const`) — work straightforwardly; drop the `.d.ts` in and
  they're in scope everywhere.
- **Importable modules** — the well-known bug: a lib added via `addExtraLib` with
  a `file:///` path often fails to resolve on `import … from "…"`. The verified
  fix is to register the lib under an **`inmemory://model/...` URI** (or place
  files at `node_modules/@wunk/lb-script-api-types/...`-style paths and set
  `paths`/`baseUrl`). So a **mixed ambient+module package can work**, but you must
  lay the virtual files out to mimic `node_modules` resolution. **This is the main
  integration risk — budget real time; only a prototype confirms our exact
  package resolves cleanly.**

No automatic npm `@types` fetching — you ship the typings yourself (read the
package's `.d.ts` at build time and embed/serve them). Multi-file `.d.ts` via
`setExtraLibs`. `extraLibs` are **global** to a `typescriptDefaults` instance —
fine for a per-tab single-page design (exactly what we want).

## 3. Persistence & per-tab isolation

**Core strength:** each browser tab is its own page/JS context with its own worker
and in-memory models — **isolation is free, zero backend**. Multi-file projects
in one tab via multiple `monaco.editor.createModel(...)` with distinct `file:///`
URIs; the worker cross-resolves imports. Persistence = standard browser APIs:
**IndexedDB** (best for multi-file state), **File System Access API**
(`showDirectoryPicker`, real local folder R/W — Chromium-only), or
**download/upload**. None need a server.

## 4. The build gap

Monaco only type-checks; it does **not** bundle or run. To produce the `.mjs`:

- **`esbuild-wasm` runs fully in-browser** (`esbuild.initialize({ wasmURL })`,
  then `transform()`/`build()`). Confirmed it can **bundle multiple TS files into
  a single ESM output** (`format:"esm"`, `bundle:true`), read from
  `result.outputFiles[0].text`.
- **Limitation:** no filesystem in-browser, so bundling across files / resolving
  `@wunk/...` needs a **custom esbuild plugin** (`onResolve`/`onLoad`) serving
  virtual files from memory or HTTP. Single-file transpile is trivial; true
  bundling needs that plugin layer. WASM init ~10 MB.

**`npm run dev` / live-client hot-reload + GraalJS `:9229` is NOT possible
client-side** — a browser tab cannot open arbitrary TCP sockets to a local game
client. That workflow inherently needs a local process/backend. So this tool is
firmly "**author → type-check → download `.mjs`**," not "dev against live client."

## 5. Build-it-yourself vs. Sandpack

Rolling our own (Monaco + extraLibs + esbuild-wasm + IndexedDB) is **moderate
effort** — hard parts: (a) module-resolution layout for the typings, (b) the
esbuild virtual-FS plugin. **CodeSandbox Sandpack** solves a *different* problem:
it's a **bundler/runner** (live preview), **not a type-checker** — TS diagnostics
are a known gap. Sandpack gives "run it" (which we can't use — no live client) and
**not** the rich in-browser type-checking that is our actual requirement. So
Sandpack is a poor fit; **Monaco's worker is the right primitive.** Wrappers like
`@monaco-editor/react` only ease mounting, not the typings/bundle work.

## 6. Licensing

**monaco-editor (MIT)** and **esbuild (MIT)** — permissive, no usage
restrictions. `@live-codes/monaco-editor` also MIT.

## 7. Verdict

For "**author + type-check + build a downloadable `.mjs`, each tab isolated, zero
infra**," this is a **strong, arguably ideal fit.** Genuine IDE-grade
type-checking against our `.d.ts` with no server, free per-tab isolation, and
`esbuild-wasm` closing the build step. The two real costs are engineering:
resolving our mixed ambient+module typings (`inmemory://`/node_modules-style
paths) and the esbuild virtual-FS plugin.

**What we lose vs code-server:** no terminal, no real `npm install` (must
pre-bundle/serve typings + deps ourselves), no `npm run dev` hot-reload, and **no
live-client / `:9229` debugging** — intrinsically local-process features. A
reasonable architecture is **two tiers**: the zero-infra Monaco tool for quick
authoring + downloadable builds (most users), plus code-server / a local CLI for
the advanced live-debug workflow.

**Uncertainty flags:** exact bundled TS in the very latest Monaco patch beyond
0.52.x not pinned (0.50–0.52 = TS 5.4.5; verify on the chosen version). Whether
our specific v0.38.4 typings resolve cleanly as importable modules needs an actual
spike — the `inmemory://` fix is real, but multi-package/`paths` edge cases only a
prototype confirms.

## Sources

- TS Language Services (Monaco source) — https://deepwiki.com/microsoft/monaco-editor/3.2-typescript-language-services
- `addExtraLib` module-resolution fix (`inmemory://`) — https://github.com/Microsoft/monaco-editor/issues/754
- Per-editor extraLibs limitation — https://github.com/Microsoft/monaco-editor/issues/374
- Bundled TS version (5.0.2 → 5.4.5 in 0.50.0) — https://github.com/microsoft/monaco-editor/issues/4537
- Replacing bundled TS requires fork/rebuild — https://github.com/microsoft/monaco-editor/issues/1426
- Custom TS version rebuild — https://github.com/live-codes/monaco-editor
- esbuild-wasm in-browser API — https://esbuild.github.io/api/
- Bundling TS in the browser (virtual FS plugin) — https://www.zaynetro.com/post/2023-bundling-ts-in-browser
- Running esbuild in the browser — https://schof.co/running-esbuild-in-the-browser/
- Sandpack overview — https://sandpack.codesandbox.io/
- Sandpack TS limits — https://github.com/codesandbox/sandpack/discussions/237
- monaco LICENSE (MIT) — https://github.com/microsoft/monaco-editor/blob/main/LICENSE.txt
- esbuild (MIT) — https://en.wikipedia.org/wiki/Esbuild
