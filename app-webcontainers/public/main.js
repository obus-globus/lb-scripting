// LB Script IDE — WebContainers edition. Same Monaco type-checking + per-session
// IndexedDB persistence as the esbuild-wasm app, but the BUILD runs a real
// Node + npm + native esbuild toolchain inside a WebContainer (in-tab). This is
// the LB template's actual build pipeline, not a wasm reimplementation.
//
// Requires cross-origin isolation (COOP/COEP headers) — see serve.mjs / Caddy.

const BASE = new URL(".", document.baseURI).href;
self.MonacoEnvironment = {
  getWorkerUrl: () =>
    "data:text/javascript;charset=utf-8," +
    encodeURIComponent(
      `self.MonacoEnvironment={baseUrl:'${BASE}'};importScripts('${BASE}vs/base/worker/workerMain.js');`,
    ),
};
require.config({ paths: { vs: BASE + "vs" } });

// ---------------------------------------------------------------- persistence
const DB = "lb-ide-wc", STORE = "sessions";
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function dbGet(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, "readonly").objectStore(STORE).get(k); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); }); }
async function dbPut(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(v, k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); }

// ---------------------------------------------------------------- session
function sessionId() { let id = location.hash.replace(/^#/, ""); if (!id) { id = "s-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); location.hash = id; } return id; }

const DEFAULT_PROJECT = {
  active: "main.ts",
  files: {
    "main.ts": `/// <reference types="@wunk/lb-script-api-types/ambient" />
import { fmt } from "./util";

const script = registerScript({ name: "MyScript", version: "0.1.0", authors: ["you"] });
const VERBOSE = Setting.boolean({ name: "verbose", default: false });

script.registerModule({ name: "MyScript", category: "Misc" }, (mod) => {
  mod.on("playerJump", () => {
    const p = mc.player;
    if (p === null) return;
    Client.displayChatMessage(fmt(p.position()));
    if (VERBOSE.get()) Client.displayChatMessage("jumped");
  });
});
`,
    "util.ts": `/// <reference types="@wunk/lb-script-api-types/ambient" />
import { Vec3 } from "@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3";

export function fmt(v: Vec3): string {
  return \`x=\${v.x.toFixed(1)} y=\${v.y.toFixed(1)} z=\${v.z.toFixed(1)}\`;
}
`,
  },
};

// in-container build harness (uses the real native esbuild)
const PKG_JSON = JSON.stringify({ name: "lb-script", private: true, type: "module", devDependencies: { esbuild: "^0.23.0" } }, null, 2);
const BUILD_MJS = `import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
const entry = process.argv[2] || "main.ts";
const r = await build({ entryPoints: [entry], bundle: true, format: "esm", target: "es2022", write: false, legalComments: "none" });
await mkdir("dist", { recursive: true });
await writeFile("dist/out.mjs", r.outputFiles[0].text);
console.log("BUILD_OK " + r.outputFiles[0].text.length);
`;

// ---------------------------------------------------------------- state
const SID = sessionId();
let state = { files: {}, active: null };
const models = new Map();
let editor = null, lastBuild = null, saveTimer = null;
let wc = null, booting = null, installed = false, baseMounted = false;

const $ = (id) => document.getElementById(id);
const stripAnsi = (s) => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
function term(msg, cls) { const el = $("term"); const line = document.createElement("span"); if (cls) line.className = cls; line.textContent = stripAnsi(msg); el.appendChild(line); el.scrollTop = el.scrollHeight; }
function termln(msg, cls) { term((msg || "") + "\n", cls); }
const setStatus = (s) => ($("status").textContent = s);

// ---------------------------------------------------------------- monaco
function configureTS(defaults, extraLibs, isJs) {
  const t = monaco.languages.typescript;
  defaults.setCompilerOptions({ target: t.ScriptTarget.ES2022, module: t.ModuleKind.ESNext, moduleResolution: t.ModuleResolutionKind.NodeJs, lib: ["es2023"], types: ["@wunk/lb-script-api-types/ambient"], strict: true, skipLibCheck: true, allowNonTsExtensions: true, noEmit: true, ...(isJs ? { allowJs: true, checkJs: true } : {}) });
  defaults.setExtraLibs(extraLibs);
  defaults.setEagerModelSync(true);
}
const uriFor = (p) => monaco.Uri.parse("file:///" + p);
const langFor = (p) => (p.endsWith(".js") ? "javascript" : "typescript");
function ensureModel(path, content) {
  let m = models.get(path);
  if (!m) { m = monaco.editor.createModel(content, langFor(path), uriFor(path)); m.onDidChangeContent(() => { state.files[path] = m.getValue(); scheduleSave(); }); models.set(path, m); }
  return m;
}
function openFile(path) { state.active = path; editor.setModel(ensureModel(path, state.files[path])); renderFiles(); scheduleSave(); }
function renderFiles() {
  const wrap = $("files"); wrap.innerHTML = "";
  for (const path of Object.keys(state.files).sort()) {
    const row = document.createElement("div"); row.className = "file" + (path === state.active ? " active" : "");
    const name = document.createElement("span"); name.textContent = path; name.onclick = () => openFile(path); row.appendChild(name);
    if (Object.keys(state.files).length > 1) {
      const x = document.createElement("span"); x.className = "x"; x.textContent = "✕"; x.onclick = (e) => { e.stopPropagation(); delete state.files[path]; const m = models.get(path); if (m) { m.dispose(); models.delete(path); } if (state.active === path) state.active = Object.keys(state.files)[0]; if (state.active) openFile(state.active); else renderFiles(); scheduleSave(); }; row.appendChild(x);
    }
    wrap.appendChild(row);
  }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
async function save() { await dbPut(SID, { files: state.files, active: state.active, updatedAt: Date.now() }); }

// ---------------------------------------------------------------- webcontainer
async function ensureWC() {
  if (wc) return wc;
  if (!booting) booting = (async () => {
    setStatus("booting WebContainer…"); termln("$ boot webcontainer", "cmd");
    const { WebContainer } = await import("./webcontainer-api.js");
    wc = await WebContainer.boot();
    termln("webcontainer ready (cross-origin isolated: " + self.crossOriginIsolated + ")", "d");
    return wc;
  })();
  return booting;
}
async function mountBase() {
  await ensureWC();
  if (baseMounted) return;
  await wc.mount({ "package.json": { file: { contents: PKG_JSON } }, "build.mjs": { file: { contents: BUILD_MJS } } });
  baseMounted = true;
}
async function writeFiles() {
  for (const [path, contents] of Object.entries(state.files)) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) await wc.fs.mkdir(path.slice(0, slash), { recursive: true }).catch(() => {});
    await wc.fs.writeFile(path, contents);
  }
}
async function run(cmd, args) {
  termln("$ " + cmd + " " + args.join(" "), "cmd");
  const p = await wc.spawn(cmd, args);
  p.output.pipeTo(new WritableStream({ write: (d) => term(d) }));
  return await p.exit;
}
async function npmInstall() {
  await mountBase();
  const code = await run("npm", ["install"]);
  installed = code === 0;
  termln(code === 0 ? "✓ install ok" : "✗ install failed (" + code + ")", code === 0 ? "s" : "e");
  return code;
}
function entryPoint() { if ("main.ts" in state.files) return "main.ts"; if ("main.js" in state.files) return "main.js"; return Object.keys(state.files)[0]; }

async function build() {
  $("build").disabled = true; $("install").disabled = true;
  try {
    await mountBase();
    await writeFiles();
    if (!installed) { if ((await npmInstall()) !== 0) return; }
    const entry = entryPoint();
    const code = await run("node", ["build.mjs", entry]);
    if (code !== 0) { termln("✗ build failed (" + code + ")", "e"); setStatus("build failed"); return; }
    const out = await wc.fs.readFile("dist/out.mjs", "utf8");
    lastBuild = { name: entry.replace(/\.(ts|js)$/, "") + ".mjs", code: out };
    $("download").disabled = false;
    termln("✓ built " + lastBuild.name + " — " + out.length + " bytes", "s");
    setStatus("build ok");
  } catch (e) { termln("✗ " + (e && e.message || e), "e"); setStatus("error"); }
  finally { $("build").disabled = false; $("install").disabled = false; }
}
function download() { if (!lastBuild) return; const blob = new Blob([lastBuild.code], { type: "text/javascript" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = lastBuild.name; a.click(); URL.revokeObjectURL(a.href); }

// ---------------------------------------------------------------- init
require(["vs/editor/editor.main"], async () => {
  setStatus("loading typings…");
  const bundle = await fetch("typings-bundle.json").then((r) => r.json());
  const extraLibs = Object.entries(bundle).map(([p, content]) => ({ content, filePath: "file:///" + p }));
  configureTS(monaco.languages.typescript.typescriptDefaults, extraLibs, false);
  configureTS(monaco.languages.typescript.javascriptDefaults, extraLibs, true);

  $("sid").innerHTML = "session <code>" + SID + "</code>";
  const saved = await dbGet(SID);
  state = saved ? { files: saved.files, active: saved.active } : { files: { ...DEFAULT_PROJECT.files }, active: DEFAULT_PROJECT.active };

  editor = monaco.editor.create($("editor"), { theme: "vs-dark", automaticLayout: true, fontSize: 13, minimap: { enabled: false } });
  for (const path of Object.keys(state.files)) ensureModel(path, state.files[path]);
  openFile(state.active || Object.keys(state.files)[0]);
  if (!saved) await save();

  $("build").onclick = build;
  $("install").onclick = () => { $("install").disabled = true; mountBase().then(writeFiles).then(npmInstall).finally(() => ($("install").disabled = false)); };
  $("download").onclick = download;
  $("addFile").onclick = () => { const name = prompt("New file name (e.g. helper.ts):"); if (!name) return; if (name in state.files) return openFile(name); state.files[name] = langFor(name) === "javascript" ? "// @ts-check\n" : ""; openFile(name); };
  $("newSession").onclick = () => { location.hash = ""; location.reload(); };

  setStatus("ready");
  termln("ready — session " + SID + " — press 'install & build' to run the real toolchain in-tab", "d");

  window.__ide = {
    ready: true, sid: SID,
    listFiles: () => Object.keys(state.files),
    setActiveValue: (v) => editor.getModel().setValue(v),
    diagnostics: async () => { const m = editor.getModel(); const gw = await monaco.languages.typescript.getTypeScriptWorker(); const c = await gw(m.uri); const u = m.uri.toString(); const ds = [...(await c.getSyntacticDiagnostics(u)), ...(await c.getSemanticDiagnostics(u))]; return ds.map((d) => ({ code: d.code, message: typeof d.messageText === "string" ? d.messageText : d.messageText.messageText })); },
    build: async () => { await build(); return lastBuild; },
    reloadFromDb: async () => await dbGet(SID),
  };
});
