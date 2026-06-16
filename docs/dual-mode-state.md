# Dual-Mode LB Script IDE — State & Handoff (single source of truth)

Self-contained resume doc. A cold reader with zero prior context should be able to
pick up from here. Companion to `docs/dual-mode-plan.md` (the longer plan; its
§0–§6 are SUPERSEDED de-risking notes — trust this doc + the plan's "✅ DECIDED" block).

Repo: `/home/clawd/obus/liquidbounce-and-stuff/scriptsandstuff/lb-ide-explore`
(a.k.a. "lb-scripting"; GitHub `obus-globus/lb-scripting`).

---

## 1. Product & decisions

A **browser-only IDE for writing LiquidBounce (Minecraft) TypeScript scripts**.
Scripts use the `@wunk/lb-script-api-types` typings (a 6035-file `.d.ts` transitive
closure) + ambient globals (`registerScript`, `mc`, …) + a `Java.type(...)` bridge
to JVM classes. The IDE builds a user's project to a single `.mjs` (in-browser
esbuild-wasm) and loads it into the running LiquidBounce client.

**Two editor modes, user-selectable:**
- **Lean (default, ships today):** the existing Monaco app `apps/editor` — a
  BUILDLESS browser app (`public/main.js`, a classic `<script>`, Monaco AMD loader
  + global esbuild). Cold start ~4.5 s, ~3 MB gz. Typings via Monaco
  `setExtraLibs`. No cross-origin isolation needed.
- **Heavy (opt-in, WEB-ONLY for now):** the real microsoft/vscode "for web" built
  **from source**. Full IDE. Cold start **5.5 s** with the barrel typings. Needs
  cross-origin isolation (COI).

**Decisions (made with scorpion):**
- Heavy = **from-source vscode-web**, built **ON-BOX under a hard 16 GB cap** (no
  off-box runner). Web-only for now; the in-client (CEF) java COI handler is
  DEFERRED.
- **npm `@codingame/monaco-vscode-api` was ABANDONED.** It renders + has COI, but
  its **worker extension-host never boots tsserver** (no type-checking = no value).
  Two real blockers were fixed along the way (platform detection via
  `getExtensionGalleryServiceOverride`; the TextMate worker crash blocking the
  ext-host iframe), but tsserver still never spawned — dropped.
- **Cold-start lever = the ambient-module-per-path BARREL** `.d.ts` (no tsserver
  fork). One script file where each closure file is `declare module
  "@wunk/lb-script-api-types/<relpath>" { …, relative imports rewritten to @wunk
  specifiers }`. Deep imports resolve as ambient modules → **zero per-file FS
  probing**. (Co-location — patching minified `tsserver.web.js` — was the proven
  ~11 s fallback; barrel beats it at 5.5 s with no fork.)
- Lean stays **buildless**; shared pipeline consumed via dynamic `import()`.

---

## 2. Validated gates + evidence (all empirical, this matters)

- **Typings via barrel: 5.5 s, correct.** On real vscode-web (both dev server AND
  the packaged static bundle), opening a `.ts` that imports `@wunk/.../Vec3` +
  uses `registerScript`/`mc`: cold-start 5.5 s, differential correctness
  **clean→0 / 1 planted error→1 / 2 deep-@wunk errors→2**, `v.x` types as `number`
  (not `any`), ambient globals resolve. `tsc --traceResolution` confirms imports
  "resolved as locally declared ambient module … no FS". ~37 FS stat probes
  (vs ~37 000 for the raw 6035-file closure).
- **CEF cross-origin-isolation: GREEN in REAL LiquidBounce CEF** (MCEF 3.3.1, COEP
  `require-corp`): `crossOriginIsolated===true`, SharedArrayBuffer, module/blob/
  nested (ext-host→tsserver) workers, and a two-worker `Atomics.wait`/notify
  round-trip at **~10 µs/hop** — all pass. (Done by an LB script opening the
  built-in `InternetExplorerScreen` at a local server.)
