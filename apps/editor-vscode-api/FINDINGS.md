# Spike: port to `@codingame/monaco-vscode-api` v33

Goal: a genuine port onto the CURRENT (v33.0.9) vscode-api, to answer the two
crux questions task 1 left open, measure bundle delta, and probe CEF. Findings
separate **verified** (headless Chromium) / **unresolved** / **needs scorpion's
client**. An adversarial review was run; overclaims softened.

## TL;DR
Got the v33 platform building + rendering with **`crossOriginIsolated === true`**
on localhost (the key CEF input) and the iframe worker-extension-host wired. But
**I could not get the bundled `tsserver` to activate** (no `tsserver.web.js`
request) across many configurations — so **crux 1 (tsserver running + accepting
our 12 MB typings) is UNVERIFIED**; I never reached typings injection. A minimal
set (16 overrides) renders an editor but doesn't activate the TS extension; the
demo uses ~62, but I never found the minimum needed. Net: not a clean/quick port
on the evidence so far, and the make-or-break (CEF cross-origin isolation) still
needs the client.

## Verified (headless Chromium, built dist served with COI headers)
- **Install:** ~18 `@codingame/*@33.0.9` packages, `node_modules` 131 MB. Clean,
  no EOL deps (unlike the wrapper's `@20` line).
- **Build works** with this Vite config: alias `@codingame/monaco-vscode-api/vscode/*`
  → its `vscode/src/*`; alias each `@codingame/*/worker.js` (+ the api
  `workers/extensionHost.worker.js`) to physical paths; import workers via
  `?worker&url`; `@codingame/esbuild-import-meta-url-plugin` in optimizeDeps;
  `worker.format:'es'`, `esbuild.minifySyntax:false`. Build ~23 s.
- **Bundle:** 45 MB raw dist; **~5.18 MB gz JS** vs **our 3.05 MB** (~1.7×).
  Largest eager chunk ~2.14 MB gz; `tsserver.web.js` 6 MB (lazy, in worker);
  extension chunk ~2.9 MB; CSS 31 KB gz; ~3.5 MB locale JSON; oniguruma `.wasm`.
  **Not like-for-like:** the 3.05 MB baseline delivers *working* project-wide TS;
  this 5.18 MB build does not yet. A functional comparison would be larger and is
  unmeasured — treat 1.7× as a floor, not an estimate.
- **`crossOriginIsolated === true`** on `http://localhost` with
  `COOP:same-origin` + `COEP:credentialless` (or `require-corp`) +
  `CORP:cross-origin` on every response. Verified true under BOTH COEP modes.
- **Editor renders**, model `languageId === "typescript"`, `initialize()`
  resolves (no JS errors when TextMate is omitted).
- **Worker wiring:** the iframe-based worker ext host needs
  `MonacoEnvironment.getWorkerUrl`/`getWorkerOptions` (returning URL *strings*) +
  `?worker&url` imports — NOT `getWorker` returning a `Worker` instance (that
  fails in the iframe with "extensionHostWorkerMain not defined").

## Round 2 — wholesale demo config (per Koda: prove it CAN activate)
Replicated the demo's full known-good config: **~52 service overrides** (all but
terminal/chat/localization/remote, which need heavy local setup unrelated to TS),
all **7 demo workers**, `workspaceProvider` folder, and opened the doc **through
the vscode API** (`vscode.workspace.openTextDocument` → `showTextDocument`) to fire
`onLanguage:typescript`. Result, still:
- `ready:true`, `crossOriginIsolated:true`, no JS errors, doc `languageId:"typescript"`.
- **`tsserver.web.js` still never requested; no diagnostics.**
- **Concrete blocker found:** `vscode.extensions.all.length === 0` — **zero
  extensions register**, and the extension-host iframe
  (`webWorkerExtensionHostIframe.html`) is **never requested**. So the worker
  extension host isn't loading in this Vite-build + static-serve config; with no
  ext host, no extension (TS, anything) runs, so tsserver can't activate —
  independent of the override set. (Likely the iframe's domain/serving assumption,
  `iframeAlternateDomain`/`EnvironmentOverride`, or COEP-on-iframe handling that the
  demo's dev server provides and my static serve does not.)

Per Koda's stop condition ("if the full demo config still won't activate tsserver
after a genuine attempt, pause and report"), stopping here. The blocker is now
specific: **get the worker-extension-host iframe to load** (so `extensions.all` is
non-empty); tsserver + typings follow from there.

## Round 3 — supported serving (`vite preview`) + demo container/envOptions
To rule out my hand-rolled static server as the confound (it caused false
negatives before), re-ran under **`vite preview`** (serves workers/wasm/iframe +
COI headers the framework's way — confirmed `COOP:same-origin`/`COEP:credentialless`)
AND added the demo's remaining init pieces: a real **container** `<div>` (was
`undefined`), `getWorkbenchServiceOverride()`, and the 4th-arg
**`envOptions = { userHome: '/' }`** (`EnvironmentOverride`).
- **Identical result: `extCount:0`, no `webWorkerExtensionHostIframe.html` request,
  no `tsserver.web.js`, no diagnostics** — `ready:true`, `crossOriginIsolated:true`,
  no JS errors (besides the TextMate oniguruma one).
- **Conclusion: it is NOT my static server.** Under the supported serving model,
  with the demo's container + workbench override + envOptions + ~52 overrides + 7
  workers, the **worker extension host never boots** → zero extensions register →
  tsserver cannot activate. This is a **hard blocker**, not a serving artifact.
- Remaining un-replicated demo pieces (not "EnvironmentOverride/iframe config", so
  out of scope per the agreed plan): IndexedDB user-data providers, full
  `constructOptions.defaultLayout`, a `registerExtension(...)`-based custom ext +
  `getApi()` bootstrap, and `?raw` user config/keybindings files. One of these may
  be what actually triggers ext-host boot — but reaching that is a multi-file,
  open-ended port, not a quick fix.

**Decisive outcome (per Koda's stop condition):** under supported serving, a
faithful-but-not-exhaustive replication of the demo cannot boot the extension
host. Crux 1 (tsserver + 12 MB typings) remains UNREACHED; the blocker is
ext-host boot, upstream of typings.

## Unresolved — the crux
- **`tsserver` never activated.** `tsserver.web.js` was never requested across:
  minimal (8) and fuller (16) service overrides; with and without a registered
  `/workspace` folder + `tsconfig.json`; with and without the TextMate service +
  basics grammar extension; under both COEP modes — all with
  `crossOriginIsolated===true`, `ready===true`, and no JS errors. So I never got
  to inject the 12 MB `@wunk` typings. **This is an incomplete-setup result, not
  proof the platform can't do it** — activation needs additional overrides and/or
  ext-host wiring I didn't replicate (the demo uses ~62; my 16 + folder + tsconfig
  were insufficient). Override *count* isn't the diagnosed root cause; the minimum
  needed is unknown.
- **Secondary:** the TextMate `worker.js` fails to init oniguruma
  (`applyStateStackDiff` undefined) in my build — a worker/wasm packaging issue,
  independent of the tsserver blocker (tsserver didn't activate even without it).

## Needs scorpion's client (CEF make-or-break)
`crossOriginIsolated` works in headless Chromium (same Chromium engine as CEF,
but embedding/header handling differs — hence the checklist) on localhost with
the COI headers. Whether LB's embedded CEF (a) lets the in-process
localhost server's responses carry COOP/COEP/CORP and (b) actually enters
cross-origin-isolated mode is UNVERIFIED. Per the vscode-api docs, without COI you
get only **per-file** TS — our ~6000 cross-file `.d.ts` would not resolve.

### In-client checklist for scorpion
1. Can the in-process localhost server set, on **every** response (html, js,
   wasm, the ext-host iframe html, workers): `COOP: same-origin`,
   `COEP: require-corp` (or `credentialless`), `CORP: cross-origin`?
2. In the CEF page console: is `self.crossOriginIsolated === true`?
3. Does `typeof SharedArrayBuffer !== 'undefined'` there?
4. Do `new Worker(url, { type: 'module' })` and a nested-iframe worker spawn?
5. Does the ext-host iframe (`webWorkerExtensionHostIframe.html`) load same-origin?

## Crux answers
1. **tsserver + 12 MB typings:** NOT achieved in-spike (tsserver didn't
   activate); typings flow unproven. Would need the fuller workbench override set
   + deeper ext-host-activation debugging.
2. **Serving requirements (partly observed, partly inferred from docs/demo since
   TS never ran):** COOP/COEP/CORP (above) on all responses — *observed* (I reached
   COI); secure context (localhost/https); **no** standalone service worker, but
   an iframe-based worker extension host + module workers (in my partial build:
   editor, extHost, textmate, languageDetection, output) served same-origin — the
   working set is likely a superset; `crossOriginIsolated` must be true for
   project-wide types.

## Bundle delta
~5.18 MB gz JS vs our 3.05 MB (~1.7×) — and this is the *minimal* render-only
set; activating TS + the workbench services the demo needs would grow it further.

## Recommendation
Hold. "Hold" follows from one fact alone: the make-or-break dependency (CEF
cross-origin isolation) is unverified — gate any investment on it. Beyond that:
on the evidence so far it's not a clean/quick port — my 16-override set didn't
activate tsserver (minimum unknown, plausibly large; the demo uses ~62), the
minimal render-only bundle is already ~1.7× ours, and the LB pipeline
(Java.type/lb-inject/esbuild/bridge) still bolts on top unchanged. Gate any further investment on the CEF
checklist above passing in scorpion's client. If COI works in CEF, a follow-up
can push tsserver activation with the fuller override set; if not, project-wide
typings (our core value) can't work and the port is moot.
