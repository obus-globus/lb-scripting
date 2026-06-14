// LB Script IDE — browser-only: Monaco type-checking against
// @wunk/lb-script-api-types + esbuild-wasm build → downloadable .mjs.
// Multiple projects (tab bar), each seeded from a real LB template and persisted
// independently in IndexedDB. Build matches the template conventions:
// JVM-type value imports → Java.type(...), and `lb-inject` → its inlined runtime.

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
const DB = "lb-ide", P_STORE = "projects", M_STORE = "meta";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(P_STORE)) db.createObjectStore(P_STORE); if (!db.objectStoreNames.contains(M_STORE)) db.createObjectStore(M_STORE); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function dbGet(store, key) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(store, "readonly").objectStore(store).get(key); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); }); }
async function dbPut(store, key, val) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(store, "readwrite").objectStore(store).put(val, key); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); }
async function dbDel(store, key) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(store, "readwrite").objectStore(store).delete(key); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); }

// ---------------------------------------------------------------- state
let TEMPLATES = [];
let INJECT_DTS = "";
let injectBundle = null; // lazily fetched lb-inject runtime
let baseExtraLibs = [];

let meta = { ids: [], current: null };   // open project tabs + selection
let proj = null;                          // current project { id, name, templateId, files, active }
const models = new Map();                 // path -> monaco model (current project only)
let editor = null, lastBuild = null, saveTimer = null;

const $ = (id) => document.getElementById(id);
function log(msg, cls) { const el = $("log"); const line = document.createElement("div"); if (cls) line.className = cls; line.textContent = msg; el.appendChild(line); el.scrollTop = el.scrollHeight; }
const setStatus = (s) => ($("status").textContent = s);
const uid = () => "p-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

// ---------------------------------------------------------------- monaco cfg
function configureTS(defaults, isJs) {
  const t = monaco.languages.typescript;
  // moduleDetection: Force (3) — every file is its own module, so the many
  // example files don't collide in a shared global scope (matches the templates).
  defaults.setCompilerOptions({ target: t.ScriptTarget.ES2022, module: t.ModuleKind.ESNext, moduleResolution: t.ModuleResolutionKind.NodeJs, moduleDetection: 3, lib: ["es2023"], types: ["@wunk/lb-script-api-types/ambient"], strict: true, skipLibCheck: true, allowNonTsExtensions: true, noEmit: true, ...(isJs ? { allowJs: true, checkJs: true } : {}) });
  defaults.setExtraLibs(baseExtraLibs);
  defaults.setEagerModelSync(true);
}
const langFor = (p) => (p.endsWith(".js") ? "javascript" : "typescript");
const uriFor = (path) => monaco.Uri.parse("file:///" + proj.id + "/" + path);

function disposeModels() { for (const m of models.values()) m.dispose(); models.clear(); }
function ensureModel(path) {
  let m = models.get(path);
  if (!m) {
    m = monaco.editor.createModel(proj.files[path], langFor(path), uriFor(path));
    m.onDidChangeContent(() => { proj.files[path] = m.getValue(); scheduleSave(); });
    models.set(path, m);
  }
  return m;
}
function openFile(path) { proj.active = path; editor.setModel(ensureModel(path)); renderFiles(); scheduleSave(); }

const collapsed = new Set(); // folder paths the user has collapsed (per session)

