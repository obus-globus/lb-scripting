package lbide;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

/**
 * The one converged LB heavy-mode server, JDK-only (no deps), for both serving
 * paths:
 *   - serves the static heavy vscode-web bundle over HTTP with cross-origin
 *     isolation headers (open the editor at http://localhost in Chrome or CEF,
 *     zero mixed content), and
 *   - exposes the ScriptManager bridge over HTTP (/api/*, same-origin) AND
 *     WebSocket (the cross-origin hosted case: a remote https editor can't fetch
 *     http://localhost, but a WS to localhost works).
 *
 * Security: the WS handshake rejects any Origin not in the allowlist (so no random
 * website can drive the user's localhost), every /api and WS message is token-
 * checked, and load/repl (which run code in the client) require an explicit
 * userGesture flag. Runs on plain threads (no GraalJS callbacks), so it works
 * headlessly in-client where the script-based server cannot.
 *
 * Standalone: this `main` wires {@link FileOps}. The in-LB build constructs the
 * server with a ScriptManager-backed Ops (dispatching save/load/repl on the MC
 * thread) and the same {@link #handle} loop.
 */
public final class LbHeavyServer {
    private final int port;
    private final Path webRoot;                 // static dist (index.html, out/, …); may be null (bridge-only)
    private final Map<String, Path> mounts;     // url-prefix -> dir (e.g. /devext, /fsext, /typings)
    private final String token;
    private final Set<String> allowedOrigins;   // WS Origin allowlist
    private final String bridgeBase;            // value advertised in /lb/config (e.g. "" or ws://host:port)
    private final String projectId;
    private final Ops ops;
    private final LogBus logBus = new LogBus();
    private static final int MAX_FRAME = 16 * 1024 * 1024;   // reject oversized WS frames (OOM guard)
    private static final int MAX_BODY = 16 * 1024 * 1024;    // reject oversized HTTP bodies (OOM guard)
    private static final int HEADER_TIMEOUT_MS = 15000;       // slow-loris guard on the HTTP head read
    private final ExecutorService pool = Executors.newFixedThreadPool(64); // bounded (single-user local server)

    public LbHeavyServer(int port, Path webRoot, Map<String, Path> mounts, String token,
                         Set<String> allowedOrigins, String bridgeBase, String projectId, Ops ops) {
        this.port = port; this.webRoot = webRoot; this.mounts = mounts; this.token = token;
        this.allowedOrigins = allowedOrigins; this.bridgeBase = bridgeBase; this.projectId = projectId; this.ops = ops;
    }

    public void start() throws IOException {
        ServerSocket server = new ServerSocket(port, 50, java.net.InetAddress.getByName("127.0.0.1"));
        System.out.println("lb-heavy-server on http://127.0.0.1:" + port + "/ (ws + http; origins=" + allowedOrigins + ")");
        while (true) {
            Socket s = server.accept();
            pool.submit(() -> { try { handle(s); } catch (Exception e) { try { s.close(); } catch (IOException ignored) {} } });
        }
    }

    // ---- request dispatch -----------------------------------------------------
    private void handle(Socket sock) throws IOException {
        sock.setSoTimeout(HEADER_TIMEOUT_MS); // bound the head read (slow-loris); cleared for WS below
        InputStream in = sock.getInputStream();
        OutputStream out = sock.getOutputStream();
        Map<String, String> head = readHead(in);
        if (head == null) { sock.close(); return; }
        String method = head.get(":method"), path = head.get(":path");
        if ("websocket".equalsIgnoreCase(head.getOrDefault("upgrade", ""))) {
            handleWebSocket(sock, in, out, head);
            return;
        }
        int clen = parseInt(head.get("content-length"), 0);
        if (clen > MAX_BODY) { writeJson(out, 413, mapOf("ok", false, "error", "request too large")); sock.close(); return; }
        String body = clen > 0 ? new String(readN(in, clen), StandardCharsets.UTF_8) : "";
        sock.setSoTimeout(0); // head+body read; clear so a long-lived SSE read doesn't time out
        handleHttp(in, out, method, path, head, body);
        sock.close(); // SSE blocks in-handler until the client disconnects, then returns here
    }

