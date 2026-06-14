# 04 — StackBlitz WebContainers

> **One-line verdict:** Real Node + npm + esbuild in-tab, per-tab isolation free,
> runs our *actual* build — **but** closed-source runtime, npm installs proxied
> through StackBlitz, and a **500-session/month free cap**. Compelling for a
> small/OSS audience, **risky as a hosted product**.

## 1. What it is & status (2025/2026)

A Node.js runtime compiled to **WebAssembly that runs entirely inside one browser
tab**. The public `@webcontainer/api` exposes the **runtime only**:
`WebContainer.boot()`, `mount(FileSystemTree)`, a POSIX-ish `fs` API, `spawn(...)`
for processes, events (`server-ready`, `port`). Mature/production-used (powers
stackblitz.com, bolt.new, the Angular/Nuxt/SvelteKit tutorials).

**Browser support:**
- **Chromium (Chrome/Edge/Brave/Vivaldi): full** — the only first-class target.
- **Firefox: alpha** — lacks the cross-origin-isolation mode; preview servers /
  3rd-party assets get blocked.
- **Safari: beta (16.4+)** — needs `Atomics.waitAsync`, lookbehind regex.
- COEP `credentialless` (painless embedding) is **Chromium-only**.

**Cross-origin isolation is a hard requirement** (needs `SharedArrayBuffer`). The
host document must send:
- `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`)
- `Cross-Origin-Opener-Policy: same-origin`

For Caddy these are just two response headers — **but** COOP/COEP **breaks loading
any cross-origin subresource** (CDN scripts, fonts, analytics) unless those send
CORP headers or you use `credentialless` (Chromium-only). **Plan to self-host all
assets same-origin.**

## 2. Capabilities for our workflow

- **`npm install`: yes — but does NOT hit the registry directly from the
  browser.** Package fetches route through **StackBlitz-hosted proxy/acceleration
  infra** (the browser can't make raw outbound connections). So
  `@wunk/lb-script-api-types` resolves from the public registry but **via
  StackBlitz's servers**, not your Caddy. (Custom/private registry only on
  enterprise plans.) The old "Turbo" client was removed Apr 2024; now supports
  npm/pnpm/yarn v1.
- **esbuild: yes** (`esbuild-wasm` runs in-tab) — strong fit for the TS→`.mjs`
  bundle step.
- **`tsc`: yes** (pure JS, runs in Node-in-WASM) for type-checking.
- **Limits:** **no native addons** (`--no-addons`; esbuild/tsc unaffected); **no
  raw TCP, no listening on real ports** (in-container HTTP only via a
  service-worker preview iframe); bounded memory (multiple projects → "Out of
  memory: wasm memory"); cookie/3rd-party-cookie blockers can break boot.

## 3. The editor

WebContainers is **runtime only — no editor.** StackBlitz's own IDE is
**separate/proprietary**, not part of the API. You bring your own UI — **Monaco**
(best here, for `.d.ts` type-checking) or CodeMirror — and wire: editor buffer ↔
`fs.writeFile`/`watch`, a terminal (xterm.js) ↔ `spawn` stdio, a "build" button →
`spawn('npm',['run','build'])`. Preview iframe optional for our bundling case.

## 4. LICENSING — the catch (verified against current ToS)

Real, and likely a dealbreaker for a hosted multi-user tool:

- The `stackblitz/webcontainer-core` GitHub repo is **MIT but is only an issue
  tracker** ("central hub for issues/bug reports") — **NOT the runtime source.**
  The actual runtime is **closed-source.** Don't be misled by that MIT file.
- **Free for:** open-source use cases; "Prototypes or POCs do not require a
  commercial license."
- **License required for:** *"production usage of the API in a commercial,
  for-profit setting"* — i.e. *"using the API to meet the needs of your customers,
  prospective customers, and/or employees."*
- **Hard quota (StackBlitz ToS, verbatim):** *"Customers with active commercial
  StackBlitz plans may integrate the StackBlitz WebContainer API on their website,
  subject to a usage limitation of 500 sessions per month."* Beyond that:
  *"Customers may not exceed this limit without a commercial license."*
- Commercial pricing **unpublished** ("contact sales"). Self-hosted/VPC +
  private registry exist **only on enterprise plans**.
- **Phone-home:** package fetches/acceleration run through StackBlitz's hosted
  proxies → the runtime is **not fully self-hostable offline** on the
  free/standard path. You cannot serve "just static files" and be independent for
  install functionality.

A secondary "10,000 requests/month" figure could **not** be confirmed in primary
ToS text — treat as unconfirmed; the **500 sessions/month** number IS in the
official ToS.

## 5. Self-hosting feasibility

- Serving the **app** is just static files + the two COOP/COEP headers via Caddy
  — confirmed simple.
- **Per-tab isolation: confirmed** (each tab boots its own in-memory WASM FS) —
  exactly what code-server lacks.
- **But not truly self-contained:** installs depend on StackBlitz's proxy infra,
  and any non-trivial multi-user deployment crosses the "commercial/production"
  line + 500-session cap.
- **`:9229` live-client debug is impossible** — no raw TCP from the sandbox; only
  proxied HTTP + preview iframes. WebContainers can produce the `.mjs`, but
  delivering it to the live client + attaching the debugger must happen outside
  the browser.

## 6. Verdict

- **Best fit:** a zero-install, per-tab-isolated **authoring + bundling
  playground** — edit TS against the typings, run real esbuild/tsc in-tab,
  download the `.mjs`. Genuinely solves the shared-filesystem problem and runs the
  real build client-side.
- **Dealbreakers / friction:** (1) **Licensing** — any non-trivial/multi-user
  deployment needs a paid agreement; free tier capped at **500 sessions/month**;
  not independently self-hostable (closed-source + proxied installs). For a free
  community tool this is the biggest risk. (2) **Chromium-only realistically.**
  (3) **The `:9229` workflow can't move into the browser** regardless.

If the goal is purely browser-side isolated editing+bundling for a small/OSS
audience, it's compelling. As a hosted product for many users, licensing +
session cap likely make it impractical without paying StackBlitz.

**Flagged uncertainties:** the "10,000 requests/month" figure is unconfirmed (only
500-session cap verified); commercial pricing unpublished; the precise definition
of a billable "session" is not defined in the ToS.

## Sources

- WebContainer API ref & guides — https://webcontainers.io/api , https://webcontainers.io/guides/browser-support , https://webcontainers.io/guides/troubleshooting , https://webcontainers.io/guides/configuring-headers
- Commercial/licensing — https://webcontainers.io/enterprise , https://stackblitz.com/terms-of-service (500-sessions/month clause) , https://blog.stackblitz.com/posts/webcontainer-api-is-here/
- Browser/COEP — https://blog.stackblitz.com/posts/bringing-webcontainers-to-all-browsers/ , https://web.dev/articles/coop-coep
- Repo (issue-tracker, MIT — not runtime) — https://github.com/stackblitz/webcontainer-core
- Package manager / proxy model — https://developer.stackblitz.com/platform/webcontainers/turbo-package-manager