- **In-client serving:** the lb-ide-host's GraalJS-script `java.net.ServerSocket`
  server **does NOT run on the neoforge LB** — `UnsafeThread` callbacks throw
  GraalJS "Multi threaded access … not allowed for js"; an MC-thread poll starves
  CEF's own browser init. **Fix found: a pure-Java `com.sun.net.httpserver.HttpServer`
  + `SimpleFileServer` handler runs in-client cleanly** (no GraalJS, no starvation)
  — serves files but NOT COI headers (needs a ~20-line precompiled Java handler).
  All DEFERRED (heavy is web-only for now; COI comes from the web host).
- **Packaged-bundle gate PASSED end-to-end:** served the static
  `/home/clawd/obus/vscode-web` via `@vscode/test-web` build-mode with `--esm` —
  tsserver.web.js spawns, barrel resolves, 5.5 s, 0/1/2 correctness. Identical to
  the dev server; packaging doesn't regress TS.

---

## 3. Reproduce recipes (exact)

**Node:** the from-source build needs **node 24.15** (system is 24.14); use
`/home/clawd/obus/vscode-build/.build/node/v24.15.0/linux-x64/node`. Prepend its
dir to PATH so child processes use it.

**MANDATORY:** any memory-heavy job runs under `systemd-run --user --scope -p
MemoryMax=<N>G` (hard cgroup cap — verified enforced; box never OOMs). The
`gulp vscode-web-min` MANGLER peaks >16 GB → split + skip it:

```bash
cd /home/clawd/obus/vscode-build
NODEDIR="$(pwd)/.build/node/v24.15.0/linux-x64"
# 1) compile WITHOUT mangling (peak ~6.9 GB)
systemd-run --user --scope -p MemoryMax=16G env PATH="$NODEDIR:$PATH" \
  NODE_OPTIONS="--max-old-space-size=12288" node_modules/.bin/gulp compile-build-without-mangling
# 2) esbuild bundle + minify + package (peak ~8.4 GB) → /home/clawd/obus/vscode-web
systemd-run --user --scope -p MemoryMax=16G env PATH="$NODEDIR:$PATH" \
  NODE_OPTIONS="--max-old-space-size=12288" node_modules/.bin/gulp vscode-web-min-ci
```
Output: `/home/clawd/obus/vscode-web` — **194 MB / ~9.3 MB gz core**, includes
`extensions/typescript-language-features/dist/browser/typescript/tsserver.web.js`.
(no-mangle → still esbuild-minified, marginally larger; full mangle needs >16 GB /
off-box, not worth it.) ~6 min total.

**Serve the packaged heavy bundle (web-only) + verify:**
```bash
# one-time: make test-web serve the LOCAL build (skip its download)
DATADIR=/tmp/twdata; COMMIT=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2   # any 40-hex
echo "$COMMIT" > /home/clawd/obus/vscode-web/version
ln -sfn /home/clawd/obus/vscode-web "$DATADIR/vscode-web-stable-$COMMIT"
# serve (NOTE: --esm is REQUIRED — the build is ESM; --coi for cross-origin isolation)
NODE=.build/node/v24.15.0/linux-x64/node
"$NODE" node_modules/@vscode/test-web/out/server/index.js --host localhost \
  --quality stable --commit "$COMMIT" --testRunnerDataDir "$DATADIR" --esm \
  --extensionDevelopmentPath <glue-ext-dir> <workspace-dir> --port 9888 --coi --browserType none
```
Then load `http://localhost:9888/` in headless/headful Chrome (honors COI headers).

**Barrel generator:** `packages/lb-ide-core/scripts/gen-barrel.mjs` — walks a
`wunk/` closure dir, emits `barrel.d.ts` (pure global script: only `declare module`
blocks; NO top-level imports — a top-level import turns the file into a module and
breaks ambient-module recognition) + a separate `ambient.d.ts` (the globals module,
imports rewritten to @wunk specifiers). **Parameterized** (`--wunk/--out/--pkg/
--ambient` or env `LB_WUNK`/`LB_BARREL_OUT`/…; defaults to the spike tree). A test
workspace exists at
`/home/clawd/obus/vscode-build/lb-barrel` (barrel.d.ts + ambient.d.ts + main.ts +
tsconfig — moduleResolution bundler, no paths mapping).

---

## 4. Current build state

**Branch `feat/dual-mode-ide` @ `001cab4`** (off master, pushed to origin).

