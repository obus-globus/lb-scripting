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
imports rewritten to @wunk specifiers). **Paths are hardcoded to the spike tree
(`/home/clawd/obus/vscode-build/lb-ws2/wunk` → `/home/clawd/obus/vscode-build/lb-barrel`)
— parameterize when wiring the heavy build.** A test workspace exists at
`/home/clawd/obus/vscode-build/lb-barrel` (barrel.d.ts + ambient.d.ts + main.ts +
tsconfig — moduleResolution bundler, no paths mapping).

---

## 4. Current build state

**Branch `feat/dual-mode-ide` @ `ac87f4e`** (off master, pushed to origin).

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

---

## 5. Remaining phases + RESUME POINT

**▶ RESUME HERE — Phase 3: the runnable heavy SHELL + mode-switch/serving layer.**
The glue↔core seam is proven; what's left to make heavy a *real, user-launchable
mode* (today it's only exercised via `test-web` + the headless probes):
1. **A serving layer** that hosts the static `vscode-web` bundle with the COI
   headers (COOP same-origin + COEP require-corp), opens the user's project
   workspace, and loads the glue extension — without `@vscode/test-web` (that's a
   dev harness). Lean default / heavy opt-in; **separate origins/ports** to avoid
   service-worker + COI coexistence issues. Decide how the heavy workspace + barrel
   typings are provisioned (an in-browser FS seeded with the user's files + the
   generated barrel).
2. **Parameterize `gen-barrel.mjs`** (paths are hardcoded to the spike tree — see
   §3) and wire the barrel generation into the heavy build/provisioning so a real
   project gets `@wunk` typings.
3. **Mode switch UI** from the lean editor (open-in-heavy) + carrying the project
   across.

**Later / deferred:** in-client (CEF) heavy — the pure-Java `HttpServer` + ~20-line
COI handler (so the LB client itself serves the COI bundle); the in-editor debugger
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
