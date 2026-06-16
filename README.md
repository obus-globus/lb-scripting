# lb-scripting

Development monorepo for the **LiquidBounce script IDE**: a browser-based IDE for
writing [LiquidBounce](https://liquidbounce.net) (nextgen, MC 1.21+) TypeScript/JS
scripts, with full type-checking and a real build entirely client-side (no
backend). It also runs **in-game**: opened inside the Minecraft client
(LiquidBounce's CEF browser), it loads the scripts you build straight into the
client.

## Two editor modes

Both modes share one build pipeline ([`packages/lb-ide-core`](packages/lb-ide-core/)):
the esbuild plugin (`Java.type(...)` rewrite, `lb-inject` inlining, type-only
erasure), the build orchestration, the `@wunk/lb-script-api-types` typings, and
the host bridge client.

- **Lean** (default), [`apps/editor/`](apps/editor/): a buildless browser app.
  Monaco + the typings in the TS worker + esbuild-wasm, served as plain static
  files. No cross-origin isolation needed. Cold start ~4.5 s.
  Live: <https://obus-globus.github.io/lb-scripting/> (GitHub Pages).
- **Heavy** (opt-in, web-only for now), [`apps/editor-heavy/`](apps/editor-heavy/):
  the real microsoft/vscode "for web", built from source. Full IDE; needs
  cross-origin isolation (`SharedArrayBuffer` for the web tsserver). Typings come
  from a build-time ambient-module barrel so deep imports resolve without per-file
  tsserver probing. Cold start ~5.5 s.
  Live: <https://cb.2d.rocks/liquid-ide/> (static, currently a read-only demo
  project; pointing it at a live bridge is follow-up work).

The lean editor is the one you'd normally host. Heavy needs a server that sets the
COI headers (Caddy in our deploy), so it can't go on GitHub Pages.

## In-game

Two host paths bridge the editor to LiquidBounce's `ScriptManager`:

- [`apps/host/`](apps/host/): `lb-ide-host`, a normal LB script that opens the
  **lean** editor in a fullscreen CEF screen and serves a localhost bridge (build
  & run, hot-reload, debug attach, REPL, log streaming, open installed scripts).
  Localhost-only, token + Origin gated.
- [`apps/editor-heavy/server-java/`](apps/editor-heavy/server-java/): a
  dependency-free (JDK-only) server that statically serves the heavy bundle with
  COI headers and exposes the bridge over HTTP (same-origin) and WebSocket (for a
  hosted `https` editor talking back to `ws://localhost`). It runs on plain threads
  so it works headlessly in-client, where the GraalJS-script socket server cannot.

**Status:** the host script and the Java server type-check, build, and are proven
in a browser (and, for the Java server, against a mock bridge). They are **not yet
run in a live LiquidBounce client**: CEF rendering + keyboard input, the in-client
wiring of the Java server, and the GraalJS debugger end-to-end still need a
real-client test. See [`docs/in-game-plan.md`](docs/in-game-plan.md) and the
per-component READMEs for the open items.

## Templates

The "+ new" picker merges three tiers, keyed by id (later tiers shadow earlier):

1. **Bundled**: the starter projects in [`templates/`](templates/) (`default-ts`,
   `plain-js`, `inject-ts`), plus `lb-ide-host` itself. Read by
   `apps/editor/scripts/gen-templates.mjs` at build time. Always present, offline.
2. **User**: saved via "Save as template" / "Duplicate & edit". Stored on the host
   (needs a bridge).
3. **Fetched**: pulled from a configured source. The default source is this repo's
   published `templates.json`: the `gen-templates` GitHub Action regenerates it
   from `master` on `templates/` changes, and the editor fetches that raw URL at
   runtime (CORS-clean), so template updates don't need an editor redeploy.
   Non-source files (`lbbuild.config.json`, `.vscode/`, dotfiles) are stripped on
   import.

User/fetched tiers are lean-only for now; heavy provisions a project from the
bridge.

## Layout

```
apps/
  editor/         the lean browser IDE (Monaco + esbuild-wasm), deployed to Pages
  editor-heavy/   the heavy editor (from-source vscode-web) + its serving layer
    host/         static deploy build + dev host (COI)
    lb-glue/      web extension: build via core + bridge to the host
    lb-fs/        web extension: provision a workspace from the bridge
    server-java/  JDK-only HTTP+WS bridge + COI static server (in-client capable)
  host/           lb-ide-host: the in-game LB script that opens the lean editor (CEF)
packages/
  lb-ide-core/    the shared build pipeline (both modes consume it)
  lb-inject/      runtime bytecode-injection library (the inject template uses it)
templates/        starter/example script projects (the bundled template tier)
docs/             structure notes + the (historical) design/handoff docs
.github/          CI: build both apps; publish templates.json; deploy lean to Pages
```

> Scope: this is the **development** repo for the IDE + templates. Standalone
> products (e.g. nodeflow) and the typings package (`@wunk/lb-script-api-types`,
> an npm dependency) live in their own repos.

## Develop

Lean editor:

```bash
cd apps/editor
npm install            # postinstall: typings closure + templates + asset links
npm run serve          # http://localhost:8085
npm run verify         # headless end-to-end suite (needs a chromium)
npm run build-dist     # assemble the static dist/ for hosting
```

Heavy editor: the from-source vscode-web build and the static deploy build have
their own recipes. See [`apps/editor-heavy/host/DEPLOY.md`](apps/editor-heavy/host/DEPLOY.md).

In-game host:

```bash
cd apps/host
npm install
npm run package        # builds the lean editor + this script -> release/ + a drop-in zip
# unzip into your LiquidBounce config folder, then `.ide` in-game
```

## CI

- `build.yml`: type-checks + builds the host script and the lean editor on every
  push (artifacts `lb-ide-host` / `lb-ide-editor`); a `v*` tag attaches the host
  `.mjs` to a Release.
- `gen-templates.yml`: regenerates and commits `templates.json` from `master` when
  the template sources or the generator change.
- `pages.yml`: builds the lean editor and deploys it to GitHub Pages on `master`.
