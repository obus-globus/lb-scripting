# Plan — open the LB Script IDE *in-game* (LiquidBounce CEF)

Goal: a LiquidBounce script that opens our browser editor **inside the running
Minecraft client** (LiquidBounce's embedded Chromium / CEF), so you can author,
type-check, build, and **load a script into the client without alt-tabbing** —
the same in-client-web-UI pattern lb-nodeflow uses.

This is a **plan only**. Nothing here is built yet.

---

## 1. What we're copying from lb-nodeflow (evidence)

lb-nodeflow opens a web UI in-client via LB's CEF backend, by Java reflection
(`src/host/host.ts:707-746`):

```ts
const BBM = Java.type("net.ccbluex.liquidbounce.integration.backend.BrowserBackendManager");
const backend = BBM.INSTANCE.getBackend();
const BV  = Java.type("net.ccbluex.liquidbounce.integration.backend.browser.BrowserViewport");
const BS  = Java.type("net.ccbluex.liquidbounce.integration.backend.browser.BrowserSettings");
const vp  = new BV(0, 0, win.getWidth(), win.getHeight(), true);   // fullscreen
const settings = new BS(0, () => {});                              // 0 = uncapped fps
holder.browser = backend.createBrowser(url, vp, settings, 20, inputAcceptor);
```

…wrapped in a `Java.extend(Screen)` custom MC screen that creates the browser in
`init()`. It is opened by a command (`.nodeflow editor`, `src/host/host.ts:759`),
points the browser at an **in-process HTTP server** it runs on localhost
(`http://127.0.0.1:8790/editor/`, served by `src/host/editorServer.ts`), and the
web UI POSTs changes back to `/apply`, which the host applies on the MC thread.
**No CORS / COOP / auth needed** — CEF treats it as a trusted local context.

We reuse that recipe almost verbatim; only the *payload* differs: NodeFlow applies
a graph to running modules; **we write + load a built `.mjs` script.**

---

## 2. Target architecture

```
 ┌─────────────────────────── Minecraft client (LiquidBounce) ───────────────────────────┐
 │                                                                                          │
 │  lb-ide-host  (a normal LB script, built from the template)                              │
 │   ├─ command `.ide` / keybind  → opens a CEF Screen (BrowserBackendManager.createBrowser)│
 │   ├─ in-process HTTP server on 127.0.0.1:<port>  (GraalJS + java HttpServer)             │
 │   │     ├─ (opt B) serves the editor static assets                                       │
 │   │     ├─ GET  /projects, /scripts        → list saved projects + installed scripts     │
 │   │     ├─ POST /save                        → persist a project to disk                 │
 │   │     └─ POST /load   { name, mjs }         → write <name>.mjs to ScriptManager.root   │
 │   │                                              + ScriptManager.loadScript(...) / reload│
 │   └─ applies on the MC thread via mc.execute(...)                                        │
 │                                                                                          │
 │      CEF browser  ◀──── http://127.0.0.1:<port>/  ────▶  the editor (esbuild-wasm build) │
 │        Monaco + typings + esbuild-wasm  → builds .mjs IN THE TAB → POST /load            │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

Load path is concrete (from `ScriptManager.d.ts`):
`ScriptManager.root: File` (the scripts dir) · `loadScript(file, language, debugOptions)` ·
`reload()` · `unloadAll()`. So **build → write `.mjs` to `root` → `loadScript`** =
the script runs live, no game restart.

---

## 3. Key decisions

### 3a. Which editor edition — **esbuild-wasm, NOT WebContainers**
- The esbuild-wasm editor (`apps/editor/`) builds entirely client-side with **no COOP/COEP,
  no secure-context, no external network** (verified). That fits CEF perfectly.
- The WebContainers app needs cross-origin isolation + a secure context + the
  StackBlitz proxy → unsuitable for the CEF/localhost context. Do **not** use it.

### 3b. How the editor reaches CEF — two options
- **A. Public URL.** Point CEF at a public, no-auth copy of the editor served
  over plain HTTP (so the localhost bridge isn't blocked as mixed content).
  Pros: zero asset bundling, instant updates. Cons: needs network; ~3.7 MB first
  load (cached by CEF after).
- **B. In-process localhost server.** Bundle the editor's `dist/` (~37 MB:
  monaco `vs/`, `esbuild.wasm`, typings) alongside the host script and serve it
  from the java `HttpServer`. Pros: offline, fully self-contained, no public
  hosting. Cons: ships 37 MB with the script; more host code.

  **Recommendation:** build against **A** first (fastest path, mirrors NodeFlow
  dev), then ship **B** for a self-contained release. The editor is already
  base-path-aware (`document.baseURI`), so both work unchanged.

### 3c. Persistence
In a browser tab we use IndexedDB. In CEF, IndexedDB *may* persist per LB's CEF
profile, but to be safe and to make projects visible on disk, the **bridge writes
projects to the LB config folder** (`ScriptManager.root/../lb-ide/`), and the
editor gains a "host bridge" persistence adapter (below). IndexedDB stays as the
fallback when no bridge is present (plain browser use).

---

## 4. Editor changes (the "host bridge" mode)

Mirror NodeFlow's `editor/src/lib/bridge.svelte.js` detection: on load, probe for
the host bridge (e.g. `GET /bridge/ping`). If present (running in-client):
- **Persistence** → read/write projects via `/projects`, `/save` instead of (or
  in addition to) IndexedDB.
- **Build button gains "Build & Load in client"** → after the in-tab esbuild build,
  `POST /load { name, mjs }` instead of (or beside) the browser download.
- **Open installed scripts** → `GET /scripts` lists files under `ScriptManager.root`;
  open them as a project to edit in place.
- **Esc / close** → `POST /close` so the host dismisses the CEF Screen (NodeFlow
  does exactly this).

When no bridge is detected, the editor behaves exactly as today (download `.mjs`,
IndexedDB). So this is additive.

---

## 5. The host script (`lb-ide-host`)

A normal LB TS script (built with our template — dogfooding):
1. `registerScript` + a **command `.ide`** (aliases `.editor`) and/or a module
   with a keybind to open/close the editor.
2. `openEditorScreen(url)` — the `Java.extend(Screen)` + `createBrowser(...)`
   block, copied from NodeFlow, fullscreen viewport, `inputAcceptor` gating input
   to our screen.
3. In-process `com.sun.net.httpserver.HttpServer` (via `Java.type`) on a free
   localhost port, exposing the bridge endpoints in §2/§4 and (option B) the
   static assets. All disk + `ScriptManager` calls marshalled onto the MC thread
   via `mc.execute(...)`.
4. `/load` handler: `Files.write(root/<name>.mjs, mjs)` →
   get the `ScriptManager` instance → `loadScript(file, "javascript", …)`
   (unload first if same name already loaded). Report success/errors back to the
   editor for a toast.

---

## 6. Phases

```
P0  Spike: open CEF → editor, prove Monaco + a build work inside CEF, keyboard
    input included.  ⟶ host code written + type-checks/builds; CEF + KEYBOARD
    still need a REAL client to confirm (the open item).
P1  Host bridge endpoints (ping, load, save, projects) + editor "host bridge"
    mode (Build & Run in client; persist to disk).            ✅ DONE (verified
    headless against a mock host)
P2  Open/edit installed scripts from ScriptManager.root (GET /api/script) +
    disk-backed project persistence (restore on open).         ✅ DONE (headless)
P3  Self-contained packaging: `host: npm run package` → release/ (script +
    editor build) + a ~7.4 MB zip to drop into the LB folder.  ✅ DONE
P4  Polish: keybind, opacity/blur like NodeFlow, error toasts, "unload" command,
    in-host server serves assets so option-A public URL isn't needed.   (todo)
```

The remaining hard dependency is a **real client run** to validate CEF rendering
+ keyboard (§7.1). Everything else is implemented under `../apps/host/` and the
editor’s bridge mode in `../apps/editor/`.

---

## 7. Risks & open questions (tackle in P0)

1. **Keyboard input is the #1 risk.** NodeFlow's editor is mouse-driven; **ours is
   a text editor** needing full keyboard incl. Ctrl/Cmd shortcuts. Must confirm
   LB's CEF Screen forwards *all* keystrokes to the browser (not swallowed as game
   binds), that `Esc` can be handled by Monaco (find-widget) without instantly
   closing the screen, and that IME/modifier combos reach Monaco. Validate in P0
   with a real client before building anything else.
2. **CEF Chromium capabilities** — confirm the bundled CEF supports WebAssembly +
   Web Workers (Monaco worker + `esbuild.wasm`). Modern CEF does; verify the LB
   build's version.
3. **`ScriptManager` instance accessor** — confirm how to obtain it at runtime
   (singleton `INSTANCE` vs via a manager/registry) and the exact `loadScript`
   signature / `ScriptDebugOptions` default.
4. **Asset size in CEF** (option A): ~3.7 MB first paint over network; ensure CEF
   caches across opens. Option B avoids it.
5. **Reload semantics** — loading a freshly-built script of the same name: unload
   the previous instance first to avoid duplicate modules; decide naming.
6. **Security** — `/load` writes + executes a script on the user's machine. It's
   localhost-only and user-initiated (it's their own editor), same trust model as
   `.script load`. Keep the HTTP server bound to `127.0.0.1` only.

---

## 8. Why this is a good fit

- The esbuild-wasm editor already builds a ready-to-load `.mjs` **with no backend**
  — the only missing link is handing that file to `ScriptManager`, which is a
  few lines via the bridge.
- We'd be **dogfooding**: `lb-ide-host` is itself an LB script written with our
  template, and you could even edit *it* in the in-game editor.
- Reuses a proven path (NodeFlow's CEF + in-process server) end-to-end.
