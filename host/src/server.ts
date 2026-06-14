/// <reference types="@wunk/lb-script-api-types/ambient" />
//
// In-host HTTP server for the IDE: serves the editor's static build from
// <LB root>/lb-ide-editor/ AND the bridge endpoints the editor calls. Same
// origin (http://127.0.0.1:<port>/) so there's no CORS / mixed-content problem,
// and it works offline. Adapted from lb-nodeflow's editorServer.ts.
//
// Threading: GraalJS runs JS only on the MC thread or an UnsafeThread. We run a
// raw java.net.ServerSocket accept loop on an UnsafeThread; each connection on
// its own UnsafeThread. /api/load hops to the MC thread (ScriptManager must run
// there) and waits on a CountDownLatch for the result.

declare const Java: { type(name: string): unknown };
declare const UnsafeThread: { run(fn: () => void): unknown };

import { loadBuiltScript, listScripts, readScript, scriptsRoot, type LoadResult } from "./scriptLoader";

type Jany = { [k: string]: unknown } & ((...a: unknown[]) => unknown);
const T = (n: string): Jany => Java.type(n) as unknown as Jany;
const Topt = (n: string): Jany | null => { try { return T(n); } catch { return null; } };

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8", svg: "image/svg+xml",
  ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2",
  png: "image/png", ico: "image/x-icon", map: "application/json",
  wasm: "application/wasm", txt: "text/plain; charset=utf-8",
};

function jbytes(s: string): unknown { return (new (T("java.lang.String") as unknown as new (s: string) => { getBytes(cs: string): unknown })(s)).getBytes("UTF-8"); }
function jbytesLatin(s: string): unknown { return (new (T("java.lang.String") as unknown as new (s: string) => { getBytes(cs: string): unknown })(s)).getBytes("ISO-8859-1"); }

/** LB config root (sibling of scripts/), where we keep lb-ide-editor/ + lb-ide/. */
function lbRoot(): string | null {
  try { return String(((Client as unknown as { configSystem: { rootFolder: { getAbsolutePath(): unknown } } }).configSystem.rootFolder.getAbsolutePath())); } catch { return null; }
}

interface Req { method: string; path: string; query: Record<string, string>; body: string }
function readRequest(ins: { read(): number; readNBytes(n: number): unknown }): Req | null {
  try {
    const BAOS = T("java.io.ByteArrayOutputStream");
    const head = new (BAOS as unknown as new () => { write(b: number): void; toByteArray(): unknown })();
    let s = 0, b: number, n = 0;
    while ((b = ins.read()) !== -1) {
      head.write(b);
      if ((s === 0 && b === 13) || (s === 2 && b === 13)) s++;
      else if ((s === 1 && b === 10) || (s === 3 && b === 10)) s++;
      else s = (b === 13) ? 1 : 0;
      if (s === 4) break;
      if (++n > 65536) return null;
    }
    if (s !== 4) return null;
    const Str = T("java.lang.String") as unknown as new (b: unknown, cs: string) => { split(re: string): string[] };
    const text = String(new Str(head.toByteArray(), "ISO-8859-1"));
    const lines = text.split("\r\n");
    const first = (lines[0] ?? "").split(" ");
    const method = (first[0] ?? "GET").toUpperCase();
    const rawPath = first[1] ?? "/";
    let contentLength = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? ""; const c = line.indexOf(":"); if (c < 0) continue;
      if (line.slice(0, c).trim().toLowerCase() === "content-length") contentLength = parseInt(line.slice(c + 1).trim(), 10) || 0;
    }
    const qm = rawPath.indexOf("?");
    const path = qm < 0 ? rawPath : rawPath.slice(0, qm);
    const query: Record<string, string> = {};
    if (qm >= 0) for (const kv of rawPath.slice(qm + 1).split("&")) { const eq = kv.indexOf("="); if (eq < 0) continue; try { query[decodeURIComponent(kv.slice(0, eq))] = decodeURIComponent(kv.slice(eq + 1)); } catch { /* */ } }
    let body = "";
    if (contentLength > 0 && contentLength < 32 * 1024 * 1024) {
      const bb = ins.readNBytes(contentLength);
      body = String(new (T("java.lang.String") as unknown as new (b: unknown, cs: string) => unknown)(bb, "UTF-8"));
    }
    return { method, path, query, body };
  } catch { return null; }
}