**Phase 1 DONE: `@lb-ide/core` extracted** (single-sourced LB pipeline; both modes
consume it). Lean stayed green (headless `verify.mjs` passes after every step);
sub-agent review clean (self-contained ESM, behavior byte-identical). Modules in
`packages/lb-ide-core/src/`:
- `build-plugin.js` — `buildPlugins(files, cfg, injectBundle)`: esbuild plugin
  (JVM value-import→`Java.type(...)`, lb-inject inlining, `@wunk` types-only
  emptying, vfs).
- `build.js` — `runBuild({esbuild, files, cfg, entry, injectBundle})` →
  `{name, code, warnings}`; `DEFAULT_BUILD`, `resolveEntry`.
- `typings.js` — `getClosure(url, fetchImpl)` + `toExtraLibs(closure, extras)`
  (lean RUNTIME adapter). Heavy's adapter is BUILD-TIME (the barrel via
  `gen-barrel.mjs`) — no in-browser `toBarrel()`.
- `bridge.js` — `createBridge({base, token, fetchImpl})`: in-client host-API client
  (`ping/save/load/repl` + `replStreamUrl`, token-headered).
- `package.json` (name `@lb-ide/core`, type module), `scripts/gen-barrel.mjs`.

**Shared vs per-mode:**
- SHARED (in core): build-plugin, build orchestration, typings closure+lean adapter,
  bridge client. (`lb-inject` was already shared at `packages/lb-inject`.)
- PER-MODE (deliberately NOT shared): the **project store** — lean's project-tab
  persistence is interleaved with Monaco models + DOM tabs (IndexedDB
  `dbGet/dbPut/dbDel` + `meta` + `renderTabs`); heavy uses vscode's OWN workspace/FS
  persistence. No shared seam — surfaced, not contorted. (`dbGet/dbPut/dbDel` is a
  trivial KV helper that *could* extract, but heavy won't need browser KV.)
- TYPINGS SEAM is asymmetric: lean adapter = runtime (`setExtraLibs`); heavy = a
  build-time barrel artifact.

**How lean consumes core (buildless):** `main.js` does dynamic
`import("./lb-ide-core/<mod>.js")`. `public/lb-ide-core` is a symlink →
`packages/lb-ide-core/src` (created by `apps/editor/scripts/link-public.mjs`, dev)
and a real copy in prod (`apps/editor/scripts/build-dist.mjs`). It's gitignored.
`DEFAULT_BUILD` is duplicated in `main.js` (UI-authoritative) + `build.js`
(runBuild fallback) — kept in sync via a code comment.

**Phase 2 DONE: heavy glue wired to `@lb-ide/core` + proven end-to-end.**
`apps/editor-heavy/lb-glue/` is now a bundled web extension (`src/extension.js`
→ `dist/extension.js` via `build.mjs`/node-esbuild; `vscode` external; `dist/`
gitignored). On `lb.buildAndRun` it: reads the workspace sources, merges a
per-project `lbbuild.config.json` over `DEFAULT_BUILD`, initializes esbuild-wasm
**in-thread** from a bundled `esbuild.wasm` asset (`wasmModule`, no URL fetch / no
nested worker — survives COEP `require-corp`), runs core's `runBuild`, then hands
the `.mjs` to the host via core's `createBridge` (base/token from `lb.hostBase`/
`lb.hostToken` settings; empty base = build-only). A `lb.selfTestOnStartup`
setting (off by default) gates a headless auto-invoke. **Proven headful in the
packaged `vscode-web` bundle under COI: barrel intellisense (type-error squiggle,
Vec3 resolves) → build via core (154 B `.mjs`, byte-identical to the node
reference) → bridge POST reaches a mock ScriptManager host with the correct
`{name, mjs, X-IDE-Token}` (CORS preflight + CORP both satisfied).** Lean stayed
green (`verify.mjs`); sub-agent review applied (config-honoring + structured
esbuild errors + self-test gating). Commits `6e7e2c5`, `993b9dc`, `ac87f4e`.

