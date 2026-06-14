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
  POST /api/load        { name, mjs, debug? } — debug=true loads with a GraalJS
                          inspector (chrome devtools) on :9229
  POST /api/unload      { name } → unload a loaded script
  POST /api/repl        { code } → eval a snippet in the client (last expr shown)
  GET  /api/scripts · GET /api/script?name=   list / read installed scripts
  GET  /api/projects · POST /api/save   persist projects to <LB root>/lb-ide/projects/
  POST /api/close       dismiss the editor screen (editor Hide / Esc)
```

The editor (when in-client) exposes: **build & run in client**, **hot-reload**
(auto rebuild+load on edit), **debug** (inspector), a **REPL** panel (typed
snippets eval'd live), **share links** (project encoded in the URL hash), and
**open installed script**.

The editor (the esbuild-wasm edition in `../editor/`) builds the `.mjs`
**entirely in the CEF tab** (no backend, no COOP/COEP needed), then POSTs it to
`/api/load`. The host writes it next to your other scripts and hot-loads it.

## Install

### Easiest: `npm run package`
```bash
npm install && npm run package
```
Builds the editor + this script and assembles `release/` (and `lb-ide-ingame.zip`,
~7.4 MB). Unzip into your LiquidBounce config folder so you get:
```
<LB config root>/scripts/lb-ide-host.mjs
<LB config root>/lb-ide-editor/...
```
Then `.script reload` (or restart) and `.ide`. (See `release/INSTALL.txt`.)

### Manual

1. **Build the editor** and copy it next to LiquidBounce:
   ```bash
   cd ../editor && npm install && npm run build-dist
   # then copy the contents of ../editor/dist/  →  <LB config root>/lb-ide-editor/
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
   .ide                open the editor
   .ide close          close it
   .ide unload <name>  unload a loaded script by filename
   .ide where          print the editor / scripts / server locations
   ```
   Or **bind a key** to the **ScriptIDE** module (Misc) in the ClickGUI to open
   it with that key. Module settings: **opacity** (20–100% — &lt;100 shows the
   game crisply behind the editor) and **blur** (the MC screen background blur).

## Status & caveats

- **Type-checks against the real `@wunk/lb-script-api-types` and builds** (the LB
  API usage — `BrowserBackendManager`, `ScriptManager.loadScript`, the
  `ServerSocket`/`UnsafeThread` server — is verified at the type level).
- **Not yet run in a live client.** The #1 thing to validate there (per the plan)
  is **keyboard input** in the CEF text editor: that LB forwards all keys +
  Ctrl/Cmd shortcuts to the page and that `Esc` reaches Monaco (we set
  `shouldCloseOnEsc → false` so Esc drives the editor's find widget; close via
  `.ide close` / the editor's Hide button → `/api/close`).
## Security

`/api/load` writes+runs a script and `/api/repl` evals code in the client — so the
server is locked down beyond just binding `127.0.0.1` (which alone does NOT stop a
malicious web page you visit from POSTing to localhost):

- A **per-session token** is minted at startup and embedded in the editor URL
  (`?token=…`). Every `/api/*` route requires it — as an `X-IDE-Token` **custom
  header** (which forces a CORS preflight that fails cross-origin), or as
  `?token=` for the SSE stream (EventSource can't set headers).
- An **`Origin` allow-list** (`http://127.0.0.1:<port>` / `localhost`) is enforced
  on top.
- Static editor file serving is **canonicalized + prefix-checked** (no `..`
  traversal); script filenames are sanitized to a single safe segment.
- `runOnMain` has a **timeout** so a stalled MC thread can't hang/leak handler
  threads.

A cross-origin page therefore can't read the token, can't set the custom header
without a (failing) preflight, and fails the Origin check — so it can't drive the
server. Still user-initiated and local-only by design.

## Layout

```
src/main.ts          registerScript + `.ide` command + ScriptIDE module
src/cef.ts           open/close the fullscreen CEF editor screen
src/server.ts        in-process HTTP server (static editor + bridge endpoints)
src/scriptLoader.ts  write .mjs to ScriptManager.root + loadScript/enable
scripts/build.mjs    the template bundler (src → dist/main.mjs)
```
