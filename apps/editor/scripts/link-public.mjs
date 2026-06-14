// Symlink the monaco + esbuild-wasm runtime assets into public/ so `npm run
// serve` / `npm run verify` work straight after `npm install` (build-dist copies
// real files instead). Idempotent.
import { existsSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const links = [
  ["node_modules/monaco-editor/min/vs", "public/vs"],
  ["node_modules/esbuild-wasm/lib/browser.min.js", "public/esbuild.js"],
  ["node_modules/esbuild-wasm/esbuild.wasm", "public/esbuild.wasm"],
];
for (const [target, linkRel] of links) {
  const link = path.join(app, linkRel);
  try { if (existsSync(link) || lstatSync(link)) rmSync(link, { recursive: true, force: true }); } catch { /* */ }
  // relative target from the link's directory
  const rel = path.relative(path.dirname(link), path.join(app, target));
  symlinkSync(rel, link);
}
console.log("linked public/vs, public/esbuild.js, public/esbuild.wasm");