Reproduce: serve recipe in §3 (`--extensionDevelopmentPath apps/editor-heavy/lb-glue`,
workspace = `/home/clawd/obus/vscode-build/lb-barrel` whose `.vscode/settings.json`
sets `lb.hostBase`/`lb.hostToken`/`lb.selfTestOnStartup`); harness scripts live in
`/home/clawd/obus/vscode-build/`: `probe-glue.mjs` (activation), `probe-e2e.mjs`
(the 3-way proof), `mock-host.mjs` (the bridge-contract host on :9777).

**Phase 3 DONE: runnable heavy shell + serving layer + lean→heavy switch.**
Heavy is now a real, user-launchable mode (no `@vscode/test-web`). Pieces:
- **`apps/editor-heavy/host/`** — a dependency-free node static host: serves the
  `vscode-web` bundle under COI (COOP same-origin + COEP require-corp), renders the
  workbench shell at `/` with the correct `WORKBENCH_WEB_CONFIGURATION` and the
  build's REAL stylesheet name (`workbench.web.main.internal.css` — test-web links
  `workbench.web.main.css`, which 404s → no theme/codicons; that was the broken
  render). Serves `/devext` (glue), `/fsext` (lb-fs), `/typings` (barrel),
  `/lb/config`. Reads `?project=<id>` → `folderUri` authority. Bootstrap vendored
  from test-web (`web/bootstrap.js`, MIT). Env: `LB_BUNDLE`, `LB_GLUE`, `LB_FSEXT`,
  `LB_TYPINGS`, `LB_PORT`, `LB_BRIDGE_BASE`, `LB_BRIDGE_TOKEN`, `LB_PROJECT_ID`.
- **`apps/editor-heavy/lb-fs/`** — an `lbfs:/` `FileSystemProvider` builtin web
  extension. On activation: derives the host origin from its `extensionUri`, fetches
  `/lb/config`, reads the project id from the folder authority, pulls the project
  from the bridge (`bridge.projects()` → `GET /api/projects`, the SAME api lean's
  `save` writes to), seeds an in-memory FS with the project files + barrel typings
  + a tsconfig that includes them + a `.vscode/settings.json` (so glue's build
  reaches the same bridge), and mirrors writes back via `bridge.save` (debounced).
  Bundled like glue (`dist/` gitignored).
- **`gen-barrel.mjs` parameterized** (`--wunk/--out/--pkg/--ambient` or env);
  byte-identical to the spike barrel. New `bridge.projects()` in core.
- **Lean `open in heavy ↗`** button (shown when `bridgeOn`): persists the project
  via `/api/save` (checks `res.ok`), opens `<heavyUrl>/?project=<id>` (heavyUrl from
  `localStorage["lb-ide:heavyUrl"]`, prompts once).
- **Proven headful on our host** (clean render — VIEWED): bridge-sourced multi-file
  project opens with full `@wunk` barrel intellisense (Vec3.x→number, relative
  import + ambient globals resolve, exactly the planted error squiggle); edit + save
  → `lb-fs` writes back to the ScriptManager (`saved demo-proj`); `LB: Build` → glue
  builds via core → `bridge.load` reaches the host (`load main 246B`). Lean
  regression green; sub-agent review applied (provision-failure recovery, dir
  rename/delete, save-ok check, traversal hardening, token trust-boundary note).
  Commits `2c5e33c`, `3a6fe11`, `90afb8e`, `ef4f97a`, `59a35d5`.

Reproduce: `node vscode-build/dev-scriptmanager.mjs` (a faithful node stand-in for
the in-client host API — GET /api/projects, POST /api/save/load — seeded with
`demo-proj`, on :9777), then `LB_BRIDGE_BASE=http://localhost:9777/
LB_BRIDGE_TOKEN=testtok-123 LB_PROJECT_ID=demo-proj node apps/editor-heavy/host/server.mjs`
(:9900). Harness scripts in `/home/clawd/obus/vscode-build/`: `probe-roundtrip.mjs`
(the 3-way proof), `clean-shot.mjs`/`shot-project.mjs` (headful captures),
`dev-scriptmanager.mjs`. The barrel typings live in `apps/editor-heavy/host/typings/`
(gitignored; regenerate via gen-barrel.mjs against `vscode-build/lb-ws2/wunk`).

---

