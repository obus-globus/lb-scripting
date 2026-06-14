# Spike: Monaco + `@wunk/lb-script-api-types` in the browser

**Question:** does our mixed ambient-globals + JVM-path-module typings package
resolve in Monaco's in-browser TypeScript worker (the load-bearing unknown from
[`../../docs/03-monaco-ts-worker.md`](../../docs/03-monaco-ts-worker.md)), and is
the closure small enough to ship to a browser?

**Answer: yes, verified headless in google-chrome.**

## Results (reproduced by `node verify.mjs`)

```
typing files registered in-browser: 6,035   (closure of a representative script)
closure size:                       10.6 MB raw / ~1.2 MB gzipped
good.ts diagnostics:                0 errors  ← ambient globals + import both resolve
bad.ts diagnostics:                 3 errors:
   TS2339  Property 'toUpperCase' does not exist on type 'number'
   TS2345  Argument of type 'number' is not assignable to parameter of type 'string'
   TS2769  No overload matches this call       ← bogus event name rejected by typed on()
mc.* autocomplete:                  234 real members
```

So: real IDE-grade type-checking + autocomplete against our `.d.ts`, **zero
backend**, per-tab isolated by construction.

### What made module resolution work

The research flagged a known Monaco bug where `addExtraLib` files at `file:///`
paths fail to resolve on `import`. We avoided it by mirroring a real package
layout in the virtual FS:

- every typing registered at `file:///node_modules/@wunk/lb-script-api-types/<rel>`
- the package's own `package.json` (carrying `typesVersions`) included in the
  bundle, so `@wunk/lb-script-api-types/ambient` and `/types/.../Vec3` subpaths
  resolve
- compiler options: `moduleResolution: NodeJs`, `types: ["…/ambient"]`,
  `target ES2022`, `lib es2023`, `strict`, `skipLibCheck`

### The 96 MB → 1.2 MB insight

The full package is **56,630 `.d.ts` files / 96 MB** (the entire Java + Minecraft
+ LiquidBounce binding tree). You must NOT ship all of it. `gen-bundle.mjs` asks
`tsc --listFiles` for the transitive closure a representative script actually
references (~6 k files / 10.6 MB / 1.2 MB gzipped) and emits just that. A real
product would compute the closure per the template's imports at build time (or
lazy-load `.d.ts` on demand).

## Files

```
good.ts          representative script (ambient globals + JVM-path import) — 0 errors
bad.ts           same with 3 deliberate type errors — diagnostics must fire
tsconfig.json    compiler options used for the closure + the Monaco worker
gen-bundle.mjs   tsc --listFiles → typings-bundle.json (the shippable closure)
public/
  index.html     the page
  app.js         boots Monaco, setExtraLibs(closure), runs diagnostics/completions
verify.mjs       serves public/, loads it in headless google-chrome, asserts
```

## Reproduce

```bash
npm install
npx tsc -p tsconfig.json          # compiler-level proof: good.ts = 0 errors
node gen-bundle.mjs               # writes typings-bundle.json (~12 MB)
node verify.mjs                   # headless browser proof (needs google-chrome)
# or open public/ in a browser via any static server and click good.ts / bad.ts
```

## What this does NOT prove / cover

- No real `npm install`, terminal, or `npm run dev` live-client/`:9229` debug —
  those are intrinsically out of a browser sandbox (see the docs).
- The **build step** (esbuild-wasm bundling TS → `.mjs` with a virtual-FS plugin)
  is not built here — that's the next spike if we proceed.
- Per-tab persistence (IndexedDB / File System Access API) not implemented.