// Build a nested tree from file paths + any explicitly-created empty folders.
function buildTree() {
  const root = { dirs: new Map(), files: [] };
  const ensureDir = (parts) => { let n = root; let acc = ""; for (const p of parts) { acc = acc ? acc + "/" + p : p; if (!n.dirs.has(p)) n.dirs.set(p, { path: acc, dirs: new Map(), files: [] }); n = n.dirs.get(p); } return n; };
  for (const f of proj.folders || []) ensureDir(f.split("/").filter(Boolean));
  for (const path of Object.keys(proj.files)) { const parts = path.split("/"); const file = parts.pop(); const dir = ensureDir(parts); dir.files.push({ name: file, path }); }
  return root;
}
function deleteFile(path) {
  delete proj.files[path]; const m = models.get(path); if (m) { m.dispose(); models.delete(path); }
  if (proj.active === path) proj.active = Object.keys(proj.files)[0] || null;
  if (proj.active) openFile(proj.active); else { editor.setModel(null); renderFiles(); }
  scheduleSave();
}
function deleteFolder(folderPath) {
  for (const p of Object.keys(proj.files)) if (p === folderPath || p.startsWith(folderPath + "/")) { delete proj.files[p]; const m = models.get(p); if (m) { m.dispose(); models.delete(p); } }
  proj.folders = (proj.folders || []).filter((f) => f !== folderPath && !f.startsWith(folderPath + "/"));
  if (proj.active && !proj.files[proj.active]) proj.active = Object.keys(proj.files)[0] || null;
  if (proj.active) openFile(proj.active); else { editor.setModel(null); renderFiles(); }
  scheduleSave();
}
function addFileAt(dirPath) {
  const rel = prompt("New file" + (dirPath ? " in " + dirPath : "") + " (e.g. util.ts or lib/util.ts):"); if (!rel) return;
  const path = (dirPath ? dirPath + "/" : "") + rel.replace(/^\/+/, "");
  if (path in proj.files) return openFile(path);
  proj.files[path] = langFor(path) === "javascript" ? "// @ts-check\n" : "";
  collapsed.delete(dirPath); openFile(path);
}
function addFolderAt(dirPath) {
  const rel = prompt("New folder" + (dirPath ? " in " + dirPath : "") + ":"); if (!rel) return;
  const path = (dirPath ? dirPath + "/" : "") + rel.replace(/^\/+|\/+$/g, "");
  proj.folders = proj.folders || []; if (!proj.folders.includes(path)) proj.folders.push(path);
  collapsed.delete(dirPath); renderFiles(); scheduleSave();
}

function renderFiles() {
  const wrap = $("files"); wrap.innerHTML = "";
  const tree = buildTree();
  const render = (node, depth) => {
    const pad = (d) => "calc(" + d + " * 12px + 8px)";
    for (const [name, dir] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const isCol = collapsed.has(dir.path);
      const row = document.createElement("div"); row.className = "file folder"; row.style.paddingLeft = pad(depth);
      const label = document.createElement("span"); label.className = "fname"; label.textContent = (isCol ? "▸ " : "▾ ") + name + "/";
      label.onclick = () => { if (isCol) collapsed.delete(dir.path); else collapsed.add(dir.path); renderFiles(); };
      row.appendChild(label);
      const acts = document.createElement("span"); acts.className = "acts";
      const add = document.createElement("span"); add.className = "x add"; add.textContent = "＋"; add.title = "new file in " + dir.path; add.onclick = (e) => { e.stopPropagation(); addFileAt(dir.path); };
      const del = document.createElement("span"); del.className = "x"; del.textContent = "✕"; del.title = "delete folder"; del.onclick = (e) => { e.stopPropagation(); if (confirm("Delete folder " + dir.path + " and its files?")) deleteFolder(dir.path); };
      acts.append(add, del); row.appendChild(acts);
      wrap.appendChild(row);
      if (!isCol) render(dir, depth + 1);
    }
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const row = document.createElement("div"); row.className = "file" + (f.path === proj.active ? " active" : ""); row.style.paddingLeft = pad(depth);
      const name = document.createElement("span"); name.className = "fname"; name.textContent = f.name; name.onclick = () => openFile(f.path); row.appendChild(name);
      const x = document.createElement("span"); x.className = "x"; x.textContent = "✕"; x.onclick = (e) => { e.stopPropagation(); deleteFile(f.path); }; row.appendChild(x);
      wrap.appendChild(row);
    }
  };
  render(tree, 0);
}

