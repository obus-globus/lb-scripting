# Repo structure

`lb-scripting` is the **development monorepo** for the LiquidBounce script IDE.

```
apps/
  editor/        lean browser IDE (Monaco + esbuild-wasm), static site, deployed to Pages
  editor-heavy/  heavy editor (from-source vscode-web) + serving layer (host/, lb-glue/,
                 lb-fs/, server-java/)
  host/          lb-ide-host, the in-game LB script that opens the lean editor (CEF)
packages/
  lb-ide-core/   shared build pipeline (esbuild plugin, build, typings, bridge), both modes
  lb-inject/     runtime bytecode-injection library (the inject template depends on it)
templates/       starter/example script projects, read by the editor's build
scripts/         repo-level tooling (sync-lb-inject.mjs)
docs/            this + the (historical) design/handoff docs
.github/         CI: build host + both editors, publish templates.json, deploy lean to Pages
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

- `apps/editor/scripts/gen-templates.mjs` → reads `<root>/templates/*` + `apps/host`,
  emits the bundled `templates.json`. `publish-templates.mjs` runs it in CI and
  commits the published `templates.json` at the repo root (the runtime-fetched
  source).
- `apps/editor/scripts/gen-typings.mjs` → installs `@wunk/lb-script-api-types`
  from npm, emits the per-script `.d.ts` closure (~1.2 MB gz) shipped to Monaco.
- `packages/lb-ide-core/scripts/gen-barrel.mjs` → turns the typings closure into
  the heavy editor's ambient-module barrel (the build-time typings artifact).
- `apps/host/scripts/package.mjs` → builds `apps/editor` then bundles the host
  → `release/` + a drop-in zip.
- Root `package.json` has convenience scripts (`npm run verify`,
  `build:editor`, `build:host`, `package:ingame`) that delegate via `--prefix`
  (no workspace hoisting — each app keeps its own `node_modules`).

## Templates as a runtime source

The bundled `templates/` are baked into the editor, but the editor also fetches
a published `templates.json` at runtime: the `gen-templates` Action regenerates
it from `master` and the editor pulls that raw URL, so template updates don't
need an editor redeploy. Adding arbitrary/custom template repos is deliberately
not exposed yet; it's gated on the untrusted-source warning UX (see the
historical `docs/template-management-plan.md`).
