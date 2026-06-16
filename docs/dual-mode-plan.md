# Dual-Mode LB Script IDE — Build Plan

> **HISTORICAL planning record.** The dual-mode work described here is merged to
> `master` and shipped (both modes, the shared `@lb-ide/core` pipeline, the
> bridge + Java server). For the current state read the top-level `README.md` and
> the per-component READMEs. This doc is kept for design history; its in-progress
> status notes below are no longer current.

Two editor modes, user-selectable, sharing one LB pipeline:
- **Lean (default):** the existing Monaco app (`apps/editor`). Cold start ~4.5 s, ~3 MB gz JS / ~37 MB dist. No cross-origin isolation needed. Ships today.
- **Heavy (opt-in, web-only):** real microsoft/vscode "for web" from source. Full IDE. Cold start **5.5 s** with the **ambient-barrel typings** (measured, packaged bundle), **194 MB / ~9.3 MB gz core**. Requires COI; CEF COI gate is green for the *external-server* path — **in-client (CEF) COI serving is still unsolved** (see §0 blocker 1), but heavy is **web-only for now** so COI comes from the web host (trivial).

> **The authoritative current truth is the ✅ DECIDED section immediately below.**
> Sections **§0–§6 are SUPERSEDED de-risking-era notes, kept for history only** —
> they were written when the npm substrate, co-location, and off-box build were
> still live options. **Do NOT build from §0–§6**; specifically §3's option list,
> §4a (off-box build / OOM), and §0 blocker 2 are dead. Build from DECIDED + §3's
> "Spike status — DECIDED" sub-block + the Phase notes.
>
> **Not-yet-done (explicit):** the LB pipeline (`Java.type` rewrite, `lb-inject`,
> esbuild-wasm build, ScriptManager bridge) is wired **only into the lean editor** —
> NOT yet into the from-source heavy editor. The `--esm` + COI serving is verified
> only on the `@vscode/test-web` harness, NOT a real in-client/CEF host.

---

## ✅ DECIDED (post-greenlight): heavy = from-source vscode-web, built ON-BOX

scorpion's call: heavy mode = **real vscode-web from source**, **web-only** (selectable), built **on-box under a hard 16 GB cap** (no off-box runner, no OOM). The npm `@codingame/monaco-vscode-api` route was abandoned — it renders + has COI but its **worker extension-host never fully boots tsserver** (platform detection fixed via `getExtensionGalleryServiceOverride`, and removing the crashing TextMate worker let the ext-host iframe spawn, but tsserver still never started; deep wall, dropped).

**Build recipe (fits 16 GB, ~6 min, verified):** the >16 GB hog is the **mangler**, not the minify. Split it + skip mangling:
1. `gulp compile-build-without-mangling` — peak **6.9 GB**.
2. `gulp vscode-web-min-ci` (esbuild bundle + minify + package) — peak **8.4 GB**.
Both under `systemd-run --scope -p MemoryMax=16G`, node 24.15 (`.build/node/`), `NODE_OPTIONS=--max-old-space-size=12288`. Output → `/home/clawd/obus/vscode-web` (**194 MB on disk, ~9.3 MB gz core JS**), includes `tsserver.web.js`. (no-mangle → still esbuild-minified, marginally larger than full-mangle; full-mangle would need >16 GB / off-box, not worth it.)

**Packaged-bundle validation (the gate — PASSED):** served the static `/home/clawd/obus/vscode-web` via `@vscode/test-web` build-mode (`--quality stable --commit <40hex> --testRunnerDataDir` with the build symlinked in + a `version` file; **`--esm` is REQUIRED** — the build is ESM `type="module"`), workspace = the locked barrel. Result on the real artifact: tsserver.web.js spawns, **cold-start 5.5 s**, differential correctness **clean→0 / 1→1 / 2 deep-@wunk→2**, `@wunk` resolves (Vec3 + members + ambient globals `registerScript`/`mc`). Identical to the dev-server result — the packaging doesn't regress TS.

**Cold-start lever:** the **ambient-module-per-path barrel** (`gen-barrel.mjs`) — 5.5 s, no tsserver fork; ships as a `tsc`-driven typings build step. (See §3.)