// ---------------------------------------------------------------- projects
async function loadProject(id) {
  const p = await dbGet(P_STORE, id);
  if (!p) return false;
  proj = p; disposeModels();
  for (const path of Object.keys(proj.files)) ensureModel(path);
  meta.current = id; location.hash = id;
  openFile(proj.active && proj.files[proj.active] ? proj.active : Object.keys(proj.files)[0]);
  renderTabs();
  return true;
}
function templateById(tid) { return TEMPLATES.find((t) => t.id === tid) || TEMPLATES[0]; }
async function createProject(templateId, opts = {}) {
  const t = templateById(templateId);
  const n = meta.ids.filter((id) => id.startsWith("p-")).length + 1;
  const entry = "main.ts" in t.files ? "main.ts" : "main.js" in t.files ? "main.js" : Object.keys(t.files)[0];
  proj = { id: uid(), name: opts.name || t.name + " " + n, templateId: t.id, files: JSON.parse(JSON.stringify(t.files)), folders: [], active: entry, updatedAt: Date.now() };
  meta.ids.push(proj.id); meta.current = proj.id;
  await saveProject(); await saveMeta();
  disposeModels();
  for (const path of Object.keys(proj.files)) ensureModel(path);
  location.hash = proj.id;
  openFile(proj.active); renderTabs();
  return proj.id;
}
async function closeProject(id) {
  await dbDel(P_STORE, id);
  meta.ids = meta.ids.filter((x) => x !== id);
  if (!meta.ids.length) { await saveMeta(); return createProject("default-ts"); }
  await saveMeta();
  if (meta.current === id) await loadProject(meta.ids[meta.ids.length - 1]); else renderTabs();
}
function renderTabs() {
  const wrap = $("tabs"); wrap.innerHTML = "";
  for (const id of meta.ids) {
    const tab = document.createElement("div"); tab.className = "ptab" + (id === meta.current ? " active" : "");
    const isCur = id === meta.current;
    const label = isCur ? proj : null;
    const name = document.createElement("span"); name.textContent = (label ? label.name : id);
    name.onclick = () => { if (id !== meta.current) loadProject(id); };
    tab.appendChild(name);
    const x = document.createElement("span"); x.className = "x"; x.textContent = "✕"; x.title = "close project";
    x.onclick = (e) => { e.stopPropagation(); if (confirm("Close & delete this project?")) closeProject(id); };
    tab.appendChild(x);
    wrap.appendChild(tab);
  }
  const plus = document.createElement("button"); plus.id = "newProj"; plus.textContent = "+ new"; plus.onclick = showTemplateMenu;
  wrap.appendChild(plus);
  // tab names for non-current projects are their ids until loaded; fetch names
  hydrateTabNames();
}
async function hydrateTabNames() {
  const spans = [...$("tabs").querySelectorAll(".ptab")];
  for (let i = 0; i < meta.ids.length; i++) {
    const id = meta.ids[i];
    if (id === meta.current) continue;
    const p = await dbGet(P_STORE, id);
    if (p && spans[i]) spans[i].firstChild.textContent = p.name;
  }
}
function showTemplateMenu() {
  const menu = $("tmplMenu"); menu.innerHTML = "";
  for (const t of TEMPLATES) {
    const item = document.createElement("div"); item.className = "item";
    item.innerHTML = "<b>" + t.name + "</b><span>" + t.description + "</span>";
    item.onclick = () => { menu.style.display = "none"; createProject(t.id); };
    menu.appendChild(item);
  }
  const r = $("newProj").getBoundingClientRect();
  menu.style.left = Math.max(6, r.left) + "px"; menu.style.top = r.bottom + 4 + "px"; menu.style.display = "block";
}
document.addEventListener("click", (e) => { const m = $("tmplMenu"); if (m.style.display === "block" && !m.contains(e.target) && e.target.id !== "newProj") m.style.display = "none"; });