**Phase 4 DONE: heavy mode is DEPLOYED (static) + prod-prepped.**
- **LIVE at `https://cb.2d.rocks/liquid-ide/`** — a fully static deploy (no node
  server in prod; `server.mjs` is dev-only). Caddy serves `apps/editor-heavy/host/
  dist` and sets the COI headers; **verified end-to-end**: headful render clean
  (`crossOriginIsolated===true`, codicons/theme, the demo project opens with full
  `@wunk` barrel intellisense), and the public path returns the COI headers intact
  through Cloudflare (HTTP/2 200, checked from an external box). Existing Caddy routes
  undisturbed (validated before reload; backup at `/etc/caddy/Caddyfile.bak-*`).
- **`build-static.mjs`** produces the static `dist/` (symlinks the vscode-web bundle,
  bakes the workbench shell with a runtime origin-fixup → origin-agnostic + path-prefix
  aware, stages the lb-glue/lb-fs bundles + barrel typings + a read-only demo project).
  Build: `LB_BASE_PATH=/liquid-ide node build-static.mjs` (see `host/DEPLOY.md`).
- **`gen-barrel --bundle`** now reads the lean editor's pinned `typings-bundle.json`
  (version-locked @wunk closure) — deterministic, byte-identical across sources.
- **`lb-fs`** is base-path-aware (derives host root from its extensionUri) and falls
  back to the static demo project when no bridge is configured. Configurable webview
  origin via `LB_WEBVIEW_ENDPOINT`.
- Commits `85ac84a`, `3f31ae5` (+ docs). Caddy route is in `/etc/caddy/Caddyfile`
  (the `cb.2d.rocks` block), documented in `docs/networking.md` + `host/DEPLOY.md`.

**Phase 5 DONE: converged pure-Java server (HTTP+WS bridge + COI static serving) +
heavy dev-feature parity.** This closes the "live load/save is not wired" follow-up
below for the in-client case, and brings heavy to feature-parity with lean's
in-client dev loop.
- **`apps/editor-heavy/server-java/`** — ONE dependency-free (JDK-only) server that
  both (a) statically serves the heavy vscode-web bundle over HTTP with COI headers,
  and (b) exposes the ScriptManager bridge over **HTTP** (`/api/*`, same-origin) AND
  **WebSocket** (the hosted case: a remote `https` editor can't `fetch http://localhost`
  but a `ws://localhost` works). Files: `LbHeavyServer.java` (raw ServerSocket, hand-
  rolled HTTP parse + static serve + WS handshake/framing + dispatch), `Json.java`
  (minimal JSON), `Ops.java`/`FileOps.java` (the ops seam + a projects-dir-backed impl).
  Runs on plain threads (no GraalJS callbacks) so it works headlessly in-client.
- **Security model (proven both directions):** WS Origin allowlist (rejects cross-site
  WS hijacking — disallowed Origin → 403 at handshake); per-request/per-hello token
  (`X-IDE-Token` / `{t:"hello",token}`, never in a URL); `load`/`repl` require an explicit
  `userGesture` (auto/background callers refused). **NO ACAO/CORS on HTTP** (same-origin
  only) — a P1 fix: `/lb/config` previously served the token under `ACAO:*`, letting any
  site read it + call `load` (RCE). HTTP is now same-origin-only; the hosted path uses the
  Origin-checked WS.
- **WS protocol** (one multiplexed socket): `{t:"hello",token}` → `{t:"req",id,op,args}` /
  `{t:"res",id,ok,result|error}` (ping/projects/save/load/repl) → `{t:"sub"}` →
  `{t:"log",line}`. `createBridge` in core auto-selects HTTP vs WS by `^wss?:` on the base.
- **Heavy dev-feature parity** (`lb-glue`): was build-and-load only; now matches lean's
  in-client dev loop — `lb.toggleHotReload` (status bar, rebuild+reload on save, debounced),
  `lb.repl` (input box → `bridge.repl(userGesture)` → output channel), `lb.toggleLogStream`
  (`bridge.subscribeLog` → "LB Logs" channel), `lb.buildAndDebug` (loads with the GraalJS
  inspector on `:9229` + attach info). `getBridge()` is MEMOIZED by `{base,token}` so the
  WS socket is reused (no socket-per-call leak); hot-reload timer + log disposable cleaned up.
