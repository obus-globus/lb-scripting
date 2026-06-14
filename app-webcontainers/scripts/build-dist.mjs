// Assemble a self-contained static dist/ (real files) for serving behind Caddy.
// The host that serves this MUST send COOP/COEP (cross-origin isolation) — see
// serve.mjs and the Caddy route notes in the README.
import { cpSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(app, "dist");
const nm = path.join(app, "node_modules");

if (!existsSync(path.join(app, "public/typings-bundle.json"))) {
  execSync("node scripts/gen-typings.mjs", { cwd: app, stdio: "inherit" });
}
if (!existsSync(path.join(app, "public/webcontainer-api.js"))) {
  execSync("node scripts/bundle-api.mjs", { cwd: app, stdio: "inherit" });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const f of ["index.html", "main.js", "typings-bundle.json", "webcontainer-api.js"])
  cpSync(path.join(app, "public", f), path.join(dist, f));
cpSync(path.join(nm, "monaco-editor/min/vs"), path.join(dist, "vs"), { recursive: true });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);
console.log("dist/ built:");
console.log("  index.html, main.js, webcontainer-api.js");
console.log("  typings-bundle.json", mb(path.join(dist, "typings-bundle.json")), "MB");
console.log("  vs/ (monaco)");
