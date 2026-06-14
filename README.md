# lb-scripting

Development monorepo for the **LiquidBounce script IDE** — a browser-based IDE
for writing [LiquidBounce](https://liquidbounce.net) (nextgen, MC 1.21+)
TypeScript/JS scripts, with full type-checking and a real build entirely
client-side (no backend), plus an **in-game** mode that opens the editor inside
the Minecraft client and loads scripts straight into LiquidBounce.

The editor is a static site — host it behind any reverse proxy, or run it
locally with `npm run serve`.

```
apps/
  editor/      the browser IDE (Monaco + esbuild-wasm) — the deployed web app
  host/        lb-ide-host: a LiquidBounce script that opens the editor in-game (CEF)
templates/     the script templates (dev assets the editor builds its "+ new" picker from)
docs/          in-game integration plan + structure notes
```

> Scope: this is the **development** repo for the IDE + templates. Finished/
> standalone products (e.g. nodeflow) and the published typings package
> (`@wunk/lb-script-api-types`, an npm dependency) stay in their own repos.

## The editor — [`apps/editor/`](apps/editor/)

Monaco editor with the `@wunk/lb-script-api-types` typings loaded into the TS
worker (real autocomplete + type-checking), and **esbuild-wasm** to bundle a
project into a single `.mjs`, all in the browser.

- Multiple projects (tabs) + open-file tabs; VS Code-style file tree.
- "+ new" picker grouped by category, sourced from [`templates/`](templates/) —
  a blank project + one project per example script (incl. `lb-ide-host` itself).
- Build matches the template conventions (`Java.type(…)` rewrite, `lb-inject`
  inlining, type-only erasure, local inlining).
- Shareable links (project gzip-encoded in the URL `#`), Dark + LiquidBounce
  themes, and an **in-client mode** (build & run, hot-reload, debugger, typed
  REPL with live `log()` streaming).

```bash
cd apps/editor
npm install            # postinstall: typings closure + templates + asset links
npm run serve          # http://localhost:8085
npm run verify         # headless end-to-end suite (needs a chromium)
npm run build-dist     # assemble a static dist/ for hosting
```

## In-game — [`apps/host/`](apps/host/)

`lb-ide-host` opens the editor inside the running client (LiquidBounce's CEF
browser) and bridges it to `ScriptManager`, so you can author, build, and load a
script into the client without alt-tabbing. Localhost-only HTTP server (token +
Origin gated). See [`apps/host/README.md`](apps/host/README.md) and the
[in-game plan](docs/in-game-plan.md).

```bash
cd apps/host
npm install
npm run package        # builds editor + script → release/ + lb-ide-ingame.zip
# unzip into your LiquidBounce config folder, then `.ide` in-game
```

## Templates — [`templates/`](templates/)

The starter/example script projects the editor reads at build time
(`apps/editor/scripts/gen-templates.mjs`): `default-ts` (minimal), `plain-js`,
`starter-ts`, `inject-ts`. Each carries its `src/` (a main + examples) and
supporting files. Editing a template here updates the editor's "+ new" picker.

## CI

`.github/workflows/build.yml` builds both apps self-contained on every push:
type-checks + builds the **host script** (artifact `lb-ide-host`), and installs
+ verifies + builds the **editor** (artifact `lb-ide-editor`). Tags `v*` attach
the host `.mjs` to a Release.
