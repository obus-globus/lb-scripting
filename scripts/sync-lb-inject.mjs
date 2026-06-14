// Single-source the lb-inject runtime: copy the built bundle from
// packages/lb-inject/dist into every template that vendors it, so the lib is the
// source of truth and each template's copy is a generated (but committed, so the
// template stays standalone-buildable) artifact.
//
// Each template's scripts/build.mjs pins the exact bundle it consumes
// (`nf-inject-bundled-<ver>.js`); we read that, copy that version from dist into
// the template's vendor/lib, and prune any stale bundles it no longer references.
//
// Note: the template's *module-form* type decl (templates/<t>/types/lb-inject.d.ts
// — the `declare module "lb-inject"` one) is maintained by hand, kept in sync with
// packages/lb-inject's global nf-inject.d.ts; it is NOT copied here.
import { readdirSync, copyFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "packages/lb-inject/dist");
const templatesDir = path.join(root, "templates");
if (!existsSync(dist)) throw new Error("packages/lb-inject/dist not found");

let total = 0;
for (const tpl of readdirSync(templatesDir)) {
  const buildFile = path.join(templatesDir, tpl, "scripts", "build.mjs");
  if (!existsSync(buildFile)) continue;
  const m = /nf-inject-bundled-([\d.]+)\.js/.exec(readFileSync(buildFile, "utf8"));
  if (!m) continue; // template doesn't use lb-inject
  const want = `nf-inject-bundled-${m[1]}.js`;
  const distFile = path.join(dist, want);
  if (!existsSync(distFile)) throw new Error(`template ${tpl} references ${want} but it's missing from packages/lb-inject/dist`);
  const libDir = path.join(templatesDir, tpl, "vendor", "lib");
  mkdirSync(libDir, { recursive: true });
  copyFileSync(distFile, path.join(libDir, want));
  // prune stale bundle versions the template no longer references (dead weight)
  for (const f of readdirSync(libDir))
    if (/^nf-inject-bundled-[\d.]+\.js$/.test(f) && f !== want) rmSync(path.join(libDir, f));
  console.log(`  ${tpl} ← ${want}`);
  total++;
}
console.log(`synced lb-inject into ${total} template(s)`);
