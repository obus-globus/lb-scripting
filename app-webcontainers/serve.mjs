// Static server for the WebContainers app. MUST send COOP/COEP so the page is
// cross-origin isolated (WebContainers needs SharedArrayBuffer).
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css", ".ttf": "font/ttf", ".map": "application/json" };

export function createServer() {
  return http.createServer(async (req, res) => {
    const headers = {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      // cross-origin so Monaco's opaque-origin (data: URL) worker can importScripts
      // our same-origin vs/ assets under COEP require-corp.
      "Cross-Origin-Resource-Policy": "cross-origin",
    };
    try {
      let rel = decodeURIComponent(req.url.split("?")[0]);
      if (rel === "/") rel = "/index.html";
      const data = await readFile(path.join(root, rel));
      res.writeHead(200, { ...headers, "content-type": MIME[path.extname(rel)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404, headers).end("not found");
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8086;
  createServer().listen(port, () => console.log(`serving public/ (COOP/COEP) at http://localhost:${port}`));
}
