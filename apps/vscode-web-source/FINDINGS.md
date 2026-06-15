# Spike: build microsoft/vscode "for web" FROM SOURCE

Scorpion's explicit ask: don't take the research's "impractical" at its word —
actually build the real VS Code web from source. **Done. It builds, serves, and
renders headful.** Build tree lives OUTSIDE this repo (~8.4 GB):
`/home/clawd/obus/vscode-build`. Reproduce with `./build.sh`.

## Result: SUCCESS (headful verified)
The genuine **`Code - OSS Dev`** web workbench (vscode **1.125.0**) loads in real
Chromium (Xvfb): Welcome page, Start/Walkthroughs, full activity bar
(Explorer/Search/SCM/Run/Extensions), settings/account, status bar (0 errors).
Screenshot: `headful-vscode-web.png`. `.monaco-workbench` + `.activitybar`
present, **no page errors**. (A few optional built-ins — merge-conflict, git-base,
emmet — show "Activating extension … Not Found" toasts; cosmetic, not built in
this watch config. Core workbench fully functional.)

## What it took (the research's "impractical" was wrong for the run-from-source path)
1. **Node 24.15.0+** required (`.nvmrc`; `build/npm/preinstall.ts` rejects 24.14
   and npm ≥ 12). Installed rootless from the nodejs.org tarball. **This was the #1
   gotcha** — the VM's Node 24.14 hard-fails install.
2. Native deps: `build-essential pkg-config python3 libx11-dev libxkbfile-dev
   libsecret-1-dev libkrb5-dev` (apt).
3. `git clone --depth 1` (313 MB) → `npm install` (~5 min, builds native modules:
   spdlog, native-keymap, node-pty, kerberos) → `npm run watch` (compiles to
   `out/`, "Finished compilation" ~2 min) → `./scripts/code-web.sh` (spawns
   `@vscode/test-web@0.0.76`, serves the workbench).
4. **Port 8080 is taken by this VM's Caddy** → served on **9888** instead.

## Metrics
- vscode version: **1.125.0**
- Build wall time: ~**10–12 min** total (clone ~1, npm install ~5, watch ~2, serve ~0.5).
- Disk: total tree **8.4 GB** (node_modules ~1.8 GB, `out/` 176 MB, + remote node,
  built-in extensions, shallow git). 62 GB free after.
- vs our current editor (`apps/editor`, ~3.05 MB gz JS): this is a different
  universe of size — it's the whole IDE.

## Serving model (the crux for our CEF use case) — NOT yet adapted
- **`code-web` is a Node dev server** (`@vscode/test-web`): it serves the workbench
  HTML/sources AND provides the web extension-host + a `vscode-remote`/memfs file
  provider. **Backend-bound** as run here.
- A **static** bundle is producible via `npm run gulp vscode-web-min` →
  `vscode-web/` (~80–150 MB), servable by any static host — but the static output
  still expects a server origin and an FS/extension-host provider; you must supply
  an in-browser FS provider (what vscode.dev does behind its own backend) for a
  truly client-only deploy. Not attempted yet.
- **Secure context:** `http://localhost`/`127.0.0.1` qualifies (CEF ok). A service
  worker is registered (ext-host resources). **Cross-origin isolation (COOP/COEP)
  not required** for the core workbench (only some WASM/SAB extension paths).

## CRUX TEST RESULTS (typings + cross-file + COI) — decisive
Set up a real workspace (`lb-ws/`: `main.ts` + `tsconfig` + the real 271 MB
`@wunk` package in `node_modules`), served via `code-web`, headful (Xvfb).
**Gotcha first:** `npm run watch` does NOT build the extensions' WEB bundles —
`tsserver.web.js` was missing. Run **`npm run compile-web`** (builds
`extensions/typescript-language-features/dist/browser/typescript/tsserver.web.js`).

1. **DOES THE WEB TS LAYER REQUIRE CROSS-ORIGIN ISOLATION? → almost certainly YES**
   (strong, but N=1 per condition — see caveat). A/B with `tsserver.web.js` present
   in both:
   - `code-web` (no `--coi`, `crossOriginIsolated:false`): **zero diagnostics** even
     after 180s, deliberate per-file error NOT flagged, and **`tsserver.web.js` was
     never even fetched** (network log) — i.e. the server never *started*, not a 404.
   - `code-web --coi` (`crossOriginIsolated:true`, SharedArrayBuffer): **tsserver
     runs and type-checks within seconds** — `Errors: 7`, incl.
     `Type 'string' is not assignable to type 'number'` (my deliberate per-file error,
     which needs no project context → warm-up/serving ruled out).
   - Corroborated by VS Code's own docs: the web `tsserver` uses **SharedArrayBuffer**,
     which only exists when `crossOriginIsolated === true`.
   **Caveat (honest):** one config per condition; the `--coi` flag may change more
   than just the COOP/COEP headers, so I haven't *fully isolated* COI from everything
   it toggles. But the never-fetched signal + the documented SAB dependency make
   "COI/SAB required for tsserver to start" the strongly-supported reading.
   → **If so (very likely), the "no COI needed" advantage does NOT hold for OUR use
   case** — TS intelligence is our core value, so without CEF cross-origin isolation
   on a localhost page, there is no TS. That makes CEF-COI the single make-or-break.
