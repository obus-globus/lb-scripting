# 01 — Eclipse Theia

> **One-line verdict:** Architecturally identical to code-server for our pain
> point — no native per-tab isolation; the only official multi-session path
> (Theia Cloud) needs Kubernetes. **Weak fit now.**

## 1. What it is & status

Eclipse Theia is a **framework/platform for building IDEs** (web or desktop),
plus a packaged "Theia IDE" product. Unlike code-server — a thin server-side
repackaging of *the actual VS Code app* — Theia is a **separately-built
application** that shares only the Monaco editor and the VS Code extension
API/protocols (LSP, DAP). You **assemble your own product** from `@theia/*` npm
packages.

Actively maintained in 2025/2026 by the Eclipse Foundation (EclipseSource is the
primary contributor). **Monthly** releases (latest ~1.66, Nov 2025) +
**quarterly Community Releases** (`2025-11`). VS Code extension API compatibility
is current (~1.105.0).

## 2. Isolation model — the key question

**Theia is NOT multi-tenant.** Same single-backend model as code-server: one
browser frontend ↔ **one backend process** over WebSocket/JSON-RPC, design intent
explicitly **"one backend per one user"** (a shared backend is for
*collaboration*, not isolation). **Bare Theia gives no more per-tab isolation
than code-server.**

To get "each session = its own files" you need an **orchestrator that spins up a
separate Theia backend container per session** — exactly the code-server pattern.
The official answer is **Theia Cloud**, which is **Kubernetes-native**: a Java
operator watches Workspace/Session/AppDefinition CRDs; each session deploys two
containers (IDE + `oauth2-proxy`/Keycloak). **No documented plain-Docker mode.**

## 3. Core technical needs

All achievable. Theia uses Monaco + the **same LSP/DAP** as VS Code, installs
extensions from **Open VSX** (⚠ *not* Microsoft's marketplace — MS TypeScript
extension and proprietary ones unavailable, but open TS tooling works):

- **Custom `.d.ts` autocomplete/type-check** — works via `tsconfig.json` + the
  installed `@wunk/lb-script-api-types` package; TS language service resolves
  typings normally.
- **esbuild build + integrated terminal** — full terminal; runs as normal shell
  processes.
- **Debugger on `:9229`** (bonus) — DAP-supported, so a node/GraalJS attach is
  feasible but **least-verified**; treat as "should work, needs a real test."

## 4. Self-hosting feasibility

- **Docker:** yes — `theia-ide`/`theia-apps` provide multi-stage Dockerfiles;
  supported path is to **compose your own product** (don't fork core).
- **Footprint:** per-instance comparable to code-server; per-session isolation
  means **one container per active session** → RAM scales with concurrency
  (same profile as multi-instance code-server).
- **Caddy path routing:** workable but a **known gotcha** — Theia uses
  **socket.io/WebSockets**, and running under a non-root sub-path has historically
  broken socket.io. Must pass WebSocket upgrade headers and configure the base
  path; sub-path + websocket + proxy is the recurring pain point.

## 5. Licensing

**EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0.** EPL-2.0 is weak/file-level
copyleft; self-hosting + building a custom product is fine. Obligations attach to
**modified Theia source files**, not to your own scripts/extensions. Low risk for
an internal self-hosted tool.

## 6. Setup effort & gotchas

- You **assemble and maintain a product build** (npm package set + Dockerfile)
  rather than `docker pull` a finished IDE — more upfront work than code-server.
- Extensions: **Open VSX only** — verify TS tooling is available.
- **Sub-path + WebSocket** proxy config is fiddly under Caddy.
- True per-tab isolation **still requires an orchestrator you build, or k8s
  (Theia Cloud)**.

## 7. Verdict

**Not a strong fit for "low-infra per-tab isolation."** Theia's single-backend
model is the same as code-server's for our specific problem; the only official
multi-session story mandates **Kubernetes**. Theia shines when you want a
**customized, branded IDE product** — which we don't need here.

- **Best fit:** later, if we want a bespoke LiquidBounce-branded IDE with
  built-in commands.
- **Dealbreakers now:** (1) no isolation advantage over code-server without
  building an orchestrator anyway; (2) k8s for the supported multi-session path;
  (3) Open-VSX-only extensions; (4) sub-path/WebSocket proxy friction.
- **Note:** since we'd have to build a per-session spawner regardless, that
  spawner could just launch our **existing code-server image** — likely less
  effort than adopting Theia.

**Uncertainty flagged:** GraalJS-debugger-on-9229 attach plausible via DAP but
unverified; plain-Docker Theia Cloud is undocumented (treat as unsupported);
per-instance RAM not measured.

## Sources

- Theia Community Release 2025-11 — https://eclipsesource.com/blogs/2025/12/11/the-eclipse-theia-community-release-2025-11/
- Theia 1.66 release notes — https://eclipsesource.com/blogs/2025/11/13/eclipse-theia-1-66-release-news-and-noteworthy/
- VS Code vs Theia IDE — https://eclipsesource.com/blogs/2024/07/12/vs-code-vs-theia-ide/
- "one backend per one user" — https://github.com/theia-ide/theia/issues/5573
- Theia architecture — https://theia-ide.org/docs/architecture/
- Theia Cloud architecture (k8s) — https://github.com/eclipse-theia/theia-cloud/blob/main/documentation/Architecture.md
- VS Code extension support / Open VSX — https://deepwiki.com/eclipse-theia/theia/2.4-vs-code-extension-support , https://theia-ide.org/docs/user_install_vscode_extensions/
- theia-ide repo / Docker — https://github.com/eclipse-theia/theia-ide , https://deepwiki.com/eclipse-theia/theia-ide/4.3-docker-image
- WebSocket + reverse proxy issues — https://github.com/eclipse-theia/theia/issues/10853 , https://community.theia-ide.org/t/eclipse-theia-websockets-and-a-reverse-proxy/2187
- License — https://en.wikipedia.org/wiki/Eclipse_Theia
