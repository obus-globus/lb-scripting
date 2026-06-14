# Spike: porting to `monaco-editor-wrapper`

A throwaway scaffold to learn how cleanly our editor would port onto
`monaco-editor-wrapper` (TypeFox, on `@codingame/monaco-vscode-api`), measure the
bundle delta vs our current `dist`, and probe CEF viability. Findings below
separate **observed** from **inferred**; an adversarial review was run and the
overclaims it caught have been softened.

## TL;DR
On the (now-deprecated) stable stack the port is **high-cost and not clearly
worth it**: a larger bundle, a rework of our TS-integration layer, and a runtime
dependency on the vscode extension-host worker loader that I could not get working
under plain static serving — an untested risk for the in-game CEF target. **This is
not a final "no":** I used the deprecated `@6`/`@codingame@20` line and did not
validate the supported `monaco-languageclient@10` path or TS under the supported
serving config. Recommendation: don't invest further now; if we still want parity,
spike `@10` next and specifically answer the two open questions below.

## What was built
Minimal Vite app: `MonacoEditorLanguageClientWrapper.initAndStart({$type:"extended"})`
with one TS file + the bundled `typescript-language-features` extension (in-browser
`tsserver`, no LSP server). No `@wunk` typings injected, no our UI, no esbuild.

## Findings — observed
1. **Package is deprecated.** `monaco-editor-wrapper@6.12.0` prints an npm
   deprecation: *"development will not be continued — use `monaco-languageclient`
   v10+"*, and pulls EOL `@codingame/*@20.2.1`. (Material: it's *why* `@10` exists.)
2. **Buildless is gone; Vite required; didn't build out-of-the-box.** Our AMD
   `vs/loader.js` path is unsupported. First `vite build` failed on a `@codingame`
   export wildcard not resolving (`@codingame/monaco-vscode-api/vscode/vs/...`); a
   manual `resolve.alias` to `vscode/src/...` fixed it. ~910 modules, ~24 s.
3. **Bundle size (total emitted gz JS): 6.16 MB** vs **our current 3.05 MB** —
   i.e. **~2×**, NOT initial-paint, NOT like-for-like split:
   - wrapper: 6.16 MB gz / 20.8 MB raw JS; largest single chunk 1.92 MB gz; `views`
     268 KB gz; `onig.wasm` 466 KB; ~3.5 MB locale `diagnosticMessages*.json`; 102
     assets; `node_modules` 134 MB.
   - ours: 3.05 MB gz / 13.2 MB raw JS total, of which **initial paint ≈ 0.95 MB gz**
     (`editor.main.js` 932 KB + `loader.js` 9 KB + `main.js` 15 KB); the rest is lazy.
   - I did **not** split the wrapper's initial-paint subset, so the fair statement is
     "~2× total transfer"; initial-load delta is unmeasured (its main chunk alone is
     ~1.92 MB gz, ~2× our whole initial paint).
4. **Render works.** Headless Chromium: `.monaco-editor` rendered with TextMate
   highlighting, code shown.
5. **TS server worker failed under naive static serving** (hand-rolled static host,
   COOP/COEP `credentialless`): `Failed to construct 'Worker': Script at
   'extension-file://vscode.typescript-language-features/.../tsserver.web.js' cannot
   be accessed from origin`. This is **expected** for that scheme under a plain host
   — I did **not** exercise the supported extension-host serving (Vite dev / a
   service-worker file provider). So: *TS intelligence under the supported config is
   unverified*, not "broken."

## Findings — inferred (not measured)
- **TS-layer rework.** In `extended` mode the classic
  `typescriptDefaults`/`addExtraLib`/`getTypeScriptWorker` API is gone; typings would
  move to a virtual FS + `tsconfig`, and `registerEditorOpener` is replaced by the
  editor service. Go-to-def/format become built-in (a plus). I did not port this, so
  treat the size of the rework as a reasoned estimate, not a measured outcome.
- **CEF risk — UNVERIFIED.** I never ran CEF. The concern is that the extension-host
  file/worker loading (service worker, blob/module workers, possibly cross-origin
  isolation) may not work on LB's CEF localhost origin. This is inference informed by
  why we previously rejected WebContainers — prior, not proof.
- **Our LB pipeline** (`Java.type` rewrite, `lb-inject` inline, esbuild-wasm →
  `.mjs`, ScriptManager bridge) is independent and would be re-wired on top — the
  port *adds* a platform without removing our existing work.

## Open questions to resolve before any real port (spike `@10`)
1. Does the bundled `tsserver` worker actually load under the **supported** serving
   (Vite dev / service-worker file provider), and can we feed it our 12 MB `@wunk`
   typings via the virtual FS with acceptable perf?
2. Does that extension-host serving work **inside CEF** on a localhost origin without
   COOP/COEP cross-origin isolation? (The make-or-break for in-game.)

## Recommendation
Pause the port. Our current hand-built stack is lean (~0.95 MB gz initial), loads
cleanly, has working TS intelligence in a CEF-compatible form, and already
replicates most of the VS Code feel. Revisit only via a `monaco-languageclient@10`
spike that answers the two questions above — and only if we accept the larger bundle
and the CEF validation work.
