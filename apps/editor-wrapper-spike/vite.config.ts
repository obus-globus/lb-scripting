import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const apiVscode = path.join(dir, "node_modules/@codingame/monaco-vscode-api/vscode/src");
export default defineConfig({
  build: { target: "esnext", chunkSizeWarningLimit: 100000 },
  worker: { format: "es" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
  resolve: { alias: [
    { find: /^@codingame\/monaco-vscode-api\/vscode\/(.*)\.css$/, replacement: apiVscode + "/$1.css" },
    { find: /^@codingame\/monaco-vscode-api\/vscode\/(.*)$/, replacement: apiVscode + "/$1.js" },
  ] },
  preview: { port: 8087, headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" } },
});
