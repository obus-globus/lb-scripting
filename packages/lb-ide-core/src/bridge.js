// @lb-ide/core — the in-client ScriptManager bridge client (mode-agnostic).
//
// Both editor modes talk to the SAME LB host API (the GraalJS-script in-process
// server): a per-session token is sent as the `X-IDE-Token` header on every
// `/api/*` call (the custom header forces a CORS preflight that fails cross-origin,
// so other web pages can't drive the host) and as `?token=` on the SSE stream
// (EventSource can't set headers).
//
// @param {{base?:string, token?:string, fetchImpl?:typeof fetch}} o
export function createBridge({ base = "", token = "", fetchImpl = fetch } = {}) {
  const call = (p, opts = {}) => fetchImpl(base + p, { ...opts, headers: { ...(opts.headers || {}), "X-IDE-Token": token } });
  const json = (p, opts) => call(p, opts).then((r) => r.json());
  return {
    base, token, call,
    /** Host liveness + scripts-root probe → enables "build & run in client". */
    ping: () => json("api/ping", { method: "GET" }),
    /** List the host's persisted projects (full objects, incl. files) → lets the
     *  heavy editor open the SAME project lean saved. */
    projects: () => json("api/projects", { method: "GET" }),
    /** Persist a project to the host's projects dir. */
    save: (project) => call("api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(project) }),
    /** Write <name>.mjs to ScriptManager.root + load (and enable) it. */
    load: ({ name, mjs, debug }) => json("api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mjs, debug }) }),
    /** Eval a snippet in the client (last expression returned). */
    repl: (code) => json("api/repl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }),
    /** URL for the live-log SSE stream (token in the query — EventSource can't set headers). */
    replStreamUrl: () => base + "api/repl/stream?token=" + encodeURIComponent(token),
  };
}
