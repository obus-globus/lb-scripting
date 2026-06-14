// Assemble a self-contained static dist/ (real files, no symlinks) suitable for
// serving behind Caddy under a subpath. Run after `npm install` (which generates
// public/typings-bundle.json via the postinstall gen-typings step).
import { cpSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(app, "dist");
const nm = path.join(app, "node_modules");

if (!existsSync(path.join(app, "public/typings-bundle.json"))) {
  console.log("typings-bundle.json missing — generating…");
  execSync("node scripts/gen-typings.mjs", { cwd: app, stdio: "inherit" });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// real page assets (resolve the symlinks in public/ to their real targets)
cpSync(path.join(app, "public/index.html"), path.join(dist, "index.html"));
cpSync(path.join(app, "public/main.js"), path.join(dist, "main.js"));
cpSync(path.join(app, "public/typings-bundle.json"), path.join(dist, "typings-bundle.json"));

// monaco + esbuild-wasm runtime, copied as real files
cpSync(path.join(nm, "monaco-editor/min/vs"), path.join(dist, "vs"), { recursive: true });
cpSync(path.join(nm, "esbuild-wasm/lib/browser.min.js"), path.join(dist, "esbuild.js"));
cpSync(path.join(nm, "esbuild-wasm/esbuild.wasm"), path.join(dist, "esbuild.wasm"));

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);
console.log("dist/ built:");
console.log("  index.html, main.js");
console.log("  typings-bundle.json", mb(path.join(dist, "typings-bundle.json")), "MB");
console.log("  esbuild.wasm       ", mb(path.join(dist, "esbuild.wasm")), "MB");
console.log("  vs/ (monaco)");
