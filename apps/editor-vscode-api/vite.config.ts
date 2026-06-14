import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
const dir = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = path.join(dir, "node_modules/@codingame/monaco-vscode-api/vscode/src");
const nm = path.join(dir, "node_modules");
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
export default defineConfig({
  build: { target: "esnext" },
  esbuild: { minifySyntax: false },
  worker: { format: "es" },
  resolve: {
    dedupe: ["vscode", "monaco-editor"],
    alias: [
      { find: /^@codingame\/monaco-vscode-api\/workers\/extensionHost\.worker\.js(\?.*)?$/, replacement: nm + "/@codingame/monaco-vscode-api/workers/extensionHost.worker.js$1" },
      { find: /^@codingame\/(monaco-vscode-[a-z0-9-]+)\/worker\.js(\?.*)?$/, replacement: nm + "/@codingame/$1/worker.js$2" },
      { find: /^@codingame\/monaco-vscode-api\/vscode\/(.*)\.css$/, replacement: apiSrc + "/$1.css" },
      { find: /^@codingame\/monaco-vscode-api\/vscode\/(.*)$/, replacement: apiSrc + "/$1.js" },
      { find: /^monaco-editor$/, replacement: "@codingame/monaco-vscode-editor-api" },
      { find: /^monaco-editor\/(.*)$/, replacement: "@codingame/monaco-vscode-editor-api/$1" },
      { find: /^vscode$/, replacement: "@codingame/monaco-vscode-extension-api" },
      { find: /^vscode\/(.*)$/, replacement: "@codingame/monaco-vscode-extension-api/$1" },
    ],
  },
  optimizeDeps: { esbuildOptions: { plugins: [importMetaUrlPlugin], target: "esnext" } },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
});
