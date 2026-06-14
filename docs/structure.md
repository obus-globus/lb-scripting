# Repo structure

`lb-scripting` is the **development monorepo** for the LiquidBounce script IDE.

```
apps/
  editor/      browser IDE (Monaco + esbuild-wasm); deployed at host.example/lb-ide/
  host/        lb-ide-host — the in-game LB script that opens the editor (CEF)
templates/     starter/example script projects, read by the editor's build
docs/          this + the in-game plan
.github/       CI (build host + editor on every push)
```

## What's in vs. out

**In (development assets for the IDE):**
- the editor and the host script (the product)
- the **templates** — they're dev assets: editing one here changes the editor's
  "+ new" picker. The editor's `gen-templates.mjs` reads `templates/*` at build
  time (and `apps/host` as the `lb-ide-host` example).

**Out (stay in their own repos for now):**
- `@wunk/lb-script-api-types` — the typings package (~96 MB / 56k `.d.ts`,
  generated + published to npm). Consumed as an npm dependency; bringing it in
  would bloat every clone. Stays separate (with its generator).
- `lb-inject` — the runtime injection library. The `inject-ts` template vendors
  the bits it needs (`vendor/lib/*.js`, `types/lb-inject.d.ts`); the lib itself
  stays its own repo.
- `lb-nodeflow` and other finished/standalone scripts — separate products.

## Build wiring

- `apps/editor/scripts/gen-templates.mjs` → reads `<root>/templates/*` + `apps/host`.
- `apps/editor/scripts/gen-typings.mjs` → installs `@wunk/lb-script-api-types`
  from npm, emits the per-script `.d.ts` closure (~1.2 MB gz) shipped to Monaco.
- `apps/host/scripts/package.mjs` → builds `apps/editor` then bundles the host
  → `release/` + a drop-in zip.
- Root `package.json` has convenience scripts (`npm run verify`,
  `build:editor`, `build:host`, `package:ingame`) that delegate via `--prefix`
  (no workspace hoisting — each app keeps its own `node_modules`).

## Later

When the template/types repos go public, swap the in-repo templates for a
"fetch from GitHub" step (with an in-app "update templates" button) — the
boundary is isolated to `gen-templates.mjs`'s `TEMPLATES` constant.
