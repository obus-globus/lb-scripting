// Build step: assemble public/templates.json from the real LB template repos,
// plus copy the lb-inject module typings + vendored runtime bundle the inject
// template needs. Keeps the IDE's starter content in sync with the canonical
// templates instead of hand-duplicating them.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SS = path.resolve(app, ".."); // scriptsandstuff/lb-ide-explore
const ROOT = path.resolve(SS, ".."); // scriptsandstuff
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// Read a whole template src/ tree → { "<relpath>": "<contents>" }, so projects
// are genuinely multi-file (with folders like examples/ and examples/multi-file/lib).
function readSrcTree(templateDir) {
  const srcRoot = path.join(ROOT, templateDir, "src");
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(entry) && !entry.endsWith(".d.ts")) {
        out[path.relative(srcRoot, full).split(path.sep).join("/")] = readFileSync(full, "utf8");
      }
    }
  };
  walk(srcRoot);
  return out;
}

// The supporting (non-src) project files: build script, vendored library,
// configs, types. Shown in the IDE only when "show supporting files" is on.
function readAuxTree(templateDir) {
  const root = path.join(ROOT, templateDir);
  const want = (rel) =>
    rel === "package.json" || rel === "tsconfig.json" || rel === "jsconfig.json" ||
    rel === "README.md" || rel === "lbdev.config.example.json" ||
    rel.startsWith("scripts/") || rel.startsWith("host-scripts/") ||
    rel.startsWith("types/") || rel.startsWith("vendor/");
  const skip = new Set(["node_modules", ".git", "dist", "src"]);
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (want(rel)) out[rel] = readFileSync(full, "utf8");
      }
    }
  };
  walk(root);
  return out;
}

const templates = [
  {
    id: "default-ts",
    name: "Minimal (TS)",
    description: "Typed script + an examples/ folder (incl. multi-file & inject demos).",
    lang: "ts",
    files: readSrcTree("lb-web-ide/template"),
    aux: readAuxTree("lb-web-ide/template"),
  },
  {
    id: "plain-js",
    name: "Plain JS",
    description: "No build step — // @ts-check'd JS, with an examples/ folder.",
    lang: "js",
    files: readSrcTree("lb-script-template-js"),
    aux: readAuxTree("lb-script-template-js"),
  },
  {
    id: "starter-ts",
    name: "Starter (TS)",
    description: "JumpLogger starter + examples/ folder.",
    lang: "ts",
    files: readSrcTree("lb-script-starter"),
    aux: readAuxTree("lb-script-starter"),
  },
  {
    id: "inject-ts",
    name: "Inject (TS)",
    description: "Runtime bytecode injection via lb-inject + examples/ folder.",
    lang: "ts",
    needsInject: true,
    files: readSrcTree("lb-inject-template"),
    aux: readAuxTree("lb-inject-template"),
  },
];

writeFileSync(path.join(app, "public/templates.json"), JSON.stringify({ templates }, null, 2));

// lb-inject module typings (so `import { Inject } from "lb-inject"` type-checks
// in the editor) + the vendored runtime bundle (inlined at build time).
writeFileSync(path.join(app, "public/lb-inject.d.ts"), read("lb-inject-template/types/lb-inject.d.ts"));
const bundlePath = "lb-inject/dist/nf-inject-bundled-1.1.0.js";
if (!existsSync(path.join(ROOT, bundlePath))) throw new Error("missing " + bundlePath);
writeFileSync(path.join(app, "public/lb-inject-bundled.js"), read(bundlePath));

console.log("templates.json:", templates.map((t) => `${t.id}(${Object.keys(t.files).length}f+${Object.keys(t.aux || {}).length}aux)`).join(", "));
console.log("+ lb-inject.d.ts, lb-inject-bundled.js");
