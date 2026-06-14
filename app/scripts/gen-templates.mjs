// Build step: assemble public/templates.json from the real LB template repos,
// plus copy the lb-inject module typings + vendored runtime bundle the inject
// template needs. Keeps the IDE's starter content in sync with the canonical
// templates instead of hand-duplicating them.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SS = path.resolve(app, ".."); // scriptsandstuff/lb-ide-explore
const ROOT = path.resolve(SS, ".."); // scriptsandstuff
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const templates = [
  {
    id: "default-ts",
    name: "Minimal (TS)",
    description: "Tiny typed script — registerScript + one event handler.",
    lang: "ts",
    files: { "main.ts": read("lb-web-ide/template/src/main.ts") },
  },
  {
    id: "plain-js",
    name: "Plain JS",
    description: "No build step — // @ts-check'd JavaScript with full autocomplete.",
    lang: "js",
    files: { "main.js": read("lb-script-template-js/src/main.js") },
  },
  {
    id: "starter-ts",
    name: "Starter (TS)",
    description: "JumpLogger starter with a boolean setting.",
    lang: "ts",
    files: { "main.ts": read("lb-script-starter/src/main.ts") },
  },
  {
    id: "inject-ts",
    name: "Inject (TS)",
    description: "Runtime bytecode injection via lb-inject (mixin-style hooks).",
    lang: "ts",
    needsInject: true,
    files: { "main.ts": read("lb-inject-template/src/main.ts") },
  },
];

writeFileSync(path.join(app, "public/templates.json"), JSON.stringify({ templates }, null, 2));

// lb-inject module typings (so `import { Inject } from "lb-inject"` type-checks
// in the editor) + the vendored runtime bundle (inlined at build time).
writeFileSync(path.join(app, "public/lb-inject.d.ts"), read("lb-inject-template/types/lb-inject.d.ts"));
const bundlePath = "lb-inject/dist/nf-inject-bundled-1.1.0.js";
if (!existsSync(path.join(ROOT, bundlePath))) throw new Error("missing " + bundlePath);
writeFileSync(path.join(app, "public/lb-inject-bundled.js"), read(bundlePath));

console.log("templates.json:", templates.map((t) => t.id).join(", "));
console.log("+ lb-inject.d.ts, lb-inject-bundled.js");
