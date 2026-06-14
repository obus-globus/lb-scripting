# lb-ide

A **browser-based IDE for writing [LiquidBounce](https://liquidbounce.net)
(nextgen, MC 1.21+) TypeScript/JS scripts** — with full type-checking and a real
build, entirely client-side (no backend), and an optional **in-game** mode that
opens the editor inside the Minecraft client and loads scripts straight into
LiquidBounce.

Live (Cloudflare-Access gated): `https://host.example/lb-ide/`

```
app/    the editor (Monaco + esbuild-wasm) — the deployed web app
host/   lb-ide-host: a LiquidBounce script that opens the editor in-game (CEF)
docs/   in-game integration plan
```

## The editor — [`app/`](app/)

Monaco editor with the `@wunk/lb-script-api-types` typings loaded into the TS
worker (real autocomplete + type-checking), and **esbuild-wasm** to bundle a
project into a single `.mjs`, all in the browser. No server, no accounts.

- **Multiple projects** in a tab bar (each its own files, persisted in IndexedDB),
  plus a second tier of **open-file tabs**.
- **VS Code-style file tree** with folders, a "show supporting files" toggle.
- **"+ new" picker** grouped into categories (one per real LB template) — a blank
  project + one project per example script. Includes `lb-ide-host` itself as a
  multi-file example.
- **Build** → matches the template conventions: JVM-type value imports become
  `Java.type("…")`, `import { Inject } from "lb-inject"` inlines the lb-inject
  runtime, type-only imports erased, local imports inlined.
- **Shareable links** — the whole project gzip-encoded in the URL `#` (no backend).
- **Themes** — Dark + a LiquidBounce theme (LB's real `#4677ff` palette).
- **In-client mode** (when opened by `host/`): build & run in client, hot-reload,
  GraalJS debugger, and a typed REPL with live `log()` streaming.

```bash
cd app
npm install            # also generates the typings closure + templates
npm run serve          # http://localhost:8085
npm run verify         # headless end-to-end suite (needs google-chrome)
npm run build-dist     # assemble a static dist/ for hosting
```

## In-game — [`host/`](host/)

`lb-ide-host` is a LiquidBounce script that opens the editor inside the running
client (LiquidBounce's CEF browser) and bridges it to `ScriptManager`, so you can
author, build, and **load a script into the client without alt-tabbing**. It runs
a localhost-only HTTP server (token + Origin gated) serving the editor + a small
API (`/api/load`, `/api/repl`, …). See [`host/README.md`](host/README.md) and the
[in-game plan](docs/in-game-plan.md).

```bash
cd host
npm install
npm run package        # builds editor + script → release/ + lb-ide-ingame.zip
# unzip into your LiquidBounce config folder, then `.ide` in-game
```

## How it builds in the browser

esbuild only bundles; Monaco's TS worker type-checks. The full
`@wunk/lb-script-api-types` package is ~96 MB / 56k `.d.ts`, so the editor ships
only the **transitive closure** a representative script references (~1.2 MB
gzipped), computed at build time via `tsc --listFiles`. The intrinsic browser
limits (real `npm install`, a terminal, the live-client `:9229` debug attach)
stay with the in-game host or a local CLI.

> The repo started as an evaluation of browser-IDE approaches (Theia, Che,
> Monaco+TS-worker, WebContainers); the chosen path is Monaco + esbuild-wasm.
> That exploration lives in the git history.
