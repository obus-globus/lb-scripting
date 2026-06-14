// Tiny static server for public/. Usage: node serve.mjs [port]
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css", ".ttf": "font/ttf", ".map": "application/json" };

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(req.url.split("?")[0]);
      if (rel === "/") rel = "/index.html";
      const full = path.normalize(path.join(root, rel));
      if (full !== root && !full.startsWith(root + path.sep)) { res.writeHead(403).end("forbidden"); return; } // no traversal
      const data = await readFile(full);
      res.writeHead(200, { "content-type": MIME[path.extname(rel)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8085;
  createServer().listen(port, () => console.log(`serving public/ at http://localhost:${port}`));
}
