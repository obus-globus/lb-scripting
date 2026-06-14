// LB Script IDE — browser-only: Monaco type-checking against
// @wunk/lb-script-api-types + esbuild-wasm build → downloadable .mjs, with
// per-session IndexedDB persistence. No backend; each session is isolated.

// ---- Monaco AMD workers need an absolute baseUrl under a plain script tag ----
self.MonacoEnvironment = {
  getWorkerUrl: () =>
    "data:text/javascript;charset=utf-8," +
    encodeURIComponent(
      `self.MonacoEnvironment={baseUrl:'${location.origin}/'};importScripts('${location.origin}/vs/base/worker/workerMain.js');`,
    ),
};
require.config({ paths: { vs: "vs" } });

// ---------------------------------------------------------------- persistence
const DB = "lb-ide";
const STORE = "sessions";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    t.onsuccess = () => res(t.result || null);
    t.onerror = () => rej(t.error);
  });
}
async function dbPut(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(val, key);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}

// ---------------------------------------------------------------- session id
function sessionId() {
  let id = location.hash.replace(/^#/, "");
  if (!id) {
    id = "s-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    location.hash = id;
  }
  return id;
}

// ---------------------------------------------------------------- default proj
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

// ---------------------------------------------------------------- state
const SID = sessionId();
let state = { files: {}, active: null };
const models = new Map(); // path -> monaco model
let editor = null;
let lastBuild = null; // { name, code }
let saveTimer = null;

const $ = (id) => document.getElementById(id);
function log(msg, cls) {
  const el = $("log");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
const setStatus = (s) => ($("status").textContent = s);

// ---------------------------------------------------------------- monaco setup
function configureTS(defaults, extraLibs, isJs) {
  const t = monaco.languages.typescript;
  defaults.setCompilerOptions({
    target: t.ScriptTarget.ES2022,
    module: t.ModuleKind.ESNext,
    moduleResolution: t.ModuleResolutionKind.NodeJs,
    lib: ["es2023"],
    types: ["@wunk/lb-script-api-types/ambient"],
    strict: true,
    skipLibCheck: true,
    allowNonTsExtensions: true,
    noEmit: true,
    ...(isJs ? { allowJs: true, checkJs: true } : {}),
  });
  defaults.setExtraLibs(extraLibs);
  defaults.setEagerModelSync(true);
}

function uriFor(path) {
  return monaco.Uri.parse("file:///" + path);
}
function langFor(path) {
  return path.endsWith(".js") ? "javascript" : "typescript";
}

function ensureModel(path, content) {
  let m = models.get(path);
  if (!m) {
    m = monaco.editor.createModel(content, langFor(path), uriFor(path));
    m.onDidChangeContent(() => {
      state.files[path] = m.getValue();
      scheduleSave();
    });
    models.set(path, m);
  }
  return m;
}

function openFile(path) {
  state.active = path;
  const m = ensureModel(path, state.files[path]);
  editor.setModel(m);
  renderFiles();
  scheduleSave();
}

function renderFiles() {
  const wrap = $("files");
  wrap.innerHTML = "";
  for (const path of Object.keys(state.files).sort()) {
    const row = document.createElement("div");
    row.className = "file" + (path === state.active ? " active" : "");
    const name = document.createElement("span");
    name.textContent = path;
    name.onclick = () => openFile(path);
    row.appendChild(name);
    if (Object.keys(state.files).length > 1) {
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "✕";
      x.title = "delete";
      x.onclick = (e) => {
        e.stopPropagation();
        delete state.files[path];
        const m = models.get(path);
        if (m) { m.dispose(); models.delete(path); }
        if (state.active === path) state.active = Object.keys(state.files)[0];
        if (state.active) openFile(state.active);
        else renderFiles();
        scheduleSave();
      };
      row.appendChild(x);
    }
    wrap.appendChild(row);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}
async function save() {
  await dbPut(SID, { files: state.files, active: state.active, updatedAt: Date.now() });
}

// ---------------------------------------------------------------- esbuild build
let esbuildReady = null;
function initEsbuild() {
  if (!esbuildReady) esbuildReady = esbuild.initialize({ wasmURL: "esbuild.wasm" });
  return esbuildReady;
}
function vfsPlugin(files) {
  const dir = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
  const join = (base, rel) => {
    const parts = (base + "/" + rel).split("/");
    const out = [];
    for (const seg of parts) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return out.join("/");
  };
  const norm = (p) => p.replace(/^\/+/, "");
  return {
    name: "vfs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith("@wunk/")) return { path: args.path, namespace: "empty" };
        if (args.kind === "entry-point") return { path: norm(args.path), namespace: "vfs" };
        let p = args.path;
        if (p.startsWith("./") || p.startsWith("../")) p = join(dir(args.importer), p);
        p = norm(p);
        const cands = [p, p + ".ts", p + ".js", p + "/index.ts", p + "/index.js"];
        const hit = cands.find((c) => c in files);
        return { path: hit || p, namespace: "vfs" };
      });
      build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "vfs" }, (args) => {
        const contents = files[args.path];
        if (contents == null) return { errors: [{ text: "not found in project: " + args.path }] };
        return { contents, loader: args.path.endsWith(".js") ? "js" : "ts" };
      });
    },
  };
}