    private void handleHttp(InputStream in, OutputStream out, String method, String path, Map<String, String> head, String body) throws IOException {
        if ("OPTIONS".equals(method)) { writeHttp(out, 204, "text/plain", new byte[0], true); return; }
        String p = path.split("\\?")[0];

        if (p.equals("/lb/config")) {
            Map<String, Object> cfg = new LinkedHashMap<>();
            cfg.put("bridgeBase", bridgeBase); cfg.put("bridgeToken", token); cfg.put("projectId", projectId);
            writeHttp(out, 200, "application/json", Json.stringify(cfg).getBytes(StandardCharsets.UTF_8), true);
            return;
        }
        if (p.startsWith("/api/")) { handleApi(in, out, p, head, body); return; }

        // static: mounts first (/devext, /fsext, /typings), then webRoot.
        for (Map.Entry<String, Path> m : mounts.entrySet()) {
            if (p.startsWith(m.getKey() + "/")) { serveStatic(out, m.getValue(), p.substring(m.getKey().length() + 1)); return; }
        }
        if (webRoot != null) { serveStatic(out, webRoot, p.equals("/") ? "index.html" : p.substring(1)); return; }
        writeHttp(out, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8), true);
    }

    private void handleApi(InputStream in, OutputStream out, String p, Map<String, String> head, String body) throws IOException {
        if (!token.isEmpty() && !token.equals(head.get("x-ide-token"))
                && !("/api/repl/stream".equals(p) && token.equals(queryParam(head.get(":query"), "token")))) {
            writeJson(out, 403, mapOf("ok", false, "error", "forbidden")); return;
        }
        switch (p) {
            case "/api/ping": writeJson(out, 200, ops.ping()); return;
            case "/api/projects": writeJsonList(out, 200, ops.projects()); return;
            case "/api/scripts": writeJsonList(out, 200, ops.scripts()); return;
            case "/api/script": writeJson(out, 200, ops.script(queryParam(head.get(":query"), "name"))); return;
            case "/api/templates": writeJsonList(out, 200, ops.templates()); return;
            case "/api/template/save": writeJson(out, 200, ops.saveTemplate(Json.obj(Json.parse(body)))); return;
            case "/api/template/delete": writeJson(out, 200, ops.deleteTemplate(Json.str(Json.obj(Json.parse(body)).get("id")))); return;
            case "/api/save": writeJson(out, 200, ops.save(Json.obj(Json.parse(body)))); return;
            case "/api/load": {
                Map<String, Object> a = Json.obj(Json.parse(body));
                if (!Json.bool(a.get("userGesture"))) { writeJson(out, 403, mapOf("ok", false, "error", "load requires an explicit user action")); return; }
                writeJson(out, 200, ops.load(Json.str(a.get("name")), Json.str(a.get("mjs")), Json.bool(a.get("debug")))); return;
            }
            case "/api/repl": {
                Map<String, Object> a = Json.obj(Json.parse(body));
                if (!Json.bool(a.get("userGesture"))) { writeJson(out, 403, mapOf("ok", false, "error", "repl requires an explicit user action")); return; }
                writeJson(out, 200, ops.repl(Json.str(a.get("code")))); return;
            }
            case "/api/repl/stream": {
                // SSE: stream log lines, then BLOCK reading until the client disconnects
                // (read -> EOF) so the sink is reliably removed (don't rely on a dead-socket
                // write throwing). This holds the thread for the stream's lifetime.
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\n"
                        + coiHeaderBlock() + "Connection: keep-alive\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
                LogBus.Sink sink = line -> { synchronized (out) { out.write(("data: " + Json.stringify(line) + "\n\n").getBytes(StandardCharsets.UTF_8)); out.flush(); } };
                logBus.add(sink);
                try { sink.onLog("[log stream connected]"); while (in.read() >= 0) { /* wait for client EOF */ } }
                catch (IOException ignored) { /* disconnected */ }
                finally { logBus.remove(sink); }
                return;
            }
            default: writeJson(out, 404, mapOf("ok", false, "error", "unknown")); return;
        }
    }

    // ---- WebSocket ------------------------------------------------------------
    private void handleWebSocket(Socket sock, InputStream in, OutputStream out, Map<String, String> head) throws IOException {
        String origin = head.getOrDefault("origin", "");
        // Reject an empty/absent Origin outright (browsers ALWAYS send it on WS) so a
        // stray trailing "," in --origins can't admit no-Origin (non-browser) clients.
        if (origin.isEmpty() || !allowedOrigins.contains(origin)) {
            System.out.println("[ws] REJECT origin=" + (origin.isEmpty() ? "(none)" : origin));
            out.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8));
            out.flush(); sock.close(); return;
        }
        String key = head.get("sec-websocket-key");
        String accept = wsAccept(key);
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                + accept + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
        sock.setSoTimeout(0); // WS is long-lived; no per-read timeout (Origin+token already gate it)
        System.out.println("[ws] connect origin=" + origin);

        final boolean[] authed = {false};
        final boolean[] subbed = {false};
        LogBus.Sink sink = line -> { try { synchronized (out) { writeFrame(out, Json.stringify(mapOf("t", "log", "line", line))); } } catch (IOException e) { throw new RuntimeException(e); } };
        try {
            while (true) {
                String msg = readFrame(in, out);
                if (msg == null) break;
                Map<String, Object> m = Json.obj(Json.parse(msg));
                String t = Json.str(m.get("t"));
                if ("hello".equals(t)) {
                    authed[0] = token.isEmpty() || token.equals(Json.str(m.get("token")));
                    synchronized (out) { writeFrame(out, Json.stringify(mapOf("t", "hello", "ok", authed[0], "error", authed[0] ? null : "bad token"))); }
                    if (!authed[0]) break;
                } else if (!authed[0]) {
                    break;
                } else if ("sub".equals(t)) {
                    if (!subbed[0]) { subbed[0] = true; logBus.add(sink); sink.onLog("[log stream connected]"); }
                } else if ("unsub".equals(t)) {
                    subbed[0] = false; logBus.remove(sink);
                } else if ("req".equals(t)) {
                    Map<String, Object> frame = new LinkedHashMap<>();
                    frame.put("t", "res"); frame.put("id", m.get("id"));
                    try {
                        Object res = dispatch(Json.str(m.get("op")), Json.obj(m.get("args")));
                        frame.put("ok", true); frame.put("result", res);
                    } catch (RuntimeException ex) {
                        frame.put("ok", false); frame.put("error", ex.getMessage());
                    }
                    synchronized (out) { writeFrame(out, Json.stringify(frame)); }
                }
            }
        } catch (IOException ignored) {
        } finally {
            logBus.remove(sink);
            try { sock.close(); } catch (IOException ignored) {}
        }
    }

    /** Returns the op result (Map or List); throws RuntimeException(message) on error. */
    private Object dispatch(String op, Map<String, Object> a) {
        switch (op == null ? "" : op) {
            case "ping": return ops.ping();
            case "projects": return ops.projects();
            case "scripts": return ops.scripts();
            case "script": return ops.script(Json.str(a.get("name")));
            case "templates": return ops.templates();
            case "saveTemplate": return ops.saveTemplate(Json.obj(a.get("template")));
            case "deleteTemplate": return ops.deleteTemplate(Json.str(a.get("id")));
            case "save": return ops.save(Json.obj(a.get("project")));
            case "load":
                if (!Json.bool(a.get("userGesture"))) throw new RuntimeException("load requires an explicit user action");
                return ops.load(Json.str(a.get("name")), Json.str(a.get("mjs")), Json.bool(a.get("debug")));
            case "repl":
                if (!Json.bool(a.get("userGesture"))) throw new RuntimeException("repl requires an explicit user action");
                return ops.repl(Json.str(a.get("code")));
            default: throw new RuntimeException("unknown op: " + op);
        }
    }

    // ---- WS framing -----------------------------------------------------------
    private static String wsAccept(String key) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(h);
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    /** Read one client text frame (handles masking + ping); null on close/EOF. */
    private static String readFrame(InputStream in, OutputStream out) throws IOException {
        int b0 = in.read();
        if (b0 < 0) return null;
        int opcode = b0 & 0x0F;
        int b1 = in.read();
        if (b1 < 0) return null;
        boolean masked = (b1 & 0x80) != 0;
        long len = b1 & 0x7F;
        if (len == 126) { len = ((long) in.read() << 8) | in.read(); }
        else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | in.read(); }
        if (len < 0 || len > MAX_FRAME) throw new IOException("ws frame too large: " + len); // OOM guard
        byte[] mask = new byte[4];
        if (masked) { if (readFull(in, mask, 4) < 0) return null; }
        byte[] payload = new byte[(int) len];
        if (readFull(in, payload, (int) len) < 0) return null;
        if (masked) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        if (opcode == 0x8) return null;                 // close
        if (opcode == 0x9) { synchronized (out) { writeFrameRaw(out, 0x8A, payload); } return readFrame(in, out); } // ping -> pong
        if (opcode == 0xA) return readFrame(in, out);   // pong -> ignore
        return new String(payload, StandardCharsets.UTF_8); // text (0x1)
    }

    private static void writeFrame(OutputStream out, String text) throws IOException {
        writeFrameRaw(out, 0x81, text.getBytes(StandardCharsets.UTF_8));
    }
    private static void writeFrameRaw(OutputStream out, int b0, byte[] payload) throws IOException {
        ByteArrayOutputStream f = new ByteArrayOutputStream();
        f.write(b0);
        int n = payload.length;
        if (n <= 125) f.write(n);
        else if (n < 65536) { f.write(126); f.write((n >> 8) & 0xFF); f.write(n & 0xFF); }
        else { f.write(127); for (int i = 7; i >= 0; i--) f.write((int) ((long) n >> (8 * i)) & 0xFF); }
        f.write(payload, 0, n);
        out.write(f.toByteArray()); out.flush();
    }

    // ---- HTTP helpers ---------------------------------------------------------
    private void serveStatic(OutputStream out, Path root, String rel) throws IOException {
        Path base = root.toAbsolutePath().normalize();
        Path full = base.resolve(rel).normalize();
        if (!full.startsWith(base)) { writeHttp(out, 403, "text/plain", "forbidden".getBytes(StandardCharsets.UTF_8), true); return; }
        if (!Files.isRegularFile(full)) { writeHttp(out, 404, "text/plain", "404".getBytes(StandardCharsets.UTF_8), true); return; }
        writeHttp(out, 200, mime(full.toString()), Files.readAllBytes(full), true);
    }

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8"); MIME.put("js", "text/javascript; charset=utf-8");
        MIME.put("mjs", "text/javascript; charset=utf-8"); MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8"); MIME.put("map", "application/json");
        MIME.put("ttf", "font/ttf"); MIME.put("woff", "font/woff"); MIME.put("woff2", "font/woff2");
        MIME.put("svg", "image/svg+xml"); MIME.put("png", "image/png"); MIME.put("ico", "image/x-icon");
        MIME.put("wasm", "application/wasm");
    }
    private static String mime(String f) { int d = f.lastIndexOf('.'); return d < 0 ? "application/octet-stream" : MIME.getOrDefault(f.substring(d + 1).toLowerCase(), "application/octet-stream"); }

    // COI headers only. Deliberately NO Access-Control-Allow-Origin: the HTTP /api +
    // /lb/config are used ONLY same-origin (the hosted cross-origin case uses WS,
    // Origin-checked at the handshake). Serving the bridge token under ACAO:* would
    // let any website read /lb/config cross-origin, steal the token, and call /api/load
    // (code execution in the client). Same-origin reads don't need ACAO.
    private static String coiHeaderBlock() {
        return "Cross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: cross-origin\r\n";
    }
    private void writeHttp(OutputStream out, int code, String ctype, byte[] body, boolean coi) throws IOException {
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(' ').append(code == 200 ? "OK" : code == 204 ? "No Content" : code == 404 ? "Not Found" : code == 403 ? "Forbidden" : "Status").append("\r\n");
        h.append("Content-Type: ").append(ctype).append("\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        if (coi) h.append(coiHeaderBlock());
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        out.write(body); out.flush();
    }
    private void writeJson(OutputStream out, int code, Map<String, Object> m) throws IOException {
        writeHttp(out, code, "application/json; charset=utf-8", Json.stringify(m).getBytes(StandardCharsets.UTF_8), true);
    }
    // /api/projects returns a bare JSON array.
    private void writeJsonList(OutputStream out, int code, List<Object> list) throws IOException {
        writeHttp(out, code, "application/json; charset=utf-8", Json.stringify(list).getBytes(StandardCharsets.UTF_8), true);
    }

    // ---- header parsing -------------------------------------------------------
    /** Reads the request head (up to CRLFCRLF); returns lowercased headers + :method/:path/:query. */
    private static Map<String, String> readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int prev = 0; // rolling 4-byte window
        int c;
        while ((c = in.read()) >= 0) {
            buf.write(c);
            prev = (prev << 8) | c;
            if (prev == 0x0D0A0D0A) break;                       // CRLFCRLF
            if ((prev & 0xFFFF) == 0x0A0A) break;                // bare LFLF fallback
            if (buf.size() > 65536) return null;
        }
        String[] lines = buf.toString(StandardCharsets.UTF_8).split("\r\n");
        if (lines.length == 0) return null;
        Map<String, String> h = new HashMap<>();
        String[] rl = lines[0].split(" ");
        if (rl.length < 2) return null;
        h.put(":method", rl[0]);
        String pq = rl[1];
        int q = pq.indexOf('?');
        h.put(":path", q < 0 ? pq : pq.substring(0, q));
        h.put(":query", q < 0 ? "" : pq.substring(q + 1));
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0) h.put(lines[i].substring(0, colon).trim().toLowerCase(), lines[i].substring(colon + 1).trim());
        }
        return h;
    }

    private static byte[] readN(InputStream in, int n) throws IOException { byte[] b = new byte[n]; readFull(in, b, n); return b; }
    private static int readFull(InputStream in, byte[] b, int n) throws IOException {
        int off = 0;
        while (off < n) { int r = in.read(b, off, n - off); if (r < 0) return -1; off += r; }
        return off;
    }
    private static int parseInt(String s, int d) { try { return s == null ? d : Integer.parseInt(s.trim()); } catch (Exception e) { return d; } }
    private static String queryParam(String query, String key) {
        if (query == null) return null;
        for (String kv : query.split("&")) { int e = kv.indexOf('='); if (e > 0 && kv.substring(0, e).equals(key)) return java.net.URLDecoder.decode(kv.substring(e + 1), StandardCharsets.UTF_8); }
        return null;
    }
    private static Map<String, Object> mapOf(Object... kv) { Map<String, Object> m = new LinkedHashMap<>(); for (int i = 0; i < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]); return m; }

    // ---- log bus (HTTP SSE + WS share it) -------------------------------------
    static final class LogBus {
        interface Sink { void onLog(String line) throws IOException; }
        private final Set<Sink> sinks = Collections.newSetFromMap(new ConcurrentHashMap<>());
        void add(Sink s) { sinks.add(s); }
        void remove(Sink s) { sinks.remove(s); }
        void publish(String line) { for (Sink s : sinks) { try { s.onLog(line); } catch (Exception e) { sinks.remove(s); } } }
    }
    public void publishLog(String line) { logBus.publish(line); }

    // ---- standalone entry point ----------------------------------------------
    public static void main(String[] args) throws Exception {
        Map<String, String> a = new HashMap<>();
        for (int i = 0; i + 1 < args.length; i += 2) if (args[i].startsWith("--")) a.put(args[i].substring(2), args[i + 1]);
        int port = parseInt(a.get("port"), 8900);
        Path webRoot = a.containsKey("web") ? Path.of(a.get("web")) : null;
        Map<String, Path> mounts = new LinkedHashMap<>();
        if (a.containsKey("devext")) mounts.put("/devext", Path.of(a.get("devext")));
        if (a.containsKey("fsext")) mounts.put("/fsext", Path.of(a.get("fsext")));
        if (a.containsKey("typings")) mounts.put("/typings", Path.of(a.get("typings")));
        String token = a.getOrDefault("token", "");
        Set<String> origins = new java.util.HashSet<>(List.of(a.getOrDefault("origins", "").split(",", -1)));
        String bridgeBase = a.getOrDefault("bridgeBase", "");
        String projectId = a.getOrDefault("project", "demo-proj");
        Path projDir = Path.of(a.getOrDefault("projects", "/tmp/lb-heavy-projects"));
        Path scriptsDir = Path.of(a.getOrDefault("scripts", "/tmp/lb-heavy-scripts"));
        Path templatesDir = Path.of(a.getOrDefault("templates", "/tmp/lb-heavy-templates"));
        LbHeavyServer[] self = new LbHeavyServer[1];
        FileOps ops = new FileOps(projDir, scriptsDir, templatesDir, line -> { System.out.println("[ops] " + line); if (self[0] != null) self[0].publishLog(line); });
        self[0] = new LbHeavyServer(port, webRoot, mounts, token, origins, bridgeBase, projectId, ops);
        self[0].start();
    }
}
