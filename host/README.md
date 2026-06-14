# lb-ide-host — open the LB Script IDE in-game

A LiquidBounce script that opens our browser editor **inside the client** (CEF)
and loads the scripts you build there straight into LiquidBounce — no alt-tab.

Implements the plan in [`../docs/in-game-plan.md`](../docs/in-game-plan.md)
(phases P0–P1). It reuses lb-nodeflow's proven CEF + in-process-server pattern.

## How it works

```
.ide  → opens a fullscreen chrome-less CEF browser (BrowserBackendManager.createBrowser)
        pointed at  http://127.0.0.1:8791/  (served by this script, same-origin)

in-process HTTP server (raw java ServerSocket on an UnsafeThread):
  GET  /                serves the editor build from  <LB root>/lb-ide-editor/
  GET  /api/ping        bridge detection (editor shows "build & run in client")
  POST /api/load        { name, mjs } → write <name>.mjs to ScriptManager.root,
                          ScriptManager.loadScript(...) + enable  (on the MC thread)
  GET  /api/scripts     list installed scripts
  GET  /api/projects · POST /api/save   persist projects to <LB root>/lb-ide/projects/
  POST /api/close       dismiss the editor screen (editor Hide / Esc)
```

The editor (the esbuild-wasm edition in [`../app/`](../app/)) builds the `.mjs`
**entirely in the CEF tab** (no backend, no COOP/COEP needed), then POSTs it to
`/api/load`. The host writes it next to your other scripts and hot-loads it.

## Install

1. **Build the editor** and copy it next to LiquidBounce:
   ```bash
   cd ../app && npm install && npm run build-dist
   # then copy the contents of app/dist/  →  <LB config root>/lb-ide-editor/
   ```
   (`<LB config root>` is the folder shown by `.ide where`; the editor dir sits
   beside `scripts/`.)

2. **Build + install this script:**
   ```bash
   npm install && npm run build          # → dist/main.mjs
   # copy dist/main.mjs into  <LB config root>/scripts/
   ```
   Reload scripts (`.script reload`) or restart the client.

3. In-game:
   ```
   .ide          open the editor
   .ide close    close it
   .ide where    print the editor / scripts / server locations
   ```
   Or toggle the **ScriptIDE** module (Misc).

## Status & caveats

- **Type-checks against the real `@wunk/lb-script-api-types` and builds** (the LB
  API usage — `BrowserBackendManager`, `ScriptManager.loadScript`, the
  `ServerSocket`/`UnsafeThread` server — is verified at the type level).
- **Not yet run in a live client.** The #1 thing to validate there (per the plan)
  is **keyboard input** in the CEF text editor: that LB forwards all keys +
  Ctrl/Cmd shortcuts to the page and that `Esc` reaches Monaco (we set
  `shouldCloseOnEsc → false` so Esc drives the editor's find widget; close via
  `.ide close` / the editor's Hide button → `/api/close`).
- The server binds to `127.0.0.1` only. `/api/load` writes + runs a script on the
  user's machine — same trust model as `.script load`, user-initiated.

## Layout

```
src/main.ts          registerScript + `.ide` command + ScriptIDE module
src/cef.ts           open/close the fullscreen CEF editor screen
src/server.ts        in-process HTTP server (static editor + bridge endpoints)
src/scriptLoader.ts  write .mjs to ScriptManager.root + loadScript/enable
scripts/build.mjs    the template bundler (src → dist/main.mjs)
```