- **Proven (browser, this VM, no CEF/GPU):** local-served heavy / HTTP bridge (editor at
  `http://localhost:PORT` under COI, lb-fs sources from `/api/projects`, full intellisense);
  hosted-https heavy / WS bridge (`https://cb.2d.rocks/liquid-ide` connects `ws://localhost`,
  Origin accepted, provisions + intellisense); security (disallowed Origin rejected,
  no-token `/api`→403, `load`/`repl` without `userGesture` refused). SSE/log stream verified.
- Commits `ae0ac88` (parity), `001cab4` (review fixes: bridge cache, SSE sink lifecycle,
  timer cleanup). README: `apps/editor-heavy/server-java/README.md`.

**⚠ Follow-up (flagged, not blocking):** the live `cb.2d.rocks/liquid-ide` deploy is
still the **read-only static demo** (`dist/lb/config` → `{"bridgeBase":"","bridgeToken":
"","projectId":"demo"}`); it renders + builds + downloads but isn't pointed at a live
bridge. The pure-Java server (Phase 5) is the bridge to point it at: bake the WS base
(`ws://localhost:<port>`) + token into a hosted deploy's `/lb/config`, run the Java
server in-client, and the hosted editor talks back over the Origin-checked WS. The
remaining piece is the **in-LB-client wiring** of that server (below). (Webviews under
the shared-domain path may not isolate — own subdomain needed; core editor unaffected.)

---

## 5. Remaining phases + RESUME POINT

**▶ RESUME HERE — two tracks (the bridge + server now EXIST; what remains is wiring):**

1. **Open reorg (queued next, scorpion to confirm direction):** pull "open installed
   script" out of the New-from-template dropdown into its own **"Open"** section with two
   categories — **Projects** (`lb-ide/projects` sources) and **Installed scripts**
   (`scripts/` compiled `.mjs`). Add `scripts()` / `script(name)` to the bridge client
   (both HTTP + WS). Wire into BOTH modes (lean dropdown + heavy command/picker).
2. **In-LB-client wiring of the pure-Java server (Phase 5 follow-up, needs in-game test):**
   `main()` currently wires `FileOps` (projects-dir-backed). The in-client build constructs
   `new LbHeavyServer(...)` with a **ScriptManager-backed `Ops`**: `save` → `lb-ide/projects/
   <id>.json`; `load` → write `<name>.mjs` to `ScriptManager.root` + `loadScript`+`enable`
   **on the MC thread**; `repl` → eval on the MC thread; route live `log(...)` into
   `publishLog(...)`. HTTP/WS loop unchanged; run on a plain `Thread`. Then bake the WS base
   + token into a hosted `/lb/config` and the live deploy gets real load/save.

Known gaps to revisit (from review, deferred as non-blocking): empty-directory
round-trip fidelity (lb-fs derives dirs from file paths; lean tracks `proj.folders`),
binary files (the project model is text-only by design), the `/lb/config` token
trust boundary (documented in code), and webview isolation under a shared-domain path.

**Later / deferred:** the in-editor debugger
+ stepping UI (old task #8).

---

## 6. Key paths / artifacts

- `/home/clawd/obus/vscode-build` — the microsoft/vscode 1.125.0 from-source tree
  (~8.4 GB, OUTSIDE the repo). `gulp` tasks, `.build/node/v24.15.0`, `lb-barrel`
  (barrel test workspace), `lb-ws2` (the 6035-file closure source), `gen-barrel.mjs`,
  `gen-bundle.mjs`, `profile-tsserver.mjs` (the CDP cold-start/probe profiler).
- `/home/clawd/obus/vscode-web` — the packaged heavy bundle (194 MB, **gitignored,
  reproducible** from §3).
- `apps/vscode-web-source/` (untracked, on the spike branches) — de-risking
  artifacts: `FINDINGS.md`, `cef-coi-smoketest.mjs` (the CEF COI smoke-test, also a
  ready in-client test), `colocation-experiment/` (the tsserver-patch + profiler
  scripts).
- `apps/editor` — the lean editor (verify with `node verify.mjs` under Xvfb DISPLAY=:99).
- Spike branches (de-risking, throwaway): `spike/vscode-from-source`,
  `spike/monaco-vscode-api`, `spike/vscode-web`, `spike/monaco-editor-wrapper`.
