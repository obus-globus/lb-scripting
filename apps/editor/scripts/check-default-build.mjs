// Guard the DEFAULT_BUILD duplication: the lean editor keeps its own copy in
// public/main.js (the buildless config UI can't sync-import the ESM in its
// synchronous helpers), and @lb-ide/core owns the authoritative one in build.js.
// They must stay identical; this asserts that and exits non-zero on drift.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { DEFAULT_BUILD: core } = await import(path.join(here, "../../../packages/lb-ide-core/src/build.js"));

const mainSrc = readFileSync(path.join(here, "../public/main.js"), "utf8");
const m = mainSrc.match(/const DEFAULT_BUILD\s*=\s*(\{[\s\S]*?\n\};)/);
if (!m) { console.error("check-default-build: could not find DEFAULT_BUILD in main.js"); process.exit(1); }
const lean = new Function("return " + m[1].replace(/;\s*$/, ""))();

const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
if (norm(core) !== norm(lean)) {
  console.error("check-default-build: DEFAULT_BUILD DRIFT between main.js and @lb-ide/core/build.js");
  console.error("  core:", norm(core));
  console.error("  lean:", norm(lean));
  process.exit(1);
}
console.log("check-default-build: DEFAULT_BUILD in sync (" + Object.keys(core).length + " keys)");