function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveProject(); saveMeta(); }, 300); }
async function saveProject() { if (!proj) return; proj.updatedAt = Date.now(); await dbPut(P_STORE, proj.id, proj); }
async function saveMeta() { await dbPut(M_STORE, "open", meta); }

// ---------------------------------------------------------------- build
let esbuildReady = null;
function initEsbuild() { if (!esbuildReady) esbuildReady = esbuild.initialize({ wasmURL: "esbuild.wasm" }); return esbuildReady; }
async function ensureInjectBundle() { if (injectBundle == null) injectBundle = await fetch("lb-inject-bundled.js").then((r) => r.text()); return injectBundle; }

function buildPlugins(files) {
  const dir = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
  const join = (base, rel) => { const parts = (base + "/" + rel).split("/"); const out = []; for (const s of parts) { if (s === "" || s === ".") continue; if (s === "..") out.pop(); else out.push(s); } return out.join("/"); };
  const norm = (p) => p.replace(/^\/+/, "");
  const TYPES = "@wunk/lb-script-api-types/types/";
  return {
    name: "lb",
    setup(build) {
      // JVM-type value import → Java.type("<fqcn>")  (matches the template build)
      build.onResolve({ filter: /^@wunk\/lb-script-api-types\/types\// }, (a) => ({ path: a.path, namespace: "jvm" }));
      build.onLoad({ filter: /.*/, namespace: "jvm" }, (a) => {
        const fqcn = a.path.slice(TYPES.length).replace(/\//g, "."); const name = fqcn.slice(fqcn.lastIndexOf(".") + 1);
        return { contents: `export const ${name} = Java.type(${JSON.stringify(fqcn)});`, loader: "js" };
      });
      // any other @wunk/* import is types-only → empty
      build.onResolve({ filter: /^@wunk\// }, (a) => ({ path: a.path, namespace: "empty" }));
      // lb-inject → inlined runtime + re-export of the global it defines
      build.onResolve({ filter: /^lb-inject$/ }, () => ({ path: "lb-inject", namespace: "lbinject" }));
      build.onLoad({ filter: /.*/, namespace: "lbinject" }, () => ({ contents: "globalThis.__nfLibConsumed = true;\n" + (injectBundle || "") + "\nexport const Inject = globalThis.Inject;", loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
      // project files
      build.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point") return { path: norm(a.path), namespace: "vfs" };
        let p = a.path; if (p.startsWith("./") || p.startsWith("../")) p = join(dir(a.importer), p); p = norm(p);
        const cands = [p, p + ".ts", p + ".js", p + "/index.ts", p + "/index.js"]; const hit = cands.find((c) => c in files);
        return { path: hit || p, namespace: "vfs" };
      });
      build.onLoad({ filter: /.*/, namespace: "vfs" }, (a) => { const c = files[a.path]; if (c == null) return { errors: [{ text: "not in project: " + a.path }] }; return { contents: c, loader: a.path.endsWith(".js") ? "js" : "ts" }; });
    },
  };
}
const entryPoint = () => ("main.ts" in proj.files ? "main.ts" : "main.js" in proj.files ? "main.js" : Object.keys(proj.files)[0]);

async function build() {
  $("build").disabled = true; setStatus("building…");
  try {
    await initEsbuild();
    if (Object.values(proj.files).some((c) => /from\s+["']lb-inject["']/.test(c))) await ensureInjectBundle();
    const entry = entryPoint();
    const res = await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", target: "es2022", write: false, plugins: [buildPlugins(proj.files)], legalComments: "none" });
    const code = res.outputFiles[0].text;
    lastBuild = { name: entry.replace(/\.(ts|js)$/, "") + ".mjs", code };
    $("download").disabled = false;
    log("✓ built " + lastBuild.name + " — " + code.length + " bytes", "s");
    for (const w of res.warnings) log("warn: " + w.text, "d");
    setStatus("build ok");
  } catch (e) {
    const errs = (e && e.errors) || [];
    if (errs.length) for (const er of errs) log("✗ " + (er.location ? er.location.file + ": " : "") + er.text, "e");
    else log("✗ build failed: " + (e && e.message || e), "e");
    setStatus("build failed");
  } finally { $("build").disabled = false; }
}
function download() { if (!lastBuild) return; const blob = new Blob([lastBuild.code], { type: "text/javascript" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = lastBuild.name; a.click(); URL.revokeObjectURL(a.href); }

// ---------------------------------------------------------------- init
require(["vs/editor/editor.main"], async () => {
  setStatus("loading templates + typings…");
  [TEMPLATES, INJECT_DTS] = await Promise.all([
    fetch("templates.json").then((r) => r.json()).then((d) => d.templates),
    fetch("lb-inject.d.ts").then((r) => r.text()),
  ]);
  const bundle = await fetch("typings-bundle.json").then((r) => r.json());
  baseExtraLibs = Object.entries(bundle).map(([p, content]) => ({ content, filePath: "file:///" + p }));
  baseExtraLibs.push({ content: INJECT_DTS, filePath: "file:///node_modules/@types/lb-inject/index.d.ts" });
  configureTS(monaco.languages.typescript.typescriptDefaults, false);
  configureTS(monaco.languages.typescript.javascriptDefaults, true);

  editor = monaco.editor.create($("editor"), { theme: "vs-dark", automaticLayout: true, fontSize: 13, minimap: { enabled: false } });

  meta = (await dbGet(M_STORE, "open")) || { ids: [], current: null };
  const wanted = location.hash.replace(/^#/, "");
  if (wanted && meta.ids.includes(wanted)) await loadProject(wanted);
  else if (meta.current && meta.ids.includes(meta.current) && (await loadProject(meta.current))) {}
  else if (meta.ids.length && (await loadProject(meta.ids[0]))) {}
  else await createProject("default-ts");

  $("build").onclick = build;
  $("download").onclick = download;
  $("addFile").onclick = () => addFileAt("");
  $("addFolder").onclick = () => addFolderAt("");
  $("rename").onclick = async () => { const n = prompt("Project name:", proj.name); if (!n) return; proj.name = n; await saveProject(); renderTabs(); };

  setStatus("ready");
  log("ready — " + meta.ids.length + " project(s), " + TEMPLATES.length + " templates", "d");

  window.__ide = {
    ready: true,
    templates: () => TEMPLATES.map((t) => t.id),
    listProjects: () => meta.ids.slice(),
    current: () => ({ id: proj.id, name: proj.name, templateId: proj.templateId }),
    listFiles: () => Object.keys(proj.files),
    writeFile: (path, content) => { proj.files[path] = content; openFile(path); },
    openFile: (path) => openFile(path),
    diagnosticsFor: async (path) => { const m = ensureModel(path); const gw = await monaco.languages.typescript.getTypeScriptWorker(); const c = await gw(m.uri); const u = m.uri.toString(); const ds = [...(await c.getSyntacticDiagnostics(u)), ...(await c.getSemanticDiagnostics(u))]; return ds.map((d) => ({ code: d.code })); },
    createProject: (tid) => createProject(tid),
    switchProject: (id) => loadProject(id),
    closeProject: (id) => closeProject(id),
    setActiveValue: (v) => editor.getModel().setValue(v),
    diagnostics: async () => { const m = editor.getModel(); const gw = await monaco.languages.typescript.getTypeScriptWorker(); const c = await gw(m.uri); const u = m.uri.toString(); const ds = [...(await c.getSyntacticDiagnostics(u)), ...(await c.getSemanticDiagnostics(u))]; return ds.map((d) => ({ code: d.code, message: typeof d.messageText === "string" ? d.messageText : d.messageText.messageText })); },
    build: async () => { await build(); return lastBuild; },
    reloadMeta: async () => await dbGet(M_STORE, "open"),
    getProject: async (id) => await dbGet(P_STORE, id),
  };
});
