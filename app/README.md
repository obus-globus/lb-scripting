# lb-ide-app — browser-only LiquidBounce script IDE (MVP)

A **zero-backend** web IDE for LiquidBounce TS/JS scripts. Wires together the two
verified spikes into one page:

- **Monaco** with `@wunk/lb-script-api-types` loaded into the TS worker →
  autocomplete + type-checking against the ambient globals and JVM-path imports
  (TS and `// @ts-check` JS).
- **esbuild-wasm** → bundles the multi-file project into one downloadable `.mjs`,
  entirely in the tab.
- **IndexedDB persistence**, keyed by a per-session id in the URL hash, so **each
  tab/session has its own isolated files**. "New session" mints a fresh one.

No server, no Docker, no accounts. Open the page and edit. This directly answers
the original question ("each opened tab gets its own files") with none of the
orchestration / Kubernetes / licensing baggage of the server-side options — see
[`../README.md`](../README.md) for how we got here.

## Features (all verified headless by `npm run verify`)

```
✓ multiple projects in a tab bar, each its own files, persisted independently
✓ "+ new" template picker, seeded from the real LB templates (full src/ trees):
    default-ts · plain-js · starter-ts · inject-ts (lb-inject)
✓ multi-file projects with a collapsible FOLDER TREE (create/delete files +
    folders at any depth); cross-folder ./imports resolve & inline in the build
✓ live type-checking + autocomplete (TS and // @ts-check JS), moduleDetection
    forced so the many files don't collide in global scope
✓ build → self-contained .mjs, matching the template build conventions:
    · JVM-type value imports  →  Java.type("<fqcn>")
    · `import { Inject } from "lb-inject"`  →  inlined lb-inject runtime
    · type-only @wunk imports erased; local ./imports inlined
✓ download the built .mjs · add / delete / rename files
✓ autosave to IndexedDB; projects survive reload; per-project isolation
```

Templates are generated from the canonical sources by `scripts/gen-templates.mjs`
(into `public/templates.json` + the lb-inject typings/runtime), so they stay in
sync with the real `lb-*-template` repos.

![screenshot](docs/screenshot.png)

## Run

```bash
npm install            # also runs gen-typings (postinstall) → public/typings-bundle.json
npm run serve          # http://localhost:8085
# or headless smoke test:
npm run verify         # needs google-chrome
```

`npm run gen-typings` regenerates the shipped typings closure (the ~6k-file /
~1.2 MB-gzipped slice of the 96 MB package that a representative script
references — see `scripts/gen-typings.mjs`).

> Dev note: `public/vs`, `public/esbuild.js`, `public/esbuild.wasm` are symlinks
> into `node_modules` (created here for local dev). A production build would copy
> these in and serve everything same-origin.

## Architecture

```
public/
  index.html     layout (toolbar, file sidebar, editor, log)
  main.js        Monaco + typings + file mgmt + esbuild build + IndexedDB + download
  typings-bundle.json   generated: the .d.ts closure shipped to the worker
  vs/ esbuild.*  monaco + esbuild-wasm assets (symlinked in dev)
scripts/gen-typings.mjs   tsc --listFiles → typings-bundle.json
serve.mjs        dev static server
verify.mjs       headless google-chrome end-to-end assertions
```

## Out of scope (intrinsic browser-sandbox limits)

Real `npm install`, a terminal, and the live-client / `:9229` GraalJS debug loop
cannot run in a browser tab. Those stay with `code-server` (`../../lb-web-ide`)
or a local CLI — the intended two-tier split.

## Next steps (not yet built)

- Ship more/zip the project for download; import an existing project.
- Lazy-load `.d.ts` on demand so arbitrary JVM-class imports get types beyond the
  shipped closure.
- Expose behind Caddy on a path (static hosting is all it needs).