2. **Cross-file resolution: WORKS.** A workspace-local `local-types.d.ts`
   (`declare function localGlobalFn(): number`) resolves cleanly into `main.ts`
   (no "cannot find") — cross-file type resolution across workspace files is fine,
   and go-to-def-class machinery is live.
3. **The 12 MB `@wunk` typings: RESOLVE END-TO-END. ✅ (the prize)**
   First attempt failed only because `@vscode/test-web` doesn't serve `node_modules`
   over the web tsserver's `/vscode-node-modules/` provider. **Worked around it by
   serving `@wunk` as WORKSPACE files** (moved the 271 MB package to `lb-ws/wunk/`,
   mapped `@wunk/lb-script-api-types/*` → `./wunk/*` via tsconfig `paths`, ambient via
   `/// <reference path>`). Under `--coi`, the REAL symbols resolve with NO errors:
   - `registerScript({...})` ✓ (ambient global), `mc.player` ✓ (ambient global),
     `import { Vec3 } from "@wunk/.../Vec3"` ✓ (cross-package), `v.x` ✓ (member).
   - Only diagnostic on the file is my deliberate `Type 'string' is not assignable`
     error (control) + a cosmetic `baseUrl deprecated` note. Screenshot
     `headful-wunk-resolved.png`.
   - **Go-to-def lands across the package:** F12 on `Vec3` opened `Vec3.d.ts` in a new
     tab. Screenshot `headful-gotodef.png`.
   → So our typings DO work in real vscode-web — *provided they're served by a proper
   FS* (workspace files here; in a real deploy, an in-browser FS provider, which
   `@vscode/test-web` is not). The node_modules-virtual-path gap is test-web-specific.
4. **Latency at the real ~6000-`.d.ts` scale: SLOW cold start (~75–81 s).**
   From opening `main.ts` to first diagnostics: **~75 s**; settled at **~81 s** — the
   time for the web tsserver to pull + build the program from the `@wunk` closure over
   the FS the first time. (A trivial workspace-local file diagnoses instantly; the 75 s
   is specifically the 6000-file closure cold start.) After warmup, edits are
   responsive. **This cold-start latency is a real usability concern** for our ~6000
   `.d.ts` and would want mitigation (a pre-built single barrel `.d.ts`, or a faster
   FS than HTTP-per-file).

### Bottom line for the decision
Real VS Code web from source **builds, renders, and runs TS** — but **only under
cross-origin isolation**. For our CEF-on-localhost target that converts the earlier
"COI not required" into **COI IS required**, and whether CEF supports
crossOriginIsolated on a localhost origin is now the single gating question (needs
scorpion's client). Typings resolution works; serving them needs a real FS provider
(test-web won't).

## Open / next (per the task's step 3, only now that it loads)
1. **TS + our 12 MB `@wunk` typings:** does the built-in TS work here, and can we
   inject typings via the memfs/FS provider? (Same crux as the monaco-vscode-api
   path; not yet tested on this build.)
2. **Static client-only feasibility for CEF:** build `vscode-web-min`, serve static,
   wire an in-browser FS provider, headful-test; then test inside CEF (needs
   scorpion's client).
3. **LB pipeline adaptation** (`Java.type` rewrite, `lb-inject`, esbuild-wasm `.mjs`,
   ScriptManager bridge): all bolt-on/independent, but the editor↔build↔bridge glue
   would need re-doing against the full IDE rather than our lean app.

## Honest bottom line
Building + running the REAL VS Code web from source is **feasible and not hard**
(~10 min, one Node-version gotcha) — scorpion's instinct was right. But it's the
**entire IDE** (8.4 GB to build; ~80–150 MB static bundle), dev-server-bound unless
we build the min bundle + supply an in-browser FS, and adapting our lean LB
pipeline onto it is a large re-platforming. Loads great; "ship it in CEF" is a
much bigger question, gated on the static-bundle + in-browser-FS + CEF tests above.
