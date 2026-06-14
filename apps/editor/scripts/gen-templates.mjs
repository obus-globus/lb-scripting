// Build step: assemble public/templates.json from the real LB template repos.
//
// Output is grouped into CATEGORIES (one per template). Each category has:
//   - base:     the bare template project (just its main script — no examples)
//   - examples: one project per example script in the template's src/examples/
//               (a single-file example → { main.<ext> }; a folder with a main →
//                that multi-file project; a folder of standalone scripts → one
//                project each). Each is "this template, but with that example."
//   - aux:      the supporting files (build script, lib, configs) — shown only
//               when the editor's "show supporting files" toggle is on.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Monorepo layout: template sources live at <root>/templates/* (first-class dev
// assets), the host example at <root>/apps/host.
const TEMPLATES = path.resolve(app, "../../templates");
const HOST = path.resolve(app, "../host");
const read = (p) => readFileSync(p, "utf8");
const slug = (s) => s.replace(/\.[a-z]+$/i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const isScript = (f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts");

function walkFiles(dir, base = dir) {
  const out = {};
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) Object.assign(out, walkFiles(full, base));
    else if (isScript(e)) out[path.relative(base, full).split(path.sep).join("/")] = read(full);
  }
  return out;
}

function readAuxTree(root) {
  const want = (rel) =>
    rel === "package.json" || rel === "tsconfig.json" || rel === "jsconfig.json" ||
    rel === "README.md" || rel === "lbdev.config.example.json" ||
    rel.startsWith("scripts/") || rel.startsWith("host-scripts/") ||
    rel.startsWith("types/") || rel.startsWith("vendor/");
  const skip = new Set(["node_modules", ".git", "dist", "src"]);
  const out = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (skip.has(e)) continue;
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else { const rel = path.relative(root, full).split(path.sep).join("/"); if (want(rel)) out[rel] = read(full); }
    }
  };
  walk(root);
  return out;
}

function buildCategory(id, name, lang, baseDir, description) {
  const srcRoot = path.join(baseDir, "src");
  const ext = lang === "js" ? "js" : "ts";
  // base = top-level src files (the template's own main), excluding examples/
  const base = {};
  for (const e of readdirSync(srcRoot)) {
    const full = path.join(srcRoot, e);
    if (!statSync(full).isDirectory() && isScript(e)) base[e] = read(full);
  }
  // examples — only those matching the template's language (a TS template shows
  // only TS examples, a JS template only JS), so the "+ new" picker stays coherent.
  const examples = [];
  const exRoot = path.join(srcRoot, "examples");
  if (existsSync(exRoot)) {
    for (const e of readdirSync(exRoot).sort()) {
      const full = path.join(exRoot, e);
      if (!statSync(full).isDirectory()) {
        if (!isScript(e)) continue;
        const x = e.endsWith(".js") ? "js" : "ts";
        if (x !== ext) continue;
        examples.push({ id: slug(e), name: e.replace(/\.[a-z]+$/i, ""), files: { ["main." + x]: read(full) } });
      } else {
        const files = walkFiles(full);
        const mainName = "main." + ext;
        if (mainName in files) {
          examples.push({ id: slug(e), name: e, files }); // cohesive multi-file example
        } else if (!Object.keys(files).some((p) => p === "main.ts" || p === "main.js")) {
          for (const [rel, content] of Object.entries(files)) {
            const x = rel.endsWith(".js") ? "js" : "ts";
            if (x !== ext) continue;
            examples.push({ id: slug(e + "-" + rel), name: e + "/" + rel.replace(/\.[a-z]+$/i, ""), files: { ["main." + x]: content } });
          }
        }
      }
    }
  }
  examples.sort((a, b) => a.name.localeCompare(b.name));
  return { id, name, lang, description, base: { files: base }, aux: readAuxTree(baseDir), examples };
}

const categories = [
  buildCategory("default-ts", "Minimal (TS)", "ts", path.join(TEMPLATES, "default-ts"), "Tiny typed script — registerScript + one event handler."),
  buildCategory("plain-js", "Plain JS", "js", path.join(TEMPLATES, "plain-js"), "No build step — // @ts-check'd JavaScript."),
  buildCategory("starter-ts", "Starter (TS)", "ts", path.join(TEMPLATES, "starter-ts"), "JumpLogger starter with a boolean setting."),
  buildCategory("inject-ts", "Inject (TS)", "ts", path.join(TEMPLATES, "inject-ts"), "Runtime bytecode injection via lb-inject."),
  buildCategory("lb-ide-host", "LB Script IDE (host)", "ts", HOST, "The very script that opens this IDE in-game — multi-file, with an in-process HTTP server + CEF."),
];

writeFileSync(path.join(app, "public/templates.json"), JSON.stringify({ categories }, null, 2));
writeFileSync(path.join(app, "public/lb-inject.d.ts"), read(path.join(TEMPLATES, "inject-ts/types/lb-inject.d.ts")));
const bundlePath = path.join(TEMPLATES, "inject-ts/vendor/lib/nf-inject-bundled-1.1.0.js");
if (!existsSync(bundlePath)) throw new Error("missing " + bundlePath);
writeFileSync(path.join(app, "public/lb-inject-bundled.js"), read(bundlePath));

console.log("categories:", categories.map((c) => `${c.id}(base ${Object.keys(c.base.files).length}f, ${c.examples.length} examples)`).join("; "));
console.log("+ lb-inject.d.ts, lb-inject-bundled.js");
