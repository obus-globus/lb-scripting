// LB heavy-mode static host — the deployable web-only serving layer for the
// from-source vscode-web bundle. Replaces @vscode/test-web (a dev harness) with a
// dependency-free node server that:
//   - serves the packaged vscode-web bundle as static files,
//   - renders the workbench shell at `/` with the correct WORKBENCH_WEB_CONFIGURATION
//     (and the build's actual CSS name — test-web's 404s),
//   - sets cross-origin-isolation headers (COOP/COEP) so SharedArrayBuffer + the
//     web tsserver work,
//   - mounts the lb-glue extension as a development extension.
// The workspace filesystem provider (project files + barrel typings) is added in a
// later step; this layer is the serving contract.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = process.env.LB_BUNDLE || "/home/clawd/obus/vscode-web";
const GLUE = process.env.LB_GLUE || path.resolve(HERE, "../lb-glue");
const FSEXT = process.env.LB_FSEXT || path.resolve(HERE, "../lb-fs");
const TYPINGS = process.env.LB_TYPINGS || path.resolve(HERE, "typings");
const PORT = Number(process.env.LB_PORT || 9900);
const HOST = process.env.LB_HOST || "localhost";
// The ScriptManager bridge the project is sourced from (same API the lean editor
// writes to). Empty base → no workspace (empty window); useful for serving-only checks.
const BRIDGE_BASE = process.env.LB_BRIDGE_BASE || "";
const BRIDGE_TOKEN = process.env.LB_BRIDGE_TOKEN || "";
const PROJECT_ID = process.env.LB_PROJECT_ID || "";
// Webview origin isolation. VS Code serves webview content from a SEPARATE origin
// (a per-webview {{uuid}} subdomain) so a compromised webview can't reach the
// workbench origin. In dev, *.localhost resolves to loopback so the default works;
// in prod set LB_WEBVIEW_ENDPOINT to a wildcard-DNS https origin you control, e.g.
// "https://{{uuid}}.heavy-webview.example.com" (must NOT be the workbench origin).
const WEBVIEW_ENDPOINT = process.env.LB_WEBVIEW_ENDPOINT || "";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon",
  ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
};
const mime = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";

// Cross-origin isolation (required for SharedArrayBuffer → the web tsserver).
function coi(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

const esc = (v) => JSON.stringify(v).replace(/"/g, "&quot;");

// The WORKBENCH_WEB_CONFIGURATION (IWorkbenchConstructionOptions). base = "" → same origin.
// projectId comes from the request (?project=) so the lean→heavy switch can target
// any project; falls back to the host's env default.
function webConfiguration(reqHost, projectId) {
  // Webview origin: configurable for prod; default to *.localhost (dev only).
  const webviewBase = WEBVIEW_ENDPOINT || `http://{{uuid}}.${reqHost}`;
  const cfg = {
    productConfiguration: {
      nameShort: "LB Heavy", nameLong: "LB Script IDE (heavy)", enableTelemetry: false,
      webEndpointUrlTemplate: webviewBase,
      webviewContentExternalBaseUrlTemplate: `${webviewBase}/out/vs/workbench/contrib/webview/browser/pre/`,
    },
    // The lb-glue extension, mounted as a development extension (served at /devext).
    developmentOptions: { extensions: [{ scheme: "http", authority: reqHost, path: "/devext" }] },
  };
  // When a project + bridge are configured, open an lbfs://<projectId>/ workspace
  // served by the lb-fs builtin extension (sources files from the bridge + barrel
  // typings). The project id rides in the folder authority so lb-fs can read it.
  if (BRIDGE_BASE && projectId) {
    cfg.additionalBuiltinExtensions = [{ scheme: "http", authority: reqHost, path: "/fsext" }];
    cfg.folderUri = { scheme: "lbfs", authority: projectId, path: "/" };
  }
  return cfg;
}

async function renderWorkbench(reqHost, projectId) {
  const tpl = await readFile(path.join(HERE, "web", "workbench.html"), "utf8");
  let main = await readFile(path.join(HERE, "web", "bootstrap.js"), "utf8");
  // Point the bootstrap's `./workbench.api` import at the build's real entry.
  main = main.replace("./workbench.api", "/out/vs/workbench/workbench.web.main.internal.js");
  const values = {
    WORKBENCH_WEB_CONFIGURATION: esc(webConfiguration(reqHost, projectId)),
    WORKBENCH_WEB_BASE_URL: "",
    WORKBENCH_MAIN: main,
  };
  return tpl.replace(/\{\{([^}]+)\}\}/g, (_, k) => values[k] ?? "");
}

// Safe static file serve from a root (no path traversal).
async function serveStatic(root, rel, res) {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const st = await stat(full);
    if (st.isDirectory()) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { "content-type": mime(full), "content-length": st.size });
    createReadStream(full).pipe(res);
  } catch { res.writeHead(404); res.end("not found: " + rel); }
}

const server = http.createServer(async (req, res) => {
  coi(res);
  const reqHost = req.headers.host || `${HOST}:${PORT}`;
  const url = new URL(req.url, `http://${reqHost}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname === "/" || pathname === "/index.html") {
      const projectId = url.searchParams.get("project") || PROJECT_ID;
      const html = await renderWorkbench(reqHost, projectId);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (pathname === "/lb/config") {
      // NOTE (trust boundary): this returns bridgeToken to anything on this origin
      // (incl. workbench extensions/webviews). The token drives /api/load (runs code
      // in the client), so the heavy origin must be trusted — same posture as the
      // lean editor, which also holds the token in-page. Don't host untrusted
      // extensions/webviews on this origin.
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ bridgeBase: BRIDGE_BASE, bridgeToken: BRIDGE_TOKEN, projectId: PROJECT_ID }));
      return;
    }
    if (pathname.startsWith("/devext/")) { await serveStatic(GLUE, pathname.slice("/devext/".length), res); return; }
    if (pathname.startsWith("/fsext/")) { await serveStatic(FSEXT, pathname.slice("/fsext/".length), res); return; }
    if (pathname.startsWith("/typings/")) { await serveStatic(TYPINGS, pathname.slice("/typings/".length), res); return; }
    // everything else → the vscode-web bundle (out/, extensions/, node_modules/, resources/, …)
    await serveStatic(BUNDLE, pathname.replace(/^\//, ""), res);
  } catch (e) {
    res.writeHead(500); res.end("server error: " + (e && e.message || e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`lb-heavy host: http://${HOST}:${PORT}/  (bundle=${BUNDLE}, glue=${GLUE})`);
});
