// Assemble a ready-to-install in-game bundle:
//
//   release/
//     scripts/lb-ide-host.mjs      → drop into <LB config root>/scripts/
//     lb-ide-editor/...            → drop into <LB config root>/lb-ide-editor/
//     INSTALL.txt
//   lb-ide-ingame.zip              (if `zip` is available)
//
// Builds both halves first (editor dist + host script).
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.resolve(host, "../editor"); // apps/host + apps/editor are siblings
const release = path.join(host, "release");

console.log("building editor (app)…");
execSync("npm run build-dist", { cwd: app, stdio: "inherit" });
console.log("building host script…");
execSync("node scripts/build.mjs", { cwd: host, stdio: "inherit" });

rmSync(release, { recursive: true, force: true });
mkdirSync(path.join(release, "scripts"), { recursive: true });
cpSync(path.join(host, "dist/main.mjs"), path.join(release, "scripts/lb-ide-host.mjs"));
cpSync(path.join(app, "dist"), path.join(release, "lb-ide-editor"), { recursive: true });

writeFileSync(path.join(release, "INSTALL.txt"), `LB Script IDE — in-game install
================================

Copy these into your LiquidBounce config folder (the folder that contains
"scripts/"; in-game run  .ide where  once installed to confirm the path):

  scripts/lb-ide-host.mjs   ->  <LB config root>/scripts/lb-ide-host.mjs
  lb-ide-editor/            ->  <LB config root>/lb-ide-editor/

Then in-game:  .script reload   (or restart the client), then  .ide

Commands:
  .ide          open the editor
  .ide close    close it
  .ide where    show editor / scripts / server paths

The editor binds a local server on 127.0.0.1:8791 (localhost only).
`);

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);
console.log("\nrelease/ assembled:");
console.log("  scripts/lb-ide-host.mjs", mb(path.join(release, "scripts/lb-ide-host.mjs")), "MB");
console.log("  lb-ide-editor/ (editor build)");

try {
  execSync(`cd "${host}" && rm -f lb-ide-ingame.zip && cd release && zip -qr ../lb-ide-ingame.zip .`, { stdio: "inherit" });
  if (existsSync(path.join(host, "lb-ide-ingame.zip"))) console.log("  → lb-ide-ingame.zip", mb(path.join(host, "lb-ide-ingame.zip")), "MB");
} catch { console.log("  (zip CLI not available — ship the release/ folder as-is)"); }
