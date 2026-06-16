// Generate an ambient-module-per-path barrel from the @wunk closure.
// Each <rel>.d.ts becomes  declare module "@wunk/lb-script-api-types/<rel>" { <content, imports rewritten to specifiers> }
// so deep imports resolve against already-loaded ambient blocks (no per-file FS probing).
// ambient/ambient.d.ts is kept at TOP LEVEL (it provides the globals mc/registerScript).
//
// Two sources (the closure → a { rel → content } map either way):
//   --wunk   <closure-dir>            walk a directory of .d.ts files (the spike closure)
//   --bundle <typings-bundle.json>    read the lean editor's typings bundle - the SAME
//                                     transitive closure it ships, generated from the
//                                     PINNED @wunk version (apps/editor/scripts/gen-typings.mjs).
//                                     Keys are "node_modules/@wunk/lb-script-api-types/<rel>".
// Usage:
//   node gen-barrel.mjs (--wunk <dir> | --bundle <json>) --out <barrel.d.ts> [--pkg <name>] [--ambient <rel>]
//   (env LB_WUNK / LB_BUNDLE / LB_BARREL_OUT / LB_PKG / LB_AMBIENT also work). The ambient
//   module is written as a SEPARATE <out-dir>/ambient.d.ts (NOT concatenated - that breaks
//   the barrel's script-ness). --ambient is the closure-relative path to the globals d.ts
//   (default ambient/ambient.d.ts); pass "" to skip if the closure has no globals file.
import fs from 'fs';
import path from 'path';

function arg(name, env, def) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (env && process.env[env] != null) return process.env[env];
  return def;
}
const WUNK = arg('wunk', 'LB_WUNK', '');
const BUNDLE = arg('bundle', 'LB_BUNDLE', '');
const OUT = path.resolve(arg('out', 'LB_BARREL_OUT', '/home/clawd/obus/vscode-build/lb-barrel/barrel.d.ts'));
const PKG = arg('pkg', 'LB_PKG', '@wunk/lb-script-api-types');
const AMBIENT_REL = arg('ambient', 'LB_AMBIENT', 'ambient/ambient.d.ts');

// Build the closure as a Map(rel → content), rel = package-relative POSIX path incl. .d.ts.
function loadClosure() {
  const closure = new Map();
  if (BUNDLE) {
    const prefix = 'node_modules/' + PKG + '/';
    const obj = JSON.parse(fs.readFileSync(path.resolve(BUNDLE), 'utf8'));
    for (const [key, content] of Object.entries(obj)) {
      if (!key.startsWith(prefix) || !key.endsWith('.d.ts')) continue;
      closure.set(key.slice(prefix.length), content);
    }
  } else {
    const root = path.resolve(WUNK || '/home/clawd/obus/vscode-build/lb-ws2/wunk');
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.d.ts')) closure.set(path.relative(root, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8'));
      }
    };
    walk(root);
  }
  return closure;
}

const closure = loadClosure();
const specOf = (rel) => PKG + '/' + rel.replace(/\.d\.ts$/, '');
// Resolve a relative import (from a file's POSIX dir) to a package specifier, using
// the closure map for existence (matches the .d.ts → /index.d.ts → .d.ts fallback).
function rewriteSpec(fileDir, spec) {
  if (!spec.startsWith('.')) return spec; // already bare / package
  let rel = path.posix.normalize(path.posix.join(fileDir, spec));
  if (!rel.endsWith('.d.ts')) {
    if (closure.has(rel + '.d.ts')) rel = rel + '.d.ts';
    else if (closure.has(rel + '/index.d.ts')) rel = rel + '/index.d.ts';
    else rel = rel + '.d.ts';
  }
  return specOf(rel);
}
const rewriteImports = (content, fileDir) =>
  content.replace(/(from\s+|import\s+|declare\s+module\s+)(['"])([^'"]+)\2/g, (m, kw, q, spec) => kw + q + rewriteSpec(fileDir, spec) + q);

let moduleBlocks = [];
let ambientTop = '';
let n = 0;
// Sorted iteration → deterministic, byte-identical output regardless of source
// (directory walk order vs bundle JSON key order). Order is irrelevant for a barrel.
for (const rel of [...closure.keys()].sort()) {
  const content = closure.get(rel);
  const fileDir = path.posix.dirname(rel);
  const rewritten = rewriteImports(content, fileDir);
  if (rel === AMBIENT_REL) {
    // Emit ambient.d.ts as a SEPARATE module file (NOT concatenated into the barrel -
    // that's what broke the barrel's script-ness). It keeps its top-level imports
    // (rewritten to @wunk specifiers, which resolve to the barrel's ambient modules with
    // no FS) and its `declare global {}` - the correct pattern for a module that declares
    // globals. main.ts references both files.
    ambientTop = rewritten;
    continue;
  }
  moduleBlocks.push(`declare module "${specOf(rel)}" {\n${rewritten}\n}`);
  n++;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const barrel = moduleBlocks.join('\n') + '\n';
fs.writeFileSync(OUT, barrel);
console.log(`barrel: ${n} declare-module blocks (script), ${(barrel.length / 1e6).toFixed(1)}MB -> ${OUT}  [source: ${BUNDLE ? 'bundle ' + BUNDLE : 'dir ' + (WUNK || 'default')}]`);
if (AMBIENT_REL) {
  if (!ambientTop) { console.error(`ambient file not found in closure: ${AMBIENT_REL} (pass --ambient "" to skip)`); process.exit(1); }
  const AMB = path.join(path.dirname(OUT), 'ambient.d.ts');
  fs.writeFileSync(AMB, ambientTop);
  console.log(`ambient: separate module file -> ${AMB}`);
}
