// Single-source the lb-inject runtime: copy the built bundle(s) from
// packages/lb-inject/dist into the inject template's vendored lib, so the lib is
// the source of truth and the template's copy is a generated (but committed, so
// the template stays standalone-buildable) artifact.
//
// Note: the template's *module-form* type decl (templates/inject-ts/types/
// lb-inject.d.ts — the `declare module "lb-inject"` one) is maintained by hand,
// kept in sync with packages/lb-inject's global nf-inject.d.ts; it is NOT copied
// here.
import { readdirSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "packages/lb-inject/dist");
const tplLib = path.join(root, "templates/inject-ts/vendor/lib");
if (!existsSync(dist)) throw new Error("packages/lb-inject/dist not found");
mkdirSync(tplLib, { recursive: true });

let n = 0;
for (const f of readdirSync(dist)) {
  if (/^nf-inject-bundled-[\d.]+\.js$/.test(f)) { copyFileSync(path.join(dist, f), path.join(tplLib, f)); n++; }
}
console.log(`synced ${n} lb-inject bundle(s) → templates/inject-ts/vendor/lib/`);
