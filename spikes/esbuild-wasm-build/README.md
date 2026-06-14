# Spike: in-browser build with `esbuild-wasm`

**Question:** can we produce the downloadable `.mjs` (the LB script artifact)
**entirely in the browser tab**, with no server — the second engineering unknown
from [`../../docs/03-monaco-ts-worker.md`](../../docs/03-monaco-ts-worker.md)?

**Answer: yes, verified headless in google-chrome.**

## Results (reproduced by `node verify.mjs`)

```
esbuild 0.23.1  (matches the template's ^0.23)

[ts]  multi-file TS project  → 460 B single .mjs
[js]  multi-file JS project  → 347 B single .mjs

asserted on both outputs:
  ✓ local helper file inlined        (MARKER "INLINED_UTIL_42" present)
  ✓ type-only @wunk import erased     (no "@wunk/" in output)
  ✓ no residual import / require      (fully self-contained ESM)
  ✓ ambient globals preserved         (registerScript left as a free reference,
                                        resolved at runtime by GraalJS)
  ✓ output is syntactically valid JS
```

## How it works

`esbuild-wasm` runs the real esbuild bundler compiled to WebAssembly, in-tab.
Since the browser has no filesystem, a small **virtual-FS plugin** (`vfsPlugin`
in `public/app.js`) serves the in-memory project files via `onResolve`/`onLoad`
and maps the types package (`@wunk/...`) to an empty module — its imports are
type-only and esbuild erases them during transpile anyway.

This mirrors what the template's `scripts/build.mjs` does on Node (multi-file →
one `dist/*.mjs`), just moved into the browser. esbuild does **not** type-check —
that's Monaco's job (see the sibling `monaco-typings` spike) — so a real product
runs Monaco diagnostics for errors and esbuild-wasm for the artifact.

## Files

```
public/index.html   minimal page
public/app.js        in-memory project + vfs plugin + esbuild.build()
verify.mjs           serves public/, loads in headless google-chrome, asserts
```

## Reproduce

```bash
npm install
node verify.mjs        # needs google-chrome; ~5s
# or open public/ via any static server to see the bundle rendered
```

## Notes / not covered

- `esbuild-wasm` init pulls a ~10 MB `.wasm` once per tab (cacheable).
- No minification toggled here (the template doesn't minify either); trivial to
  add `minify: true`.
- Delivering the `.mjs` to a live client + the `:9229` GraalJS debug loop remain
  out of browser scope (intrinsic sandbox limit) — unchanged from the docs.
