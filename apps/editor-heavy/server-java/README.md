# lb-heavy-server (pure Java, JDK-only)

The one converged server for both heavy-mode serving paths, dependency-free
(only the JDK), so it runs headlessly inside the LiquidBounce client where the
GraalJS-script socket server cannot:

- **Static serving** of the heavy vscode-web bundle over HTTP with cross-origin
  isolation headers (open the editor at `http://localhost:<port>` in Chrome **or**
  CEF — zero mixed content).
- **ScriptManager bridge** over **HTTP** (`/api/*`, same-origin) **and**
  **WebSocket** (the hosted case: a remote `https` editor can't `fetch`
  `http://localhost`, but a `ws://localhost` works).

## Security model

- **WS Origin allowlist** — the handshake rejects any `Origin` not configured
  (`--origins`). Without this, any website could open a socket to the user's
  localhost and run code in their client (cross-site WS hijacking). **Only the
  workbench origin(s) go here — NEVER the webview origin** (the `{{uuid}}.<host>`
  subdomain): webviews must stay outside the allowlist so a compromised webview
  can't drive the bridge. (Verified: a `{{uuid}}.localhost:PORT` Origin → `403`.)
- **Token** — every `/api` request and the WS `hello` frame must carry the
  per-session token (`X-IDE-Token` header / `{t:"hello",token}`). The token is
  never put in a URL.
- **`load`/`repl` require an explicit `userGesture`** — they run code in the
  client, so the editor must flag a genuine user action; auto/background callers
  are refused.

## Build & run (standalone)

```bash
javac -d out src/lbide/*.java
java -cp out lbide.LbHeavyServer \
  --port 8900 \
  --web    <dist>            # static bundle (index.html, out/, devext/, fsext/, typings/, …)
  --token  <session-token> \
  --origins https://cb.2d.rocks         # WS Origin allowlist (comma-separated; empty/absent Origin is always rejected)
  --bridgeBase self|ws://…|<empty> \    # what /lb/config advertises (see below)
  --project demo-proj \
  --projects /path/to/lb-ide/projects   # <id>.json store (mirrors the in-client host)
```

`--bridgeBase` controls what `/lb/config` tells the editor's `lb-fs`:
- `self` — same-origin HTTP bridge (the local-served path; resolved to the
  absolute host root).
- `ws://localhost:<port>` — the WS bridge (baked into a *remote* deploy's
  `/lb/config` so the hosted editor talks back to this local server).
- empty — no live bridge (read-only static demo project).

## Proven (browser, this VM, no CEF/GPU needed)

- **Local-served heavy / HTTP bridge:** editor at `http://localhost:8900` renders
  under COI, `lb-fs` sources the project from `/api/projects`, full `@wunk`
  intellisense.
- **Hosted-https heavy / WS bridge:** page at `https://cb.2d.rocks/liquid-ide`
  connects `ws://localhost:8900` (Origin `https://cb.2d.rocks` accepted), provisions
  the project, intellisense.
- **Security:** a page from a disallowed origin is rejected at the handshake;
  no-token `/api` → 403; `load`/`repl` without `userGesture` → refused.

## In-LB-client integration (follow-up, needs in-game testing)

`main` wires `FileOps` (a projects-dir-backed `Ops`). The in-client build
constructs `new LbHeavyServer(...)` with a **ScriptManager-backed `Ops`**:
`save` → `lb-ide/projects/<id>.json`, `load` → write `<name>.mjs` to
`ScriptManager.root` + `loadScript`+`enable` **on the Minecraft thread**, `repl`
→ eval on the MC thread, and route the live `log(...)` output into
`publishLog(...)`. The HTTP/WS loop is unchanged. Run it on a plain `Thread`
(not a GraalJS callback) so it works headlessly in-client.
