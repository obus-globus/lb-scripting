# Repo structure

`lb-scripting` is the **development monorepo** for the LiquidBounce script IDE.

```
apps/
  editor/      browser IDE (Monaco + esbuild-wasm); deployed at host.example/lb-ide/
  host/        lb-ide-host — the in-game LB script that opens the editor (CEF)
packages/
  lb-inject/   runtime bytecode-injection library (the inject template depends on it)
templates/     starter/example script projects, read by the editor's build
scripts/       repo-level tooling (sync-lb-inject.mjs)
docs/          this + the in-game plan
.github/       CI (typecheck lb-inject + build host + editor on every push)
```

## What's in vs. out

**In (development assets for the IDE):**
- the editor and the host script (the product)
- the **templates** — dev assets: editing one here changes the editor's "+ new"
  picker. `gen-templates.mjs` reads `templates/*` (and `apps/host` as the
  `lb-ide-host` example) at build time.
- **`packages/lb-inject`** — the runtime injection library; the `inject-ts`
  template depends on it. The lib is the source of truth; its built bundle is
  copied into the template's `vendor/lib/` by `npm run sync:lb-inject` (committed
  there so the template stays standalone-buildable). The template's module-form
  `lb-inject.d.ts` is hand-maintained alongside the lib's global `.d.ts`. Still
  publishes to npm as `lb-inject` from `packages/lb-inject` on a tag.

**Out (stay in their own repos for now):**
- `@wunk/lb-script-api-types` — the typings package (~96 MB / 56k `.d.ts`,
  generated + published to npm). Consumed as an npm dependency; bringing it in
  would bloat every clone. Stays separate (with its generator).
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
