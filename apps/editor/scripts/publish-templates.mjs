// CI publish step: regenerate the bundled templates.json (gen-templates) and copy it
// to the repo-root `templates.json` — the single artifact the editor fetches at
// runtime from a CORS-clean raw URL (decouples template updates from editor
// redeploys). Run from the repo root: `node apps/editor/scripts/publish-templates.mjs`.
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
execFileSync("node", [path.join(here, "gen-templates.mjs")], { stdio: "inherit" });
const src = path.resolve(here, "../public/templates.json");
const dst = path.join(repoRoot, "templates.json");
copyFileSync(src, dst);
console.log("published →", path.relative(repoRoot, dst));
