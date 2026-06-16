# Heavy LB IDE — deployment

The heavy editor is a **fully static** bundle (the from-source vscode-web build +
our two extensions + the barrel typings). There is **no node server in prod** — the
fronting web server (Caddy) serves the static `dist/` and sets the cross-origin
isolation headers. `server.mjs` is the dev harness only.

## What the prod server MUST provide

1. **Cross-origin isolation headers** on every response under the route:
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Cross-Origin-Embedder-Policy: require-corp`
   - `Cross-Origin-Resource-Policy: cross-origin`
   These are required for `SharedArrayBuffer` → the web tsserver (intellisense). The
   page must be a **secure context** (HTTPS, or localhost) or COI won't engage even
   with the headers.
2. **HTTPS** (TLS terminates upstream/Cloudflare for us; Cloudflare preserves the
   COI headers — verified).
3. **Webview origin isolation (SECURITY).** A VS Code webview must run on a **distinct
   origin** from the workbench: a same-origin webview inherits the editor's trust — it
   could read `/lb/config` + the bridge token and **passes the bridge's WS `Origin`
   check**, i.e. drive the bridge → run code in the client. The build keeps them
   distinct: `webEndpointUrlTemplate` is a `{{uuid}}.<host>` subdomain by default (or
   `LB_WEBVIEW_ORIGIN` if set), never the workbench origin.
   - **Invariants (verified on the local Java server):** `/lb/config` is served with
     **no `Access-Control-Allow-Origin`** → a cross-origin webview's `fetch` is
     browser-blocked; and the WS handshake **rejects** any Origin not in the allowlist
     (a `{{uuid}}.localhost:PORT` webview origin → `403`). **Operator rule: NEVER add a
     webview origin to the bridge `--origins` allowlist.**
   - **Local pure-Java server:** the `{{uuid}}.localhost:<port>` subdomain is a distinct
     origin (Chrome resolves `*.localhost` → loopback), served by the same process; the
     WS allowlist (the workbench origin only) rejects it. No extra config needed.
   - **Hosted (NEEDS scorpion — DNS + cert):** under the shared domain + path, the
     default `{{uuid}}.cb.2d.rocks` is a **sub-subdomain Cloudflare's free cert doesn't
     cover** → webviews fail to load (cert error). They stay isolated (distinct origin,
     no cert) but webview-based UI (e.g. the Welcome walkthrough) won't render. The core
     editor (tsserver + our extensions) uses **no webviews** and is unaffected. To enable
     webviews: provision a **dedicated webview origin** — either a wildcard cert
     (`*.cb.2d.rocks`) for the per-webview `{{uuid}}.` model, or a **single dedicated
     subdomain** (e.g. `cbwebview.2d.rocks`, covered by a `*.2d.rocks` cert if one
     exists) — then build with `LB_WEBVIEW_ORIGIN=https://{{uuid}}.cbwebview.2d.rocks`
     (or `https://cbwebview.2d.rocks` for the single-origin fallback) and add a Caddy
     site/route for it that serves the SAME `dist/` with the COI headers. **This route
     must NOT serve `/lb/config` or `/api` with CORS, and its origin must NOT be in the
     bridge `--origins`.** ⚠ The DNS record + TLS cert for that subdomain are upstream
     (Proxmox-host Caddy / Cloudflare) — **scorpion to provision before this can ship.**

## Build the static bundle

```bash
cd apps/editor-heavy/host
# 1) barrel typings from the lean editor's PINNED @wunk closure (version-locked)
node ../../../packages/lb-ide-core/scripts/gen-barrel.mjs \
  --bundle ../../editor/public/typings-bundle.json --out "$(pwd)/typings/barrel.d.ts"
# 2) build the static dist for the deploy path prefix (Caddy handle_path strips it)
LB_BASE_PATH=/liquid-ide node build-static.mjs
```
`dist/` then contains: `index.html` (baked workbench shell + a runtime origin-fixup
so it's origin-agnostic), symlinks into the vscode-web bundle (`out/ extensions/
node_modules/`), `devext/`+`fsext/` (the lb-glue/lb-fs extension bundles), `typings/`
(the barrel), and `lb/config`+`lb/project.json` (a read-only demo project).

Prereqs: the extension bundles must be built first — `node build.mjs` in
`apps/editor-heavy/lb-glue` and `apps/editor-heavy/lb-fs`. The vscode-web bundle is
at `/home/clawd/obus/vscode-web` (override with `LB_BUNDLE`); rebuild it per
`docs/dual-mode-state.md` §3.

## Caddy route (already live at cb.2d.rocks/liquid-ide)

```caddy
handle_path /liquid-ide/* {
    root * /home/clawd/obus/.../apps/editor-heavy/host/dist
    header {
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Embedder-Policy "require-corp"
        Cross-Origin-Resource-Policy "cross-origin"
    }
    encode gzip
    file_server
}
```
Validate before reload: `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`.

## Follow-up: live project load/save (the ScriptManager bridge)

The deploy renders + builds (intellisense + esbuild build + download), sourcing a
**read-only demo project** from `lb/project.json`. **Live project load/save is NOT
wired** because the ScriptManager bridge (`lb.hostBase`) is a *separate origin* and
there is no live in-client host in web-only mode yet. To enable it: serve a
ScriptManager host (the in-client Java host, or a node stand-in — see
`docs/dual-mode-state.md`) on its own CORS+CORP origin, then set `bridgeBase`/
`bridgeToken` in `dist/lb/config` (or have the host emit them). lb-fs then sources
the project from `GET /api/projects` and writes back via `POST /api/save`.
