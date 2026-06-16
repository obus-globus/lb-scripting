// @lb-ide/core - the ScriptManager bridge client (mode + transport agnostic).
//
// Both editor modes talk to the SAME logical ScriptManager API
// (ping/projects/save/load/repl + a live-log stream) over one of two transports,
// auto-selected by the base URL:
//   - HTTP  (base http(s)://… or "")  same-origin / localhost / in-client CEF.
//     Per-session token in the `X-IDE-Token` header (the custom header forces a
//     CORS preflight, so other web pages can't drive the host).
//   - WS    (base ws(s)://…)          the hosted cross-origin case: a remote https
//     editor can't fetch http://localhost (mixed content), but a WebSocket to
//     localhost works. Token is sent in an auth frame (never in the URL).
//
// The high-level methods (ping/projects/save/load/repl) resolve to parsed JSON on
// both transports; the HTTP bridge additionally exposes `call` (raw Response, used
// by the lean editor's apiFetch) and `replStreamUrl`.
//
// @param {{base?:string, token?:string, fetchImpl?:typeof fetch, WebSocketImpl?:any}} o
export function createBridge(o = {}) {
  return /^wss?:/i.test(o.base || "") ? createWsBridge(o) : createHttpBridge(o);
}

function createHttpBridge({ base = "", token = "", fetchImpl = fetch } = {}) {
  const call = (p, opts = {}) => fetchImpl(base + p, { ...opts, headers: { ...(opts.headers || {}), "X-IDE-Token": token } });
  const json = (p, opts) => call(p, opts).then((r) => r.json());
  const post = (p, b) => json(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return {
    base, token, transport: "http", call,
    ping: () => json("api/ping", { method: "GET" }),
    /** List the host's persisted projects (full objects) so heavy opens the same one. */
    projects: () => json("api/projects", { method: "GET" }),
    /** List installed scripts in the client's scripts/ folder (bare array of filenames). */
    scripts: () => json("api/scripts", { method: "GET" }),
    /** Read one installed script's text → {ok, name, content}. */
    script: (name) => json("api/script?name=" + encodeURIComponent(name), { method: "GET" }),
    save: (project) => call("api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(project) }),
    // load/repl run code in the client; `userGesture` flags an explicit user action
    // (the server may require it). Forwarded on both transports.
    load: ({ name, mjs, debug, userGesture }) => post("api/load", { name, mjs, debug, userGesture }),
    repl: (code, opts = {}) => post("api/repl", { code, userGesture: opts.userGesture }),
    /** URL for the live-log SSE stream (token in the query - EventSource can't set headers). */
    replStreamUrl: () => base + "api/repl/stream?token=" + encodeURIComponent(token),
    /** Uniform stream API: open the SSE log stream, invoke cb per line; returns an unsubscribe. */
    subscribeLog: (cb) => {
      const es = new EventSource(base + "api/repl/stream?token=" + encodeURIComponent(token));
      es.onmessage = (e) => { try { cb(JSON.parse(e.data)); } catch { cb(e.data); } };
      return () => es.close();
    },
  };
}

// WS request/response protocol (one socket, multiplexed by request id):
//   client -> {t:"hello", token}                 (auth on connect)
//   server -> {t:"hello", ok, error?}
//   client -> {t:"req", id, op, args}            (op: ping|projects|save|load|repl)
//   server -> {t:"res", id, ok, result|error}
//   client -> {t:"sub"} / {t:"unsub"}            (start/stop log forwarding)
//   server -> {t:"log", line}                    (pushed any time after sub)
function createWsBridge({ base = "", token = "", WebSocketImpl } = {}) {
  const WS = WebSocketImpl || (typeof WebSocket !== "undefined" ? WebSocket : null);
  if (!WS) throw new Error("createBridge(ws): no WebSocket implementation available");
  let ws = null, ready = null, nextId = 1;
  const pending = new Map();      // id -> { resolve, reject }
  const logCbs = new Set();

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      ws = new WS(base);
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token }));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
        if (m.t === "hello") { m.ok ? resolve() : reject(new Error(m.error || "auth failed")); return; }
        if (m.t === "res") { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || "bridge error")); } return; }
        if (m.t === "log") { for (const cb of logCbs) { try { cb(m.line); } catch { /* */ } } return; }
      };
      const fail = (e) => { ready = null; reject(e instanceof Error ? e : new Error("ws closed")); for (const [, p] of pending) p.reject(new Error("ws closed")); pending.clear(); };
      ws.onclose = () => fail();
      ws.onerror = () => fail(new Error("ws error"));
    });
    return ready;
  }
  async function send(op, args) {
    await connect();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ t: "req", id, op, args: args || {} }));
    });
  }
  return {
    base, token, transport: "ws",
    ping: () => send("ping"),
    projects: () => send("projects"),
    scripts: () => send("scripts"),
    script: (name) => send("script", { name }),
    save: (project) => send("save", { project }),
    load: ({ name, mjs, debug, userGesture }) => send("load", { name, mjs, debug, userGesture }),
    repl: (code, opts = {}) => send("repl", { code, userGesture: opts.userGesture }),
    subscribeLog: (cb) => {
      logCbs.add(cb);
      connect().then(() => ws.send(JSON.stringify({ t: "sub" }))).catch(() => { /* */ });
      return () => { logCbs.delete(cb); if (!logCbs.size && ws && ready) { try { ws.send(JSON.stringify({ t: "unsub" })); } catch { /* */ } } };
    },
    close: () => { try { ws && ws.close(); } catch { /* */ } },
  };
}
