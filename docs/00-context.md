# 00 — Context: the use case & constraints

## What we're building for

**LiquidBounce** (Minecraft 1.21+ "nextgen") **TypeScript** scripts. The author
workflow:

1. Edit TS, type-checked against the npm package **`@wunk/lb-script-api-types`**
   — custom `.d.ts` typings, currently **v0.38.4**. The package exposes both
   **ambient globals** (`mc`, `Client`, `Setting`, `RotationUtil`, …) and
   **importable modules**.
2. Bundle with **esbuild** → a single self-contained **`.mjs`** per script.
3. Drop the `.mjs` into the LiquidBounce client.

**Advanced workflow** (a minority of users): `npm run dev` → hot-reload into a
**live client** + a **GraalJS debugger** attached over TCP port **9229**.

## What we already have

`../lb-web-ide` — a self-hosted **code-server** (browser VS Code) Docker image
that bootstraps the template, installs deps, gives typed editing + build. Built
and verified working.

**Its limitation (the reason for this research):** code-server is
**single-user / single-backend**. Every browser tab talks to ONE backend over a
WebSocket and shares ONE filesystem. Multiple tabs do **not** get their own
files — on-disk state is shared, only unsaved buffer state is per-tab. See the
discussion that prompted this: we want **each opened tab/session to get its own
isolated files**.

## Hard constraints (the environment)

- **One** Hetzner/Proxmox **Ubuntu 24.04 VM**. Docker available.
- **No Kubernetes** currently running, and standing one up is a large step we'd
  rather avoid.
- Web exposure is via **Caddy doing path-based routing** on **shared domains**
  (`host.example` / `host.example`). **No per-project subdomains** and **no
  wildcard TLS cert** (Cloudflare free-cert limitation). Any option that assumes
  per-workspace subdomains fights this directly.
- "Low infra overhead" is an explicit goal.

## The deciding question

Everything hinges on **what a user actually needs from the session**:

- **Only author → type-check → build a downloadable `.mjs`?**
  → A **browser-only** tool works, and gives per-tab isolation *for free* with
  zero backend (Monaco, WebContainers). The build never touches the game.

- **Need the live-client debug loop** (`npm run dev` → live client + GraalJS on
  `:9229`)?
  → That loop **cannot** run in a browser sandbox (no raw TCP to a local game
  client). It intrinsically needs a **per-session backend** (Theia/Che, or keep
  code-server / a local CLI).

For LiquidBounce, the common case is the former — most authoring is "write typed
code, build the `.mjs`, install it" — which is why the browser-only options are
attractive despite losing the terminal and live-debug features.

## Evaluation axes used in the per-option docs

1. What it is & current maturity (2025/2026).
2. Isolation model — how "each tab its own files" is actually achieved.
3. Can it do our core need: TS editing w/ custom `.d.ts`, esbuild build,
   (bonus) terminal + `:9229` debug.
4. Self-hosting feasibility on our VM (Docker? k8s? Caddy path routing? footprint).
5. Licensing.
6. Setup effort & gotchas.
7. Honest verdict: best-fit scenarios + dealbreakers.