function entryPoint() {
  if ("main.ts" in state.files) return "main.ts";
  if ("main.js" in state.files) return "main.js";
  return Object.keys(state.files)[0];
}

async function build() {
  $("build").disabled = true;
  setStatus("building…");
  try {
    await initEsbuild();
    const entry = entryPoint();
    const res = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      target: "es2022",
      write: false,
      plugins: [vfsPlugin(state.files)],
      legalComments: "none",
    });
    const code = res.outputFiles[0].text;
    const name = entry.replace(/\.(ts|js)$/, "") + ".mjs";
    lastBuild = { name, code };
    $("download").disabled = false;
    log(`✓ built ${name} — ${code.length} bytes`, "s");
    if (res.warnings.length) for (const w of res.warnings) log("warn: " + w.text, "d");
    setStatus("build ok");
  } catch (e) {
    const errs = (e && e.errors) || [];
    if (errs.length) for (const er of errs) log("✗ " + (er.location ? er.location.file + ": " : "") + er.text, "e");
    else log("✗ build failed: " + (e && e.message || e), "e");
    setStatus("build failed");
  } finally {
    $("build").disabled = false;
  }
}

function download() {
  if (!lastBuild) return;
  const blob = new Blob([lastBuild.code], { type: "text/javascript" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = lastBuild.name;
  a.click();
  URL.revokeObjectURL(a.href);
  log("downloaded " + lastBuild.name, "d");
}

// ---------------------------------------------------------------- init
require(["vs/editor/editor.main"], async () => {
  setStatus("loading typings…");
  const bundle = await fetch("typings-bundle.json").then((r) => r.json());
  const extraLibs = Object.entries(bundle).map(([p, content]) => ({ content, filePath: "file:///" + p }));
  configureTS(monaco.languages.typescript.typescriptDefaults, extraLibs, false);
  configureTS(monaco.languages.typescript.javascriptDefaults, extraLibs, true);

  $("sid").innerHTML = "session <code>" + SID + "</code>";

  // Load this session, or seed a fresh default project.
  const saved = await dbGet(SID);
  state = saved
    ? { files: saved.files, active: saved.active }
    : { files: { ...DEFAULT_PROJECT.files }, active: DEFAULT_PROJECT.active };

  editor = monaco.editor.create($("editor"), {
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: false },
  });
  for (const path of Object.keys(state.files)) ensureModel(path, state.files[path]);
  openFile(state.active || Object.keys(state.files)[0]);
  if (!saved) await save();

  $("build").onclick = build;
  $("download").onclick = download;
  $("addFile").onclick = () => {
    const name = prompt("New file name (e.g. helper.ts):");
    if (!name) return;
    if (name in state.files) return openFile(name);
    state.files[name] = langFor(name) === "javascript" ? "// @ts-check\n" : "";
    openFile(name);
  };
  $("newSession").onclick = () => {
    location.hash = "";
    location.reload();
  };

  setStatus("ready");
  log("ready — session " + SID + ", " + Object.keys(state.files).length + " files", "d");

  // hooks for the headless verifier
  window.__ide = {
    ready: true,
    sid: SID,
    listFiles: () => Object.keys(state.files),
    setActiveValue: (v) => editor.getModel().setValue(v),
    diagnostics: async () => {
      const m = editor.getModel();
      const getW = await monaco.languages.typescript.getTypeScriptWorker();
      const c = await getW(m.uri);
      const u = m.uri.toString();
      const ds = [...(await c.getSyntacticDiagnostics(u)), ...(await c.getSemanticDiagnostics(u))];
      return ds.map((d) => ({ code: d.code, message: typeof d.messageText === "string" ? d.messageText : d.messageText.messageText }));
    },
    build: async () => { await build(); return lastBuild; },
    reloadFromDb: async () => await dbGet(SID),
  };
});
