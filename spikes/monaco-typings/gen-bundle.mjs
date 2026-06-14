// Compute the transitive .d.ts closure that good.ts actually references and emit
// a single typings-bundle.json: { "node_modules/@wunk/.../X.d.ts": "<content>" }.
// This is what the Monaco page feeds to monaco.languages.typescript via
// addExtraLib — so the browser ships ~1.7MB, not the package's full 96MB.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkgRoot = path.join(root, "node_modules/@wunk/lb-script-api-types");

// Ask tsc which files the program loads for good.ts.
const listed = execSync("npx tsc -p tsconfig.json --listFiles", { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((p) => p.startsWith(pkgRoot));

const bundle = {};
let bytes = 0;
for (const abs of listed) {
  const rel = "node_modules/@wunk/lb-script-api-types/" + path.relative(pkgRoot, abs);
  const content = readFileSync(abs, "utf8");
  bundle[rel] = content;
  bytes += content.length;
}
// The package.json carries the "typesVersions" map that makes
// `@wunk/lb-script-api-types/ambient` + `/types/...` subpaths resolve.
const pj = "node_modules/@wunk/lb-script-api-types/package.json";
bundle[pj] = readFileSync(path.join(pkgRoot, "package.json"), "utf8");

writeFileSync("typings-bundle.json", JSON.stringify(bundle));
console.log(`files: ${Object.keys(bundle).length}`);
console.log(`bytes: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