function writeResp(outs: { write(b: unknown): void; flush(): void }, code: number, reason: string, ctype: string | undefined, bodyBytes: unknown, len: number): void {
  const head = `HTTP/1.1 ${code} ${reason}\r\nContent-Type: ${ctype ?? "application/octet-stream"}\r\nContent-Length: ${len}\r\nConnection: close\r\n\r\n`;
  outs.write(jbytesLatin(head));
  if (len > 0) outs.write(bodyBytes);
  outs.flush();
}
function writeText(outs: { write(b: unknown): void; flush(): void }, code: number, reason: string, ctype: string | undefined, body: string): void {
  const b = jbytes(body); writeResp(outs, code, reason, ctype, b, (b as { length: number }).length);
}

/** Run fn on the MC thread and block (UnsafeThread handler) for its result. */
function runOnMain<R>(fn: () => R, fallback: R): R {
  try {
    const Latch = Topt("java.util.concurrent.CountDownLatch");
    const m = mc as unknown as { execute?(r: () => void): void };
    if (!Latch || typeof m.execute !== "function") { return fn(); } // sim/no-exec: run inline
    const latch = new (Latch as unknown as new (n: number) => { countDown(): void; await(): void })(1);
    let out: R = fallback;
    m.execute(() => { try { out = fn(); } catch { /* */ } finally { latch.countDown(); } });
    latch.await();
    return out;
  } catch { return fallback; }
}

export interface ServerOpts { port: number; editorDirName: string; onClose: () => void }

