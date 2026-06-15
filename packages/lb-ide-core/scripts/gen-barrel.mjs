// Generate an ambient-module-per-path barrel from the @wunk closure.
// Each wunk/<rel>.d.ts becomes  declare module "@wunk/lb-script-api-types/<rel>" { <content, imports rewritten to specifiers> }
// so deep imports resolve against already-loaded ambient blocks (no per-file FS probing).
// ambient/ambient.d.ts is kept at TOP LEVEL (it provides the globals mc/registerScript).
//
// Usage:
//   node gen-barrel.mjs --wunk <closure-dir> --out <barrel.d.ts> [--pkg <name>] [--ambient <rel>]
//   (env LB_WUNK / LB_BARREL_OUT / LB_PKG also work). The ambient module is written
//   as a SEPARATE <out-dir>/ambient.d.ts (NOT concatenated — that breaks the barrel's
//   script-ness). --ambient is the closure-relative path to the globals d.ts
//   (default ambient/ambient.d.ts); pass "" to skip if the closure has no globals file.
import fs from 'fs';
import path from 'path';

function arg(name, env, def) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (env && process.env[env] != null) return process.env[env];
  return def;
}
const WUNK = path.resolve(arg('wunk', 'LB_WUNK', '/home/clawd/obus/vscode-build/lb-ws2/wunk'));
const OUT = path.resolve(arg('out', 'LB_BARREL_OUT', '/home/clawd/obus/vscode-build/lb-barrel/barrel.d.ts'));
const PKG = arg('pkg', 'LB_PKG', '@wunk/lb-script-api-types');
const AMBIENT_REL = arg('ambient', 'LB_AMBIENT', 'ambient/ambient.d.ts');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
// specifier for an absolute wunk file path: @wunk/lb-script-api-types/<rel-without-.d.ts>
function specOf(absFile) {
  let rel = path.relative(WUNK, absFile).replace(/\\/g, '/');
  rel = rel.replace(/\.d\.ts$/, '');
  return PKG + '/' + rel;
}
// rewrite a relative import specifier (from a file) to the package specifier
function rewriteSpec(fileDir, spec) {
  if (!spec.startsWith('.')) return spec; // already bare / package
  let abs = path.resolve(fileDir, spec);
  // the import may include .d.ts or not; normalize to a wunk file
  if (!abs.endsWith('.d.ts')) {
    if (fs.existsSync(abs + '.d.ts')) abs = abs + '.d.ts';
    else if (fs.existsSync(path.join(abs, 'index.d.ts'))) abs = path.join(abs, 'index.d.ts');
    else abs = abs + '.d.ts';
  }
  return specOf(abs);
}
function rewriteImports(content, fileDir) {
  // from '...' , import '...' , and  declare module '...'  (single or double quote)
  return content.replace(/(from\s+|import\s+|declare\s+module\s+)(['"])([^'"]+)\2/g, (m, kw, q, spec) => {
    return kw + q + rewriteSpec(fileDir, spec) + q;
  });
}

const files = walk(WUNK);
const ambientAbs = AMBIENT_REL ? path.join(WUNK, AMBIENT_REL) : null;
let moduleBlocks = [];
let ambientTop = '';
let n = 0;
for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  const dir = path.dirname(f);
  const rewritten = rewriteImports(content, dir);
  if (f === ambientAbs) {
    // Emit ambient.d.ts as a SEPARATE module file (NOT concatenated into the
    // barrel — that's what broke the barrel's script-ness). It keeps its top-level
    // imports (rewritten to @wunk specifiers, which resolve to the barrel's ambient
    // modules with no FS) and its `declare global {}` — the correct pattern for a
    // module that declares globals. main.ts references both files.
    ambientTop = rewritten;
    continue;
  }
  const spec = specOf(f);
  moduleBlocks.push(`declare module "${spec}" {\n${rewritten}\n}`);
  n++;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const barrel = moduleBlocks.join('\n') + '\n';
fs.writeFileSync(OUT, barrel);
console.log(`barrel: ${n} declare-module blocks (script), ${(barrel.length/1e6).toFixed(1)}MB -> ${OUT}`);
if (ambientAbs) {
  if (!ambientTop) { console.error(`ambient file not found in closure: ${AMBIENT_REL} (pass --ambient "" to skip)`); process.exit(1); }
  const AMB = path.join(path.dirname(OUT), 'ambient.d.ts');
  fs.writeFileSync(AMB, ambientTop);
  console.log(`ambient: separate module file -> ${AMB}`);
}