**Next:** dual-mode build phases, `@lb-ide/core` extraction first.

---

## 0. Critical pre-greenlight blockers (added after adversarial review)

These three must be **verified/answered before** committing to the build — each can invalidate heavy mode if wrong:

1. **The real in-client host must emit COI headers — DONE (code), and a BIGGER blocker surfaced while validating.**
   - *COI headers:* `server.ts`'s `writeResp()` now emits COOP `same-origin` + COEP `require-corp` + CORP `cross-origin` on every response (committed). CEF honors COI response headers from a localhost server regardless of the serving program (proven green via the Node smoke-test; CEF parses headers identically), so once the host serves with these headers, `crossOriginIsolated` will be true in-client. ✅ (header fix correct).
   - 🔴 **NEW BLOCKER — the in-client host server does NOT run on this neoforge LB.** Attempting to run it (patched host, built + installed) throws **`java.lang.IllegalStateException: Multi threaded access … not allowed for language(s) js`** on the `UnsafeThread` accept loop (GraalJS is single-threaded on this build) → the `ServerSocket` is GC'd → CEF gets `ERR_CONNECTION_REFUSED`. A fallback that polls a `ServerSocketChannel` on the **MC/render thread** (via self-requeuing `mc.execute`) instead **starves the render-thread task queue and breaks CEF's own integration-browser init** (`Timed out waiting for integration browser to initialize`, reproduced). So on neoforge, **neither thread option works for a GraalJS-script in-process server** — this breaks the lb-ide-host serving pattern that serves *both* editor modes + the `/api` bridge in-client.
   - ✅ **RESOLVED (serving): a pure-Java `com.sun.net.httpserver.HttpServer` + `SimpleFileServer.createFileHandler` works in-client.** Tested in real LB CEF: page loads (HTTP 200), module + blob workers PASS, **zero multi-thread-guard exceptions, zero integration-browser starvation** — because the accept loop AND the file handler are Java objects that never enter the single-threaded GraalJS context. This is the serving mechanism for in-client; the broken `UnsafeThread`/GraalJS-script server must be retired on neoforge.
   - ⚠️ **Heavy-mode COI still needs one more piece:** `SimpleFileServer`'s built-in handler does NOT emit COOP/COEP (confirmed: `crossOriginIsolated=false`, `SharedArrayBuffer is not defined` in that test), and adding them via a JS `HttpHandler`/`Filter` re-enters GraalJS → the guard. **Fix: ship a tiny precompiled Java helper** — an `HttpHandler`/`Filter` (≈20 lines) that delegates to the file handler and sets COOP `same-origin` + COEP `require-corp` + CORP `cross-origin` (and can host the `/api` bridge, calling `ScriptManager` directly — all Java, no GraalJS). Bundle it as a small `.jar` with the host. **Alternative:** serve heavy from a hosted URL (COI from the web host) — no in-client server needed for heavy at all (§4b).
   - **History:** no evidence lb-ide-host ever served on neoforge (no `:8791` load in any prior log) → this is a **never-validated neoforge gap, not a regression** (it was likely only run on fabric LB). LB exposes no obvious `cefQuery`/message-router bridge; its own UI uses an internal Netty REST server.
   - *Note:* the **external** Node-server + `InternetExplorerScreen` path works fine in CEF (that's how the COI green was obtained) — the original failure was specific to running the server *from a GraalJS script* in-client.
2. **Off-box build RAM is unproven (see §4a).** `vscode-web-min` peaked ~23 GB; GitHub-hosted runners are ~16 GB → it will OOM *harder*. "Large runner" must name a concrete 32/64 GB GitHub *larger runner* or self-hosted machine, and **one build must be demonstrated green there** before sequencing step 3 unblocks.
3. **Service-worker / COI coexistence on a shared origin (see §1).** VS Code web registers a service worker; COI is document-wide. Serving COI-free lean and COI-on heavy on one origin risks SW-scope collisions and COI-poisoned cache. **Decision: give each mode its own origin/port in-client** (cheap with this host) to sidestep it.

---

## 1. Mode-switching architecture

**Principle:** the two editors are *separate static web apps* that never run simultaneously; "switching" = reloading into the other app. They share state through the LB pipeline's project store, not through a live runtime bridge.

- **Selection surface:**
  - *In-client (CEF):* the host script picks the mode (a host setting / two commands `.ide` and `.ide heavy`, or a toggle in the editor UI that reloads). The host's in-process server serves whichever app's `dist/` the user chose.
  - *Hosted web:* two routes (`/` lean, `/full` heavy) or a persisted `localStorage` preference + a "switch mode" button that reloads.
- **Coexistence (REVISED per review):** **each mode gets its own origin/port in-client** (e.g. lean on `:8791`, heavy on `:8792`) rather than two paths on one origin. Rationale: COI is *document-wide* and VS Code web registers a **service worker** (shared registration origin); colocating a COI-free lean app and a COI-on heavy app on one origin risks SW-scope collisions and a SW caching COI-incompatible responses that poison `crossOriginIsolated` on reload. Separate ports make the header policy per-origin-clean and are trivial with the in-process host. Lean stays the default and the only one that loads with zero COI / zero network.
- **State hand-off on switch:** the currently-open project (files + build config) is persisted by the shared project store (the existing `localStorage`/share-link-hash mechanism, or the host's `/api/projects`). On reload into the other mode, the same project is rehydrated. No in-memory transfer needed.
- **Why not embed heavy inside lean / one app with a toggle:** the two have incompatible loading models (AMD `vs/loader` buildless vs a bundled VS Code workbench with a service-worker + COI). Keeping them as separate apps behind one host is simpler and lets lean stay COI-free.

---

## 2. Shared LB pipeline — the real value, must NOT fork per mode

Today these live inside `apps/editor`. They must be extracted into a framework-agnostic **`@lb-ide/core`** package consumed by *both* editor shells. Each editor shell only owns its UI + how it feeds files to *its* TypeScript host.

| Pipeline piece | Shared form | Per-mode adaptation |
|---|---|---|
| **Typings closure** | one producer of `typings-bundle.json` (the 6035-file `@wunk` closure) | lean: `typescriptDefaults.setExtraLibs`; heavy: FS provider + co-located in-worker store |
| **`Java.type` rewrite** | one esbuild plugin (rewrites `import {X} from "@wunk/.../X"` → `Java.type("…")`) | identical in both |
| **`lb-inject`** | the vendored runtime shim package | identical (already shared/vendored) |
| **esbuild-wasm build** | one module: input files → bundled `.mjs` | identical — editor-agnostic |
| **ScriptManager bridge** | one client module (`/api/load`, `/api/save`, `/api/repl`, `/api/unload`, `/api/scripts`, `/api/projects`) + one host implementation | both editors POST to the same host API |
| **Project store** | one module (persist/list/load projects, share-link hash) | identical |

**Deliverable:** refactor `apps/editor` to consume `@lb-ide/core`; build `apps/editor-vscode` (heavy shell) consuming the *same* `@lb-ide/core`. The editor-specific surface is small: the UI shell + the TS-host feed. Everything that is "LB-ness" is shared and single-sourced.

---

## 3. Cold-start lever decision (heavy mode only)

The ~70 s → ~11 s win comes from killing ~12 k synchronous cross-worker FS resolution probes (root-caused: it's hop *count*, not type-checking; not config-fixable — 7 tsconfig levers were null).

- **Co-location (PROVEN, ~11 s):** patch the bundled `tsserver.web.js` FS host shim to serve reads/stats from an in-worker preloaded map (and answer negative stats locally for the workspace virtual schemes). Cost: a small, *anchored* transform on minified vendored code, maintained in our vscode-web build. Since heavy mode already builds vscode-web from source, this is incremental. Risk: re-verify on each vscode bump → mitigate with a scripted patch (like `patch_tsserver.py`) + a CI check that it still applies + the correctness differential test (0/1/2 planted errors).
- **Barrel (NO-fork, UNPROVEN):** ship the closure as one (or few) `.d.ts` files so tsserver issues a handful of FS ops. **Must be the ambient-`declare module`-per-path form** — a naive single-entry roll-up only cuts *reads* (→ ~41 s), not the *resolution probes* (→ stays ~70 s-ish at the probe layer). Risk: preserving deep-import specifiers (`@wunk/.../Vec3`), ambient globals (`mc`, `registerScript`), go-to-def landing in the barrel, diagnostics parity.
- **FS-provider cache / TS-Server-plugin (NO minified-patch, UNPROVEN — added per review):** instead of patching minified `tsserver.web.js`, implement the in-worker/batched FS at the *vscode layer* — a custom `FileSystemProvider` that batches/caches, or a TS Server plugin. Survives vscode bumps (no anchored binary patch), but unverified that it can intercept the tsserver↔ext-host sync bridge at the right layer. Upstreaming the host-shim fix is a fourth, slowest option.

**Spike status — DECIDED: the barrel WINS (no-fork, beats co-location).**
- ✅ **Ambient-module-per-path barrel — MEASURED in real vscode-web, stock tsserver:** **cold-start 5.5 s (N=2), ~37 total FS stat probes (down from ~37k), differential correctness clean (0 planted → 0 squiggles, 1 → 1, 2 deep-@wunk → 2; `v.x` typed `number`).** `tsc --traceResolution` confirms deep imports "resolved as locally declared ambient module … no FS". It **beats co-location (~11 s)** because collapsing 6033 files → 1 barrel kills *both* cost buckets: the ~12k per-import probes (now ambient, no FS) AND the ~25k per-file workspace re-stats (one file to stat). The 5.5 s ≈ the pure compiler floor (the single 12 MB `.d.ts` parse cost is already included and fine). **No tsserver fork — ships as a typings-build step.**
  - *The earlier "35.6 s / refuted" result was an INVALID test:* a generator bug appended `ambient.d.ts`'s top-level `import`s, turning the barrel into an ES module → `declare module` blocks became FS-resolved augmentations. Fixed by keeping `barrel.d.ts` a pure **global script** (only `declare module` blocks; no top-level imports/exports) + rewriting `declare module "…"` specifiers. `gen-barrel.mjs` (fixed) saved to `colocation-experiment/`.
  - *Remaining packaging detail (small, not yet done):* this core test EXCLUDED the **ambient globals** (`mc`, `registerScript`, ScriptModule augmentations) to keep the file a script. For the real product they must be added back **without** top-level imports — convert `ambient.d.ts`'s `import {X} from "@wunk/…"` to inline `import("@wunk/…").X` type refs (or a `declare global` section). Negligible perf cost expected; must re-verify correctness.
  - *Caveat:* go-to-def lands in the barrel file (not the original per-API `.d.ts`) — acceptable for an API-types package (note for users); a sourcemap could restore per-file GTD if ever needed.
- **Co-location (~11 s) → FALLBACK.** Proven, but requires maintaining a patch to minified `tsserver.web.js` across vscode bumps. Only use if the barrel hits a real blocker.
- **FS-provider-cache (ext-host) — rejected:** leaves the cross-worker hop intact (~41.5 s, already measured).

**Recommendation: ship the barrel as the cold-start lever** (a `tsc`-driven typings-build step that emits one ambient-module script `.d.ts` from the `@wunk` closure). Nothing to maintain in the vscode build; stock tsserver. Finish the ambient-globals packaging + re-verify, then it's done. Dedup / disabling project-wide auto-import indexing are no longer needed (probes already ~0).

---

## 4. The two hard practical problems (called out honestly)

### (a) Producing & shipping the static vscode-web bundle — REAL BLOCKER
`npm run gulp vscode-web-min` (the static bundle producer) **peaked ~23 GB and OOM-killed this 58 GB box once already** (took down the controller). We must not run it here again.
- **RAM reality (per review):** standard **GitHub-hosted runners are ~16 GB — LESS than this box**, so a ~23 GB `vscode-web-min` will OOM *harder* there. "Large runner" must mean a **named, provisioned 32/64 GB GitHub *larger runner* (paid) or a self-hosted machine** — not a default runner.
- **Options:** (1) **Build off-box on a named ≥32 GB runner**, publish the static bundle + typings as a versioned release artifact. Bundle rebuilt rarely (per vscode bump). (2) On-box capped + serial: `systemd-run -p MemoryMax=…` + reduced gulp parallelism + Node `--max-old-space-size`, possibly **skip minification** (but that inflates §4b's 150 MB). Risk: may still exceed/be very slow; the OOM was the minifier. (3) Dev (non-min) output — dev-server-bound, still needs static packaging.
- **Recommendation:** **build OFF-BOX on a named ≥32 GB runner; publish as a release artifact** (co-location/FS patch applied as a post-build CI transform). **Before greenlighting sequencing step 3, demonstrate ONE green build on the chosen runner — do not assume the RAM.** Never run `vscode-web-min` on this box.

### (b) ~80–150 MB heavy weight & the CEF/in-game deploy
Lean dist is ~37 MB (monaco + `esbuild.wasm` + typings). Heavy vscode-web static is ~80–150 MB + the typings closure. Shipping that *inside* an LB script package is a lot (disk, any marketplace size limits, load).
- **Options:** (1) **Heavy = fetch-on-demand:** the host downloads the ~150 MB bundle from a release URL into the LB folder on first heavy-mode open, then serves it locally (CEF caches). One-time network, offline thereafter. (2) **Heavy = hosted-only:** point CEF at a hosted full-build URL (like lean's GitHub Pages but the full app); needs network on first load, CEF caches after. (3) Ship in-package (rejected: too heavy for the script zip).
- **Recommendation:** **lean ships in the script package** (offline, default); **heavy is fetched-on-demand** by the host (download once → serve locally), with a **hosted-web heavy build** also available for browser-only users. Keeps the shipped LB script small. **Add: a checksum + version pin on the downloaded bundle** (supply-chain + corruption safety), and confirm the host's raw `ServerSocket` can stream 150 MB of many small assets without loading each fully into heap per request (it currently `readAllBytes` per file — fine for many small files, but verify under load).

---

## 5. Open questions / risks to resolve before/at greenlight

1. **esbuild-wasm under COI.** Lean runs esbuild-wasm with *no* COI; heavy runs under COI (`require-corp`). The build pipeline (esbuild-wasm worker + wasm) must work in *both* contexts — under `require-corp`, the wasm/worker resources must be CORP-compliant. **Verify esbuild-wasm builds correctly inside the COI heavy shell** (integration risk; cheap to test once the heavy shell loads).
2. **vscode version pinning** (currently 1.125.0) + the co-location patch's maintenance cadence.
3. **Go-to-def / hover parity** between modes (heavy lands go-to-def in real `.d.ts`; lean already works; barrel would land in the barrel file — acceptable for an API-types package but note it).
4. **`@lb-ide/core` API surface** — pin it before building the heavy shell so the shared glue is truly single-sourced. (Caveat per review: feeding files to a real tsserver-over-FS-provider vs `setExtraLibs` may leak more mode-specific complexity into "core" than hoped — validate the abstraction is genuinely thin during extraction.)
5. **Heavy-mode cold start on *real* scripts** — the ~11 s was a trivial 8-line `main.ts` (N=2); larger scripts raise the compiler floor. **Set a budget (e.g. ≤15 s) and measure a realistic multi-hundred-line script before committing.**
6. **Licensing (added per review):** shipping a *modified* VS Code build is fine for the MIT-licensed code, but the **"Visual Studio Code" name/marks/marketplace are NOT** — must rebrand (Code-OSS-style) and not use the MS marketplace. Confirm before distributing.

---

## 6. Recommended sequencing (when greenlit)

1. **Barrel spike** (decides §3; no fork if it works). Lightweight, uses the existing harness.
2. **Extract `@lb-ide/core`** from `apps/editor` (no behavior change to lean).
3. **Off-box CI job** to produce the vscode-web static bundle + apply the co-location patch (resolves §4a).
4. **Build `apps/editor-vscode`** (heavy shell) on `@lb-ide/core`; wire the chosen cold-start lever.
5. **Verify esbuild-wasm under COI** (§5.1) early in step 4.
6. **Mode-switch + fetch-on-demand host wiring** (§1, §4b).
7. End-to-end: build a script in heavy mode in-client → `/api/load` → runs in LiquidBounce.