export function startServer(opts: ServerOpts): boolean {
  const root = lbRoot();
  if (!root) return false;
  const Paths = Topt("java.nio.file.Paths"); const Files = Topt("java.nio.file.Files");
  if (!Paths || !Files) return false;
  const get = (...p: string[]): unknown => (Paths.get as (a: string, ...r: string[]) => unknown)(p[0], ...p.slice(1));
  const editorDir = get(root, opts.editorDirName);
  const projDir = get(root, "lb-ide", "projects");
  try { (Files.createDirectories as (p: unknown) => unknown)(projDir); } catch { /* */ }

  const serveFile = (outs: { write(b: unknown): void; flush(): void }, rel: string): void => {
    try {
      let r = rel.replace(/^\/+/, "");
      if (r === "" || r.endsWith("/")) r += "index.html";
      if (r.indexOf("..") >= 0) { writeText(outs, 400, "Bad Request", MIME.txt, "bad path"); return; }
      const ext = (r.split(".").pop() ?? "").toLowerCase();
      const mime = MIME[ext] ?? "application/octet-stream";
      let fp = editorDir as { resolve(s: string): unknown };
      for (const seg of r.split("/").filter((x) => x.length)) fp = fp.resolve(seg) as { resolve(s: string): unknown };
      if (!(Files.exists as (p: unknown) => boolean)(fp)) { writeText(outs, 404, "Not Found", MIME.txt, "404"); return; }
      const bytes = (Files.readAllBytes as (p: unknown) => unknown)(fp);
      writeResp(outs, 200, "OK", mime, bytes, (bytes as { length: number }).length);
    } catch { writeText(outs, 500, "Error", MIME.txt, "read error"); }
  };

  const readProjects = (): unknown[] => {
    const out: unknown[] = [];
    try { for (const p of (Files.newDirectoryStream as (d: unknown, g: string) => Iterable<unknown>)(projDir, "*.json")) { try { out.push(JSON.parse(String((Files.readString as (x: unknown) => unknown)(p)))); } catch { /* */ } } } catch { /* */ }
    return out;
  };

  const handle = (sock: { getInputStream(): unknown; getOutputStream(): unknown; close(): void }): void => {
    try {
      const ins = sock.getInputStream() as { read(): number; readNBytes(n: number): unknown };
      const outs = sock.getOutputStream() as { write(b: unknown): void; flush(): void };
      const req = readRequest(ins);
      if (!req) { try { sock.close(); } catch { /* */ } return; }
      const { method, body } = req; const path = req.path;

      if (method === "OPTIONS") { writeText(outs, 204, "No Content", MIME.txt, ""); sock.close(); return; }
      if (path === "/api/ping") { writeText(outs, 200, "OK", MIME.json, JSON.stringify({ ok: true, root: scriptsRoot() })); sock.close(); return; }
      if (path === "/api/close") { try { opts.onClose(); } catch { /* */ } writeText(outs, 200, "OK", MIME.json, JSON.stringify({ ok: true })); sock.close(); return; }
      if (method === "GET" && path === "/api/scripts") { writeText(outs, 200, "OK", MIME.json, JSON.stringify(listScripts())); sock.close(); return; }
      if (method === "GET" && path === "/api/script") {
        const txt = readScript(req.query.name || "");
        if (txt == null) writeText(outs, 404, "Not Found", MIME.json, JSON.stringify({ ok: false }));
        else writeText(outs, 200, "OK", MIME.json, JSON.stringify({ ok: true, name: req.query.name, content: txt }));
        sock.close(); return;
      }
      if (method === "GET" && path === "/api/projects") { writeText(outs, 200, "OK", MIME.json, JSON.stringify(readProjects())); sock.close(); return; }
      if (method === "POST" && path === "/api/save") {
        try {
          const proj = JSON.parse(body) as { id?: unknown };
          const id = typeof proj.id === "string" ? proj.id.replace(/[^a-z0-9._-]/gi, "") : "";
          if (!id) { writeText(outs, 400, "Bad Request", MIME.json, JSON.stringify({ ok: false })); sock.close(); return; }
          (Files.writeString as (p: unknown, s: unknown) => unknown)((projDir as { resolve(s: string): unknown }).resolve(id + ".json"), JSON.stringify(proj));
          writeText(outs, 200, "OK", MIME.json, JSON.stringify({ ok: true, id }));
        } catch { writeText(outs, 400, "Bad Request", MIME.json, JSON.stringify({ ok: false })); }
        sock.close(); return;
      }
      if (method === "POST" && path === "/api/load") {
        let res: LoadResult = { ok: false, error: "bad request" };
        try {
          const p = JSON.parse(body) as { name?: string; mjs?: string };
          if (p && typeof p.mjs === "string") res = runOnMain<LoadResult>(() => loadBuiltScript(p.name || "script", p.mjs as string), { ok: false, error: "main-thread timeout" });
        } catch { /* */ }
        writeText(outs, res.ok ? 200 : 500, res.ok ? "OK" : "Error", MIME.json, JSON.stringify(res)); sock.close(); return;
      }
      // static editor
      if (method === "GET") { serveFile(outs, path === "/" ? "/" : path); sock.close(); return; }
      writeText(outs, 404, "Not Found", MIME.txt, "404"); sock.close();
    } catch { try { sock.close(); } catch { /* */ } }
  };

  try {
    const ServerSocket = T("java.net.ServerSocket") as unknown as new () => { setReuseAddress(b: boolean): void; bind(a: unknown): void; accept(): unknown };
    const InetSocketAddress = T("java.net.InetSocketAddress") as unknown as new (h: string, p: number) => unknown;
    const ss = new ServerSocket();
    ss.setReuseAddress(true);
    ss.bind(new InetSocketAddress("127.0.0.1", opts.port));
    UnsafeThread.run(() => { for (;;) { let sock: unknown; try { sock = ss.accept(); } catch { break; } const s = sock as { getInputStream(): unknown; getOutputStream(): unknown; close(): void }; UnsafeThread.run(() => handle(s)); } });
    return true;
  } catch { return false; }
}
