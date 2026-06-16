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

// In-client host bridge auth: the host embeds a per-session token in the editor
// URL; we send it as a custom header on every /api/* call (and as ?token= on the
// SSE stream, since EventSource can't set headers). The custom header forces a
// CORS preflight that fails cross-origin, so other web pages can't drive the host.
const API_TOKEN = new URLSearchParams(location.search).get("token") || "";
// The host-API bridge client lives in @lb-ide/core (shared with the heavy editor);
// it's created at init. apiFetch routes through it once ready, with an identical
// inline fallback for any call before the (dynamically-imported) bridge loads.
let bridge = null;
function apiFetch(p, opts = {}) { return bridge ? bridge.call(p, opts) : fetch(BASE + p, { ...opts, headers: { ...(opts.headers || {}), "X-IDE-Token": API_TOKEN } }); }

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
let CATEGORIES = [];                      // bundled templates (templates.json)
let userTemplates = [];                   // user template docs from the bridge (lb-ide/templates/)
let fetchedTemplates = [];                // templates fetched from the default source (in-memory, stripped)
let INJECT_DTS = "";
// Default template source: a CI-generated templates.json published in the repo,
// fetched at runtime (CORS-clean raw URL — no token, no host). v1 ships ONLY this
// single trusted source (no add-custom-repo UI); fetched files are STRIPPED on import.
const TEMPLATE_SOURCE = {
  id: "lb-scripting",
  name: "lb-scripting",
  // Published at repo root by the gen-templates Action (outside templates/ → no trigger loop).
  url: "https://raw.githubusercontent.com/obus-globus/lb-scripting/master/templates.json",
};
let injectBundle = null; // lazily fetched lb-inject runtime
let baseExtraLibs = [];

let meta = { ids: [], current: null };   // open project tabs + selection
let proj = null;                          // current project { id, name, templateId, files, active }
let bridgeOn = false;                     // talking to the in-client host (lb-ide-host)
let autoRun = false, debugOn = false;     // hot-reload + debug toggles (in-client)
let hotReloadFn = null, hotTimer = null;
const models = new Map();                 // path -> monaco model (current project only)
let editor = null, saveTimer = null;
let libView = null;                        // {uri,name} when viewing a read-only library/decl file
const libFiles = new Map();                // uri -> {uri,name} declaration files shown under "Libraries"
let openLib = () => {};                     // (uri,opts) => open a library file read-only (wired in init)
// VS Code-style preview tabs: a single italic, reusable tab (explorer single-click
// / go-to-def). Pinned by clicking it, double-clicking the file, or editing it.
let preview = null;                        // {kind:"file",path} | {kind:"lib",uri,name} | null
const pinnedLibs = [];                     // [{uri,name}] library tabs the user pinned
const isPreviewFile = (p) => !!preview && preview.kind === "file" && preview.path === p;
const isPreviewLib = (u) => !!preview && preview.kind === "lib" && preview.uri === u;
const isPinnedLib = (u) => pinnedLibs.some((l) => l.uri === u);
function pinFile(path) { if (proj.openTabs && !proj.openTabs.includes(path)) proj.openTabs.push(path); if (isPreviewFile(path)) preview = null; }
function pinLib(lib) { if (!isPinnedLib(lib.uri)) pinnedLibs.push({ uri: lib.uri, name: lib.name }); if (isPreviewLib(lib.uri)) preview = null; }
const builds = new Map();                  // projId -> { name, code } last build (per project)
const currentBuild = () => (proj ? builds.get(proj.id) : null);
function syncDownloadBtn() { const dl = $("download"); if (dl) dl.disabled = !currentBuild(); }

const $ = (id) => document.getElementById(id);
function log(msg, cls) { const el = $("log"); const line = document.createElement("div"); if (cls) line.className = cls; line.textContent = msg; el.appendChild(line); el.scrollTop = el.scrollHeight; }
const setStatus = (s) => ($("status").textContent = s);

// ------- TS language-service status (status bar): checking… → problem count
let typeStatusTimer = null;
function setTypeStatus(state, text) { const el = $("sbTypes"); if (!el) return; el.classList.toggle("checking", state === "checking"); el.textContent = text; }
function refreshTypeStatus() {
  const el = $("sbTypes"); if (!el || !editor) return;
  const model = editor.getModel();
  if (!model) { setTypeStatus("idle", ""); return; }
  let errs = 0, warns = 0;
  for (const m of monaco.editor.getModelMarkers({ resource: model.uri })) {
    if (m.severity === monaco.MarkerSeverity.Error) errs++;
    else if (m.severity === monaco.MarkerSeverity.Warning) warns++;
  }
  setTypeStatus(errs || warns ? "problems" : "ok", errs || warns ? "✕ " + errs + "  ⚠ " + warns : "✓ no problems");
}
function markChecking() { setTypeStatus("checking", "checking…"); clearTimeout(typeStatusTimer); typeStatusTimer = setTimeout(refreshTypeStatus, 1500); }
const uid = () => "p-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

// ---------------------------------------------------------------- version
// Show the IDE version (from public/version.js) and, best-effort, check GitHub
// for a newer release. Fully non-blocking: fire-and-forget, 3s timeout, any
// failure (offline, rate-limited, in-client with no network) is silently ignored.
const IDE = (typeof window !== "undefined" && window.__IDE__) || {};
function cmpVer(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
// Render "vX.Y.Z" in the status bar — a link to the GitHub repo — and, when an
// update is available, append a "update → vX" link to that release.
function renderVer(update) {
  const el = $("ver");
  if (!el) return;
  const cur = IDE.version || "";
  el.textContent = "";
  el.title = "IDE version — open the repo on GitHub";
  if (cur && IDE.repo) {
    const a = document.createElement("a");
    a.href = "https://github.com/" + IDE.repo; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = "v" + cur;
    el.appendChild(a);
  } else el.textContent = cur ? "v" + cur : "";
  if (update) {
    el.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.href = update.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = "update → v" + update.tag;
    a.title = "A newer release (" + update.label + ") is available on GitHub";
    el.appendChild(a);
  }
}
async function checkVersion() {
  const cur = IDE.version || "";
  renderVer(null);
  if (!cur || !IDE.repo) return;
  let timer = null;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch("https://api.github.com/repos/" + IDE.repo + "/releases/latest", { headers: { Accept: "application/vnd.github+json" }, signal: ctrl.signal });
    if (!r.ok) return;
    const rel = await r.json();
    const tag = String(rel.tag_name || "").replace(/^v/, "");
    if (tag && cmpVer(tag, cur) > 0)
      renderVer({ tag, label: rel.tag_name || tag, url: rel.html_url || ("https://github.com/" + IDE.repo + "/releases") });
  } catch { /* offline / aborted / rate-limited — ignore */ }
  finally { if (timer) clearTimeout(timer); }
}

// ---------------------------------------------------------------- monaco cfg
function configureTS(defaults, isJs) {
  const t = monaco.languages.typescript;
  // moduleDetection: Force (3) — every file is its own module, so the many
  // example files don't collide in a shared global scope (matches the templates).
  // NOTE: monaco's ScriptTarget enum lacks ES2022 in this build (undefined →
  // target silently fell back to ES3). Use ESNext (defined) so modern syntax /
  // iterables type-check correctly.
  defaults.setCompilerOptions({ target: t.ScriptTarget.ESNext, module: t.ModuleKind.ESNext, moduleResolution: t.ModuleResolutionKind.NodeJs, moduleDetection: 3, lib: ["es2023"], types: ["@wunk/lb-script-api-types/ambient"], strict: true, skipLibCheck: true, allowNonTsExtensions: true, noEmit: true, ...(isJs ? { allowJs: true, checkJs: true } : {}) });
  defaults.setExtraLibs(jvmExtraLibs());
  defaults.setEagerModelSync(true);
}
const langFor = (p) => (p.endsWith(".js") ? "javascript" : p.endsWith(".json") ? "json" : p.endsWith(".md") ? "markdown" : "typescript");
const uriFor = (path) => monaco.Uri.parse("file:///" + proj.id + "/" + path);

function disposeModels() { for (const m of models.values()) m.dispose(); models.clear(); }
function ensureModel(path) {
  let m = models.get(path);
  if (!m) {
    m = monaco.editor.createModel(proj.files[path], langFor(path), uriFor(path));
    m.onDidChangeContent(() => { proj.files[path] = m.getValue(); scheduleSave(); if (hotReloadFn) hotReloadFn(); if (isPreviewFile(path)) { pinFile(path); renderFtabs(); } scheduleLintAny(); });
    models.set(path, m);
  }
  return m;
}
function openFile(path, opts = {}) {
  // defend against opening a missing/undefined path (e.g. a malformed share or
  // an empty project) — fall back to the first file, or an empty editor.
  if (!path || !(path in proj.files)) path = Object.keys(proj.files)[0];
  if (!path) { proj.active = null; preview = null; editor.setModel(null); renderFiles(); renderFtabs(); return; }
  libView = null; // returning to a project file leaves any read-only library view
  proj.active = path;
  // Monaco compiler options are global; re-apply the active project's JVM-types level
  // when the project changes (cheap-guarded so tab switches within a project don't).
  if (proj.id !== _jvmAppliedFor) { _jvmAppliedFor = proj.id; applyJvmTypes(); }
  if (!proj.openTabs) proj.openTabs = [];
  // preview (explorer single-click / go-to-def): a reusable italic tab, not pinned;
  // anything else pins. Already-open files just activate.
  if (opts.preview && !proj.openTabs.includes(path)) preview = { kind: "file", path };
  else { if (!proj.openTabs.includes(path)) proj.openTabs.push(path); if (isPreviewFile(path)) preview = null; }
  // a supporting/types file (e.g. types/*.d.ts) is hidden unless the toggle is on —
  // turn it on so navigating to one actually reveals it in the tree
  if (isAux(path) && !showAux) setShowAux(true);
  // reveal in the Explorer: expand the file's ancestor folders so its row shows
  collapsed.delete("__ROOT__");
  { const parts = path.split("/"); let acc = ""; for (let i = 0; i < parts.length - 1; i++) { acc = acc ? acc + "/" + parts[i] : parts[i]; collapsed.delete(acc); } }
  editor.setModel(ensureModel(path));
  renderFiles(); renderFtabs(); scheduleSave();
  scheduleLintAny();
  const row = $("files").querySelector(".tv-row.active"); if (row) row.scrollIntoView({ block: "nearest" });
}
function closeTab(path) {
  proj.openTabs = (proj.openTabs || []).filter((p) => p !== path);
  if (isPreviewFile(path)) preview = null;
  if (!libView && proj.active === path) {
    const next = proj.openTabs[proj.openTabs.length - 1];
    if (next) openFile(next);
    else if (preview && preview.kind === "file") openFile(preview.path, { preview: true });
    else { proj.active = null; editor.setModel(null); renderFiles(); renderFtabs(); scheduleSave(); }
  } else { renderFtabs(); scheduleSave(); }
}
function closeLibTab(uri) {
  const i = pinnedLibs.findIndex((l) => l.uri === uri); if (i >= 0) pinnedLibs.splice(i, 1);
  if (isPreviewLib(uri)) preview = null;
  if (libView && libView.uri === uri) {
    libView = null;
    if (proj.active && proj.files[proj.active]) openFile(proj.active);
    else { editor.setModel(null); renderFiles(); renderFtabs(); }
  } else { renderFiles(); renderFtabs(); }
}
function renderFtabs() {
  const wrap = $("ftabs"); wrap.innerHTML = "";
  const mkFile = (path, isPreview) => {
    if (!(path in proj.files)) return;
    const tab = document.createElement("div"); tab.className = "ftab" + (!libView && path === proj.active ? " active" : "") + (isPreview ? " preview" : "");
    const slash = path.lastIndexOf("/");
    const label = document.createElement("span");
    if (slash >= 0) { const dir = document.createElement("span"); dir.className = "dir"; dir.textContent = path.slice(0, slash + 1); label.appendChild(dir); label.appendChild(document.createTextNode(path.slice(slash + 1))); }
    else label.textContent = path;
    label.onclick = () => { if (isPreview) pinFile(path); openFile(path); }; // clicking a preview tab pins it
    tab.appendChild(label);
    const x = document.createElement("span"); x.className = "x"; x.textContent = "✕"; x.title = "close tab"; x.onclick = (e) => { e.stopPropagation(); closeTab(path); };
    tab.appendChild(x); wrap.appendChild(tab);
  };
  const mkLib = (lib, isPreview) => {
    const tab = document.createElement("div"); tab.className = "ftab" + (libView && libView.uri === lib.uri ? " active" : "") + (isPreview ? " preview" : "");
    tab.title = "read-only library / declaration file";
    const label = document.createElement("span"); const lock = document.createElement("span"); lock.className = "dir"; lock.textContent = "🔒 "; label.appendChild(lock); label.appendChild(document.createTextNode(lib.name));
    label.onclick = () => { if (isPreview) pinLib(lib); openLib(lib.uri); };
    tab.appendChild(label);
    const x = document.createElement("span"); x.className = "x"; x.textContent = "✕"; x.title = "close"; x.onclick = (e) => { e.stopPropagation(); closeLibTab(lib.uri); };
    tab.appendChild(x); wrap.appendChild(tab);
  };
  for (const path of proj.openTabs || []) mkFile(path, false);
  for (const lib of pinnedLibs) mkLib(lib, false);
  if (preview) { if (preview.kind === "file") mkFile(preview.path, true); else mkLib(preview, true); }
}

const collapsed = new Set(); // folder paths the user has collapsed (per session)
// node_modules + its folders are collapsed by default (like VS Code); a folder
// is shown open only if it's in expandedLibs (so we never eagerly render 6k files)
const LIBROOT = "lib::__ROOT__";
const expandedLibs = new Set();
// path of a library file relative to node_modules (e.g. @types/lb-inject/index.d.ts)
const libRelPath = (uri) => decodeURIComponent(uri.replace(/^file:\/\/\//, "")).replace(/^node_modules\//, "");
let _libTree = null, _libTreeSize = -1;
function buildLibTree() {
  if (_libTree && _libTreeSize === libFiles.size) return _libTree; // memoized (closure ~6k files)
  const root = { dirs: new Map(), files: [] };
  const ensureDir = (parts) => { let n = root, acc = ""; for (const p of parts) { acc = acc ? acc + "/" + p : p; if (!n.dirs.has(p)) n.dirs.set(p, { path: acc, dirs: new Map(), files: [] }); n = n.dirs.get(p); } return n; };
  for (const lf of libFiles.values()) { const parts = libRelPath(lf.uri).split("/"); const file = parts.pop(); ensureDir(parts).files.push({ name: file, uri: lf.uri }); }
  _libTree = root; _libTreeSize = libFiles.size;
  return root;
}
// expand node_modules + the ancestor folders of a library file so it's visible
function revealLibPath(uri) { expandedLibs.add(LIBROOT); const parts = libRelPath(uri).split("/"); parts.pop(); let acc = ""; for (const p of parts) { acc = acc ? acc + "/" + p : p; expandedLibs.add("lib::" + acc); } }
const isAux = (path) => !!(proj && proj.aux && proj.aux.includes(path));
let showAux = localStorage.getItem("lb-ide:showAux") === "1";
function setShowAux(v) { showAux = !!v; localStorage.setItem("lb-ide:showAux", showAux ? "1" : "0"); const b = $("toggleAux"); if (b) b.classList.toggle("on", showAux); renderFiles(); }

// Build a nested tree from file paths + any explicitly-created empty folders.
// includeFn filters which files appear (used to hide supporting/aux files).
function buildTree(includeFn) {
  includeFn = includeFn || (() => true);
  const root = { dirs: new Map(), files: [] };
  const ensureDir = (parts) => { let n = root; let acc = ""; for (const p of parts) { acc = acc ? acc + "/" + p : p; if (!n.dirs.has(p)) n.dirs.set(p, { path: acc, dirs: new Map(), files: [] }); n = n.dirs.get(p); } return n; };
  for (const f of proj.folders || []) ensureDir(f.split("/").filter(Boolean));
  for (const path of Object.keys(proj.files)) { if (!includeFn(path)) continue; const parts = path.split("/"); const file = parts.pop(); const dir = ensureDir(parts); dir.files.push({ name: file, path }); }
  return root;
}
function deleteFile(path) {
  delete proj.files[path]; const m = models.get(path); if (m) { m.dispose(); models.delete(path); }
  proj.openTabs = (proj.openTabs || []).filter((p) => p !== path);
  if (proj.active === path) proj.active = proj.openTabs[proj.openTabs.length - 1] || Object.keys(proj.files)[0] || null;
  if (proj.active) openFile(proj.active); else { editor.setModel(null); renderFiles(); renderFtabs(); }
  scheduleSave();
}
function deleteFolder(folderPath) {
  for (const p of Object.keys(proj.files)) if (p === folderPath || p.startsWith(folderPath + "/")) { delete proj.files[p]; const m = models.get(p); if (m) { m.dispose(); models.delete(p); } }
  proj.folders = (proj.folders || []).filter((f) => f !== folderPath && !f.startsWith(folderPath + "/"));
  proj.openTabs = (proj.openTabs || []).filter((p) => p in proj.files);
  if (proj.active && !proj.files[proj.active]) proj.active = proj.openTabs[proj.openTabs.length - 1] || Object.keys(proj.files)[0] || null;
  if (proj.active) openFile(proj.active); else { editor.setModel(null); renderFiles(); renderFtabs(); }
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

// --- VS Code-ish icons (monochrome SVG, currentColor unless a fill is given) --
const SVG = {
  chevron: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M5.7 6.2L8 8.5l2.3-2.3.7.7L8 9.9 5 6.9z"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path fill="#c09553" d="M1.5 3h4l1.2 1.6H14.5l.5.5v7.9l-.5.5h-13l-.5-.5V3.5z"/></svg>',
  addFile: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.5 1.1l3.4 3.4.1.4v9.6l-.5.5h-9l-.5-.5v-13l.5-.5h5.1l.4.1zM9 2H4v12h8V5H9.5L9 4.5V2zM8 7H7v2H5v1h2v2h1v-2h2V9H8V7z"/></svg>',
  addFolder: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M14.5 4H8.7L7.5 2.6 7.1 2.5H1.5l-.5.5v10l.5.5h13l.5-.5V4.5l-.5-.5zM14 13H2V3.5h4.8l1.2 1.4.4.1H14V13zm-3.5-5H9V6.5H8V8H6.5v1H8v1.5h1V9h1.5V8z"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M10 3h3v1h-1v9.5l-.5.5h-7l-.5-.5V4H3V3h3V2l.5-.5h3l.5.5V3zM5 4v9h6V4H5zm2 1h1v7H7V5zm2 0h1v7H9V5z"/></svg>',
  lib: '<svg viewBox="0 0 16 16"><path fill="#9aa0a6" d="M3 2h3.5l.5.5V13H3.5l-.5-.5v-10zm4.5 0H11l.5.5v10l-.5.5H8V2.5zM12 3.2l1.4.4.3.5-2 9-.4.3-1-.3.3-1.4z"/></svg>',
};
function fileIcon(name) {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const color = ext === "ts" ? "#4e9bd6" : ext === "js" ? "#cbcb41" : ext === "json" ? "#cbcb41" : ext === "md" ? "#519aba" : "#9aa0a6";
  return `<svg viewBox="0 0 16 16"><path fill="${color}" d="M9.5 1H4l-.5.5v13l.5.5h9l.5-.5V5L9.5 1zM9 2.2L11.8 5H9V2.2z"/></svg>`;
}
function allDirPaths() {
  const out = []; const walk = (n) => { for (const [, d] of n.dirs) { out.push(d.path); walk(d); } }; walk(buildTree()); return out;
}

function tvRow({ depth, twisty, iconHtml, label, isActive, isRoot, dim, onClick, onDblClick, actions }) {
  const row = document.createElement("div");
  row.className = "tv-row" + (isActive ? " active" : "") + (isRoot ? " root" : "") + (dim ? " dim" : "");
  for (let i = 0; i < depth; i++) { const ig = document.createElement("span"); ig.className = "ig"; row.appendChild(ig); }
  const tw = document.createElement("span"); tw.className = "tw" + (twisty === "closed" ? " closed" : "");
  if (twisty) tw.innerHTML = SVG.chevron; row.appendChild(tw);
  if (iconHtml) { const ic = document.createElement("span"); ic.className = "ic"; ic.innerHTML = iconHtml; row.appendChild(ic); }
  const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = label; row.appendChild(nm);
  if (actions && actions.length) {
    const acts = document.createElement("span"); acts.className = "acts";
    for (const a of actions) { const b = document.createElement("span"); b.className = "b"; b.title = a.title; b.innerHTML = a.icon; b.onclick = (e) => { e.stopPropagation(); a.run(); }; acts.appendChild(b); }
    row.appendChild(acts);
  }
  row.onclick = onClick;
  if (onDblClick) row.ondblclick = onDblClick;
  return row;
}

function renderFiles() {
  const wrap = $("files"); wrap.innerHTML = "";
  const ROOT = "__ROOT__";
  const rootClosed = collapsed.has(ROOT);
  wrap.appendChild(tvRow({
    depth: 0, twisty: rootClosed ? "closed" : "open", iconHtml: "", label: proj ? proj.name : "", isRoot: true,
    onClick: () => { if (rootClosed) collapsed.delete(ROOT); else collapsed.add(ROOT); renderFiles(); },
    actions: [
      { title: "New File", icon: SVG.addFile, run: () => addFileAt("") },
      { title: "New Folder", icon: SVG.addFolder, run: () => addFolderAt("") },
    ],
  }));
  if (rootClosed) return;

  const filter = (p) => showAux || !isAux(p);
  const render = (node, depth) => {
    for (const [name, dir] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const isCol = collapsed.has(dir.path);
      wrap.appendChild(tvRow({
        depth, twisty: isCol ? "closed" : "open", iconHtml: SVG.folder, label: name,
        onClick: () => { if (isCol) collapsed.delete(dir.path); else collapsed.add(dir.path); renderFiles(); },
        actions: [
          { title: "New File", icon: SVG.addFile, run: () => addFileAt(dir.path) },
          { title: "New Folder", icon: SVG.addFolder, run: () => addFolderAt(dir.path) },
          { title: "Delete", icon: SVG.trash, run: () => { if (confirm("Delete folder " + dir.path + " and its files?")) deleteFolder(dir.path); } },
        ],
      }));
      if (!isCol) render(dir, depth + 1);
    }
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      wrap.appendChild(tvRow({
        depth, twisty: "", iconHtml: fileIcon(f.name), label: f.name, isActive: !libView && f.path === proj.active, dim: isAux(f.path),
        onClick: () => openFile(f.path, { preview: true }), onDblClick: () => openFile(f.path),
        actions: [{ title: "Delete", icon: SVG.trash, run: () => deleteFile(f.path) }],
      }));
    }
  };
  render(buildTree(filter), 1);

  // Type Libraries — read-only declaration files (.d.ts) for the LB script API
  // types (@wunk) + lb-inject, shown as a real nested folder tree like VS Code's
  // node_modules. Collapsed by default; Go to Definition expands to the file.
  if (libFiles.size) {
    const rootOpen = expandedLibs.has(LIBROOT);
    wrap.appendChild(tvRow({ depth: 0, twisty: rootOpen ? "open" : "closed", iconHtml: "", label: "Type Libraries", isRoot: true, onClick: () => { if (rootOpen) expandedLibs.delete(LIBROOT); else expandedLibs.add(LIBROOT); renderFiles(); } }));
    if (rootOpen) {
      const renderLib = (node, depth) => {
        for (const [name, dir] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          const key = "lib::" + dir.path; const isOpen = expandedLibs.has(key);
          wrap.appendChild(tvRow({ depth, twisty: isOpen ? "open" : "closed", iconHtml: SVG.folder, label: name, onClick: () => { if (isOpen) expandedLibs.delete(key); else expandedLibs.add(key); renderFiles(); } }));
          if (isOpen) renderLib(dir, depth + 1);
        }
        for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name)))
          wrap.appendChild(tvRow({ depth, twisty: "", iconHtml: fileIcon(f.name), label: f.name, dim: true, isActive: !!libView && libView.uri === f.uri, onClick: () => openLib(f.uri), onDblClick: () => openLib(f.uri, { pin: true }) }));
      };
      renderLib(buildLibTree(), 1);
    }
  }
}

// ---------------------------------------------------------------- projects
async function loadProject(id) {
  const p = await dbGet(P_STORE, id);
  if (!p) return false;
  proj = p; disposeModels();
  for (const path of Object.keys(proj.files)) if (!isAux(path)) ensureModel(path);
  meta.current = id; location.hash = id;
  openFile(proj.active && proj.files[proj.active] ? proj.active : Object.keys(proj.files)[0]);
  renderTabs();
  return true;
}
// Merge bundled (tier1) + user/fetched (tier2/3) templates for the New menu, keyed by
// id — a user/fetched template SHADOWS a bundled one with the same id. Each entry
// carries `_origin` ("bundled" | "user" | "fetched") + `_sourceId` for the badge.
function mergedCategories() {
  const out = CATEGORIES.map((c) => ({ ...c, _origin: "bundled" }));
  const byId = new Map(out.map((c, i) => [c.id, i]));
  // precedence: bundled < fetched < user (a user's own template wins over a fetched one)
  for (const t of [...fetchedTemplates, ...userTemplates]) {
    if (!t || !t.id || !t.base || !t.base.files) continue;        // skip malformed docs
    // aux is an OBJECT (path→content), like bundled templates.json — createProject
    // spreads it into files. (A project's proj.aux is an array of paths; a template's
    // aux is the content map — don't conflate them.)
    const entry = { ...t, examples: t.examples || [], aux: (t.aux && typeof t.aux === "object" && !Array.isArray(t.aux)) ? t.aux : {}, _origin: t.origin || "user", _sourceId: t.sourceId };
    if (byId.has(t.id)) out[byId.get(t.id)] = entry;              // shadow bundled
    else { byId.set(t.id, out.length); out.push(entry); }
  }
  return out;
}
function categoryById(cid) { const m = mergedCategories(); return m.find((c) => c.id === cid) || m[0]; }
// Pull the user's own templates from the bridge into the New menu (no-op when offline).
async function refreshTemplates() {
  if (!bridge || !bridgeOn) { userTemplates = []; return; }
  try { userTemplates = ((await bridge.templates()) || []).filter((t) => (t.origin || "user") !== "fetched"); } catch { userTemplates = []; }
}

// Fetch the default template source (a published templates.json), STRIP untrusted
// files, merge in-memory (origin=fetched). Bare fetch — no token, credentials omitted
// (the source URL is not the host; never leak the session token to it). Non-blocking:
// a failure leaves the bundled set intact. Re-runnable (manual refresh in the manager).
async function fetchTemplateSource() {
  if (!TEMPLATE_SOURCE || !TEMPLATE_SOURCE.url) return { ok: false };
  try {
    const res = await fetch(TEMPLATE_SOURCE.url, { credentials: "omit" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const doc = await res.json();
    const { parseTemplateSource } = await import("./lb-ide-core/templates.js");
    fetchedTemplates = parseTemplateSource(doc, { sourceId: TEMPLATE_SOURCE.id });
    return { ok: true, count: fetchedTemplates.length };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
async function createProject(catId, exampleId, opts = {}) {
  const cat = categoryById(catId);
  const ex = exampleId ? cat.examples.find((e) => e.id === exampleId) : null;
  const srcFiles = ex ? ex.files : cat.base.files;
  const n = meta.ids.filter((id) => id.startsWith("p-")).length + 1;
  const entry = "main.ts" in srcFiles ? "main.ts" : "main.js" in srcFiles ? "main.js" : Object.keys(srcFiles)[0];
  const files = { ...JSON.parse(JSON.stringify(srcFiles)), ...JSON.parse(JSON.stringify(cat.aux || {})) };
  const name = opts.name || (ex ? cat.name + " — " + ex.name : cat.name + " " + n);
  proj = { id: uid(), name, templateId: cat.id, files, aux: Object.keys(cat.aux || {}), folders: [], openTabs: [entry], active: entry, updatedAt: Date.now() };
  meta.ids.push(proj.id); meta.current = proj.id;
  await saveProject(); await saveMeta();
  disposeModels();
  for (const path of Object.keys(proj.files)) if (!isAux(path)) ensureModel(path);
  location.hash = proj.id;
  openFile(proj.active); renderTabs();
  return proj.id;
}
async function closeProject(id) {
  await dbDel(P_STORE, id);
  builds.delete(id);
  meta.ids = meta.ids.filter((x) => x !== id);
  if (!meta.ids.length) { await saveMeta(); return createProject("default-ts"); }
  await saveMeta();
  if (meta.current === id) await loadProject(meta.ids[meta.ids.length - 1]); else renderTabs();
}
function renderTabs() {
  const wrap = $("tabs"); wrap.innerHTML = "";
  for (const id of meta.ids) {
    const tab = document.createElement("div"); tab.className = "ptab" + (id === meta.current ? " active" : "");
    tab.dataset.id = id;
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
  const open = document.createElement("button"); open.id = "openProj"; open.textContent = "open ▾"; open.title = "open a project or installed script"; open.onclick = showOpenMenu;
  wrap.appendChild(open);
  syncDownloadBtn(); // the build/download is per-project — reflect the current one
  // tab names for non-current projects are their ids until loaded; fetch names
  hydrateTabNames();
}
async function hydrateTabNames() {
  for (const id of meta.ids.slice()) {
    if (id === meta.current) continue;
    const p = await dbGet(P_STORE, id);
    // re-query by data-id after the await — the tab bar may have re-rendered,
    // so positional indexing would write names to the wrong tab.
    const tab = $("tabs").querySelector('.ptab[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (p && tab && tab.firstChild) tab.firstChild.textContent = p.name;
  }
}
function hideTemplateMenu() { $("tmplMenu").style.display = "none"; $("tmplSub").style.display = "none"; }
// Cascading picker: categories on the left, their items fly out to the side.
function showTemplateMenu() {
  const menu = $("tmplMenu"), sub = $("tmplSub"); menu.innerHTML = ""; sub.style.display = "none";
  const openSub = (cat, rowEl) => {
    [...menu.querySelectorAll(".row")].forEach((r) => r.classList.remove("active"));
    rowEl.classList.add("active");
    sub.innerHTML = "";
    const add = (title, desc, onClick) => {
      const it = document.createElement("div"); it.className = "item";
      // textContent (not innerHTML): user/fetched template names/descriptions are
      // untrusted strings — must not be injected as HTML.
      const wrap = document.createElement("div");
      const b = document.createElement("b"); b.textContent = title; wrap.appendChild(b);
      if (desc) { const s = document.createElement("span"); s.textContent = desc; wrap.appendChild(s); }
      it.appendChild(wrap);
      it.onclick = () => { hideTemplateMenu(); onClick(); };
      sub.appendChild(it);
    };
    add("Blank project", cat.description, () => createProject(cat.id));
    for (const ex of cat.examples) add(ex.name, "", () => createProject(cat.id, ex.id));
    const mr = menu.getBoundingClientRect(), rr = rowEl.getBoundingClientRect();
    sub.style.display = "block";
    const w = sub.offsetWidth || 230;
    let left = mr.right + 2; if (left + w > window.innerWidth - 6) left = mr.left - w - 2;
    sub.style.left = Math.max(6, left) + "px";
    sub.style.top = Math.min(rr.top, window.innerHeight - sub.offsetHeight - 6) + "px";
  };
  for (const cat of mergedCategories()) {
    const row = document.createElement("div"); row.className = "row";
    const label = document.createElement("span"); label.textContent = cat.name;
    row.appendChild(label);
    // provenance badge for non-bundled templates (user / fetched source)
    if (cat._origin && cat._origin !== "bundled") {
      const badge = document.createElement("span"); badge.className = "badge";
      badge.textContent = cat._origin === "fetched" ? (cat._sourceId || "fetched") : "custom";
      badge.title = cat._origin === "fetched" ? ("from source: " + (cat._sourceId || "?") + " — review before running") : "your saved template";
      row.appendChild(badge);
    }
    const arrow = document.createElement("span"); arrow.className = "arrow"; arrow.textContent = "▸"; row.appendChild(arrow);
    row.onmouseenter = () => openSub(cat, row);
    row.onclick = () => openSub(cat, row);
    menu.appendChild(row);
  }
  // Footer actions: save-as-template (create-own, needs a bridge) + manage templates
  // (list/delete/duplicate + manual fetch; works offline for fetched templates).
  const footer = (text, onClick) => {
    const sep = document.createElement("div"); sep.className = "sep"; menu.appendChild(sep);
    const row = document.createElement("div"); row.className = "row";
    const label = document.createElement("span"); label.textContent = text; row.appendChild(label);
    row.onmouseenter = () => { sub.style.display = "none"; [...menu.querySelectorAll(".row")].forEach((r) => r.classList.remove("active")); };
    row.onclick = () => { hideTemplateMenu(); onClick(); };
    menu.appendChild(row);
  };
  if (bridgeOn) footer("Save current as template…", saveCurrentAsTemplate);
  footer("Manage templates…", openTemplateManager);
  const r = $("newProj").getBoundingClientRect();
  menu.style.left = Math.max(6, r.left) + "px"; menu.style.top = r.bottom + 4 + "px"; menu.style.display = "block";
}

// Save-as-template (create-own): build a template doc from the current project's
// files and persist it to the bridge (lb-ide/templates/). Clone-and-modify is the
// inverse + already covered: creating a project from any template in the New menu
// clones its files into an editable project.
async function saveCurrentAsTemplate() {
  if (!proj) return;
  if (!bridge || !bridgeOn) { log("save as template needs a connected client", "e"); return; }
  const name = (prompt("Template name:", proj.name) || "").trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || ("tpl-" + Date.now().toString(36));
  const lang = Object.keys(proj.files).some((f) => f.endsWith(".ts")) ? "ts" : "js";
  // Split into source files (base.files) and aux files (aux as a path→content OBJECT,
  // matching the bundled template shape so createProject reconstructs the project).
  const auxPaths = new Set(proj.aux || []);
  const baseFiles = {}, auxObj = {};
  for (const [p, c] of Object.entries(proj.files)) (auxPaths.has(p) ? auxObj : baseFiles)[p] = c;
  const doc = { id, name, description: "saved from project", lang, base: { files: baseFiles }, examples: [], aux: auxObj, origin: "user", createdAt: Date.now(), updatedAt: Date.now() };
  try {
    const res = await bridge.saveTemplate(doc);
    if (res && res.ok) { await refreshTemplates(); log("✓ saved template '" + name + "' (id " + (res.id || id) + ")", "s"); }
    else log("✗ save template failed", "e");
  } catch (e) { log("✗ save template failed: " + (e && e.message || e), "e"); }
}

// Template/source manager: a popup listing the default source (with a manual
// "fetch latest"), the user's own templates (duplicate & edit / delete), and the
// fetched templates (duplicate & edit). Anchored to the New button.
async function openTemplateManager() {
  await refreshTemplates(); // reflect any out-of-band bridge changes (don't render a stale snapshot)
  showPop($("newProj"), (el) => {
    const head = (txt) => { const d = document.createElement("div"); d.className = "item"; d.style.cssText = "cursor:default;font-size:11px;color:var(--fgdim);text-transform:uppercase;letter-spacing:.04em"; d.textContent = txt; el.appendChild(d); };
    const sep = () => { const s = document.createElement("div"); s.className = "sep"; el.appendChild(s); };
    // default source + manual refresh
    head("Source");
    el.appendChild(popItem("Fetch latest from " + TEMPLATE_SOURCE.name, async () => {
      const r = await fetchTemplateSource();
      log(r.ok ? ("fetched " + r.count + " template(s) from " + TEMPLATE_SOURCE.name) : ("template fetch failed: " + (r.error || "?")), r.ok ? "s" : "e");
    }, TEMPLATE_SOURCE.id));
    // your templates (duplicate + delete)
    sep(); head("Your templates");
    if (!userTemplates.length) { const d = document.createElement("div"); d.className = "item"; d.style.cssText = "cursor:default;color:var(--fgdim)"; d.textContent = bridgeOn ? "(none — use “Save current as template”)" : "(connect a client to save templates)"; el.appendChild(d); }
    for (const t of userTemplates) {
      const row = popItem(t.name, () => createProject(t.id), "duplicate & edit");
      const del = document.createElement("span"); del.textContent = "✕"; del.title = "delete template"; del.style.cssText = "margin-left:auto;padding-left:10px;color:var(--fgdim)";
      del.onclick = (e) => { e.stopPropagation(); deleteUserTemplate(t.id, t.name); };
      row.appendChild(del);
      el.appendChild(row);
    }
    // fetched templates (duplicate only — managed by re-fetch)
    if (fetchedTemplates.length) {
      sep(); head("From " + TEMPLATE_SOURCE.name);
      for (const t of fetchedTemplates) el.appendChild(popItem(t.name, () => createProject(t.id), "duplicate & edit"));
    }
  });
}
async function deleteUserTemplate(id, name) {
  if (!bridge || !bridgeOn) return;
  if (!confirm("Delete template “" + (name || id) + "”?")) return;
  try { await bridge.deleteTemplate(id); await refreshTemplates(); log("deleted template " + id, "d"); openTemplateManager(); }
  catch (e) { log("delete template failed: " + (e && e.message || e), "e"); }
}

// "Open" menu: a cascading picker (mirrors showTemplateMenu) with two categories —
// Projects (your editable IDE projects, the local/bridge-synced sources) and
// Installed scripts (the LiquidBounce scripts/ folder, via the bridge). Anchored to
// the "open" button; lives in the SAME tmplMenu/tmplSub DOM.
let openMenuGen = 0; // submenu generation: a later hover invalidates an in-flight async fill
function showOpenMenu() {
  const menu = $("tmplMenu"), sub = $("tmplSub"); menu.innerHTML = ""; sub.style.display = "none";
  const positionSub = (rowEl) => {
    const mr = menu.getBoundingClientRect(), rr = rowEl.getBoundingClientRect();
    sub.style.display = "block";
    const w = sub.offsetWidth || 230;
    let left = mr.right + 2; if (left + w > window.innerWidth - 6) left = mr.left - w - 2;
    sub.style.left = Math.max(6, left) + "px";
    sub.style.top = Math.min(rr.top, window.innerHeight - sub.offsetHeight - 6) + "px";
  };
  const activate = (rowEl) => { [...menu.querySelectorAll(".row")].forEach((r) => r.classList.remove("active")); rowEl.classList.add("active"); };
  const subItem = (title, desc, onClick) => {
    const it = document.createElement("div"); it.className = "item";
    const b = document.createElement("b"); b.textContent = title;            // textContent: no HTML injection from names
    it.appendChild(b);
    if (desc) { const s = document.createElement("span"); s.textContent = desc; it.appendChild(s); }
    it.onclick = () => { hideTemplateMenu(); onClick(); };
    return it;
  };
  // Projects category: switch to any open project other than the current one.
  const openProjects = async (rowEl) => {
    const gen = ++openMenuGen;
    activate(rowEl); sub.innerHTML = ""; sub.appendChild(subItem("loading…", "", () => {}));
    positionSub(rowEl);
    const others = meta.ids.filter((id) => id !== meta.current);
    const names = await Promise.all(others.map((id) => dbGet(P_STORE, id).then((p) => (p && p.name) || id).catch(() => id)));
    if (gen !== openMenuGen) return; // a newer hover took over
    sub.innerHTML = "";
    if (!others.length) sub.appendChild(subItem("(no other projects)", "", () => {}));
    else others.forEach((id, i) => sub.appendChild(subItem(names[i], "switch project", () => loadProject(id))));
    positionSub(rowEl);
  };
  // Installed scripts category: list the scripts/ folder via the bridge, open one
  // as an editable single-file project (unchanged behavior).
  const openInstalled = async (rowEl) => {
    const gen = ++openMenuGen;
    activate(rowEl); sub.innerHTML = ""; sub.appendChild(subItem("loading…", "", () => {}));
    positionSub(rowEl);
    let names = [];
    try { names = (bridge ? await bridge.scripts() : await apiFetch("api/scripts").then((r) => r.json())) || []; } catch { /* */ }
    if (gen !== openMenuGen) return; // a newer hover took over
    sub.innerHTML = "";
    if (!names.length) sub.appendChild(subItem("(no installed scripts)", "", () => {}));
    else for (const name of names) {
      sub.appendChild(subItem(name, "open from LiquidBounce scripts/", () => openInstalledScript(name)));
    }
    positionSub(rowEl);
  };
  const addRow = (label, onOpen) => {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = "<span>" + label + "</span><span class='arrow'>▸</span>";
    row.onmouseenter = () => onOpen(row);
    row.onclick = () => onOpen(row);
    menu.appendChild(row);
  };
  addRow("Projects", openProjects);
  if (bridgeOn) addRow("Installed scripts", openInstalled);
  const r = $("openProj").getBoundingClientRect();
  menu.style.left = Math.max(6, r.left) + "px"; menu.style.top = r.bottom + 4 + "px"; menu.style.display = "block";
}

// Bridge: read one installed script, open it as an editable single-file project.
async function openInstalledScript(name) {
  try {
    const res = bridge ? await bridge.script(name) : await apiFetch("api/script?name=" + encodeURIComponent(name)).then((r) => r.json());
    if (!res || !res.ok) { log("could not read " + name, "e"); return; }
    await openInstalledScriptProject(name, res.content);
  } catch (e) { log("open failed: " + (e && e.message || e), "e"); }
}

// Create a single-file project from raw content (used for installed scripts).
async function openInstalledScriptProject(filename, content) {
  const lang = filename.endsWith(".js") || filename.endsWith(".mjs") ? "js" : "ts";
  const entry = lang === "js" ? "main.js" : "main.ts";
  proj = { id: uid(), name: filename, templateId: "installed", files: { [entry]: content }, aux: [], folders: [], openTabs: [entry], active: entry, updatedAt: Date.now() };
  meta.ids.push(proj.id); meta.current = proj.id;
  await saveProject(); await saveMeta();
  disposeModels(); ensureModel(entry);
  location.hash = proj.id; openFile(entry); renderTabs();
}
document.addEventListener("click", (e) => { const m = $("tmplMenu"), s = $("tmplSub"); if (m.style.display === "block" && !m.contains(e.target) && !s.contains(e.target) && e.target.id !== "newProj" && e.target.id !== "openProj") hideTemplateMenu(); });

// ---------------------------------------------------------------- share links
// Encode the current project into the URL hash (#share=<gzip+base64url>) so a
// link reconstructs it — no backend. Supporting (aux) files are omitted (they're
// template scaffolding, not needed to edit/build), keeping links small.
const b64uEnc = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const b64uDec = (str) => { const s = atob(str.replace(/-/g, "+").replace(/_/g, "/")); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
async function gz(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()); }
async function gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()); }

async function encodeShare(p) {
  // include ALL files (source + supporting/aux) so the link is a faithful copy;
  // carry the aux list so the "show supporting files" toggle still works.
  const files = { ...p.files };
  const payload = { v: 1, name: p.name, templateId: p.templateId, files, aux: (p.aux || []).filter((a) => a in files), folders: p.folders || [], openTabs: (p.openTabs || []).filter((t) => t in files), active: files[p.active] ? p.active : Object.keys(files)[0] };
  const data = new TextEncoder().encode(JSON.stringify(payload));
  return "share=" + b64uEnc(await gz(data));
}
const SHARE_MAX_B64 = 3 * 1024 * 1024;   // ~3MB link cap
const SHARE_MAX_BYTES = 12 * 1024 * 1024; // decompressed cap (gzip-bomb guard)
async function decodeShare(hash) {
  const raw = hash.slice("share=".length);
  if (raw.length > SHARE_MAX_B64) throw new Error("share link too large");
  const bytes = await gunzip(b64uDec(raw));
  if (bytes.length > SHARE_MAX_BYTES) throw new Error("share payload too large");
  return JSON.parse(new TextDecoder().decode(bytes));
}
// Validate an untrusted share payload before importing it (prevents crashes /
// corruption / DoS from malformed or hostile #share= links).
function validShare(p) {
  if (!p || p.v !== 1 || typeof p.files !== "object" || p.files === null || Array.isArray(p.files)) return false;
  const keys = Object.keys(p.files);
  if (keys.length === 0 || keys.length > 2000) return false;
  let total = 0;
  for (const k of keys) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return false;
    if (typeof p.files[k] !== "string") return false;
    total += p.files[k].length;
    if (total > SHARE_MAX_BYTES) return false;
  }
  return true;
}
async function shareProject() {
  try {
    const frag = await encodeShare(proj);
    const url = location.origin + location.pathname + "#" + frag;
    try { await navigator.clipboard.writeText(url); log("share link copied to clipboard (" + url.length + " chars)", "s"); }
    catch { log("share link (copy it): " + url, "d"); }
    return url;
  } catch (e) { log("share failed: " + (e && e.message || e), "e"); }
}
async function importShared(payload) {
  const files = payload.files || {};
  proj = { id: uid(), name: payload.name || "Shared", templateId: payload.templateId || "shared", files, aux: (payload.aux || []).filter((a) => a in files), folders: payload.folders || [], openTabs: (payload.openTabs && payload.openTabs.length ? payload.openTabs : [Object.keys(files)[0]]).filter(Boolean), active: payload.active || Object.keys(files)[0], updatedAt: Date.now() };
  meta.ids.push(proj.id); meta.current = proj.id;
  await saveProject(); await saveMeta();
  disposeModels(); for (const path of Object.keys(proj.files)) if (!isAux(path)) ensureModel(path);
  location.hash = proj.id; openFile(proj.active); renderTabs();
  log("imported shared project: " + proj.name, "s");
}

function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveProject(); saveMeta(); }, 300); }
async function saveProject() { if (!proj) return; proj.updatedAt = Date.now(); await dbPut(P_STORE, proj.id, proj); if (bridgeOn) bridgeSave(proj); }
// Mirror saves to the in-client host so projects persist on disk (CEF IndexedDB
// may be ephemeral). Debounced + coalesced with an in-flight guard so rapid
// edits don't fire overlapping/out-of-order POSTs. Local copy is source of truth.
let bridgeSaveTimer = null, bridgeSaving = false, bridgePending = null;
function bridgeSave(p) { bridgePending = p; clearTimeout(bridgeSaveTimer); bridgeSaveTimer = setTimeout(flushBridgeSave, 700); }
async function flushBridgeSave() {
  if (bridgeSaving || !bridgePending) return;
  bridgeSaving = true; const p = bridgePending; bridgePending = null;
  try { await apiFetch("api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }); } catch { /* */ }
  bridgeSaving = false;
  if (bridgePending) flushBridgeSave(); // a save arrived while in flight → coalesce
}
async function saveMeta() { await dbPut(M_STORE, "open", meta); }

// ---------------------------------------------------------------- build
let esbuildReady = null;
function initEsbuild() { if (!esbuildReady) esbuildReady = esbuild.initialize({ wasmURL: "esbuild.wasm" }); return esbuildReady; }
async function ensureInjectBundle() { if (injectBundle == null) injectBundle = await fetch("lb-inject-bundled.js").then((r) => r.text()); return injectBundle; }

// The build pipeline (esbuild-wasm orchestration + the Java.type-rewrite plugin)
// lives in the shared @lb-ide/core package — single-sourced with the heavy editor.
// The lean app is buildless, so we load the ESM lazily via dynamic import()
// (symlinked into public/lb-ide-core by scripts/link-public.mjs).
let _coreBuild = null;
async function coreBuild() {
  if (!_coreBuild) _coreBuild = await import("./lb-ide-core/build.js");
  return _coreBuild;
}
const entryPoint = () => ("main.ts" in proj.files ? "main.ts" : "main.js" in proj.files ? "main.js" : Object.keys(proj.files)[0]);

// ---- per-project build config (an editable lbbuild.config.json, like a normal
// TS project's tsconfig). Absent → these defaults; present → merged over them. --
const BUILD_FILE = "lbbuild.config.json";
// Authoritative for the lean config UI (writeBuildConfig/setBuildField). Mirrors
// @lb-ide/core build.js DEFAULT_BUILD — runBuild re-merges core's as a fallback,
// so keep the two in sync (kept here too because the buildless lean app can't
// sync-import the ESM in these synchronous config helpers). check-default-build.mjs
// asserts they match by regex — keep the closing `};` on its own line for that check.
const DEFAULT_BUILD = {
  entry: "",                 // "" → auto-detect (main.ts / main.js)
  format: "esm",             // esm | iife | cjs
  target: "es2022",          // es2017 … es2022 | esnext
  minify: false,
  sourcemap: false,          // false | true (=inline) | "inline" | "external"
  keepNames: false,
  treeShaking: true,
  charset: "utf8",           // utf8 | ascii
  define: {},                // { "FLAG": "true" }  (values are raw JS)
  drop: [],                  // ["console","debugger"]
  pure: [],                  // functions safe to drop if unused
  banner: "",                // prepended to the output
  footer: "",                // appended to the output
  javaTypeRewrite: true,     // @wunk/.../types/* value import → Java.type("…")
  inlineLbInject: true,      // inline the lb-inject runtime (else leave external)
};
// returns { config, error } — config is the parsed file (or proj.build, or {})
function rawBuildConfig() {
  if (proj && BUILD_FILE in proj.files) { try { return { config: JSON.parse(proj.files[BUILD_FILE]) }; } catch (e) { return { config: null, error: BUILD_FILE + ": " + e.message }; } }
  return { config: (proj && proj.build) || {} };
}
const buildConfig = () => ({ ...DEFAULT_BUILD, ...(rawBuildConfig().config || {}) });
function writeBuildConfig(cfg) { const json = JSON.stringify(cfg, null, 2) + "\n"; proj.files[BUILD_FILE] = json; if (!proj.aux) proj.aux = []; if (!proj.aux.includes(BUILD_FILE)) proj.aux.push(BUILD_FILE); const m = models.get(BUILD_FILE); if (m) m.setValue(json); scheduleSave(); }
function ensureBuildConfigFile() { if (!(BUILD_FILE in proj.files)) writeBuildConfig({ ...DEFAULT_BUILD, ...(proj.build || {}) }); }
function setBuildField(key, value) { const cur = { ...DEFAULT_BUILD, ...(rawBuildConfig().config || {}) }; cur[key] = value; writeBuildConfig(cur); }

// JVM type-info level — per-project, persisted in lbbuild.config.json as `jvmTypes`.
// It's an editor-only typings switch (not an esbuild option), so it lives in the
// config FILE but is intentionally NOT a DEFAULT_BUILD key. It controls whether a
// bare `Java.type("...")` string literal is typed in the editor:
//   off → ambient only (Java.type(...) is `any`; use explicit imports for typed handles)
//   lb  → + the registry-lb closure (string-literal typing of net.ccbluex.* classes)
// The registry is a ~0.6 MB gz extra closure, so it's a SEPARATE artifact
// (typings-registry-lb.json) fetched only when the toggle is first enabled, and
// added to / removed from Monaco's extra libs (a loaded .d.ts's `declare global`
// always applies, so gating has to be by presence, not the `types` option).
// registry-full (net.minecraft.*) is too large to ship — deferred to the lazy path.
const JVM_LEVELS = ["off", "lb"];
function jvmTypesLevel() { const v = (rawBuildConfig().config || {}).jvmTypes; return JVM_LEVELS.includes(v) ? v : "off"; }
let _registryLibs = null; // cached registry-lb extra libs (loaded on first enable)
function jvmExtraLibs() { return (jvmTypesLevel() === "lb" && _registryLibs) ? baseExtraLibs.concat(_registryLibs) : baseExtraLibs; }
async function loadRegistryLibs() {
  if (_registryLibs) return _registryLibs;
  const { getClosure, toExtraLibs } = await import("./lb-ide-core/typings.js");
  _registryLibs = toExtraLibs(await getClosure("typings-registry-lb.json"));
  return _registryLibs;
}
async function applyJvmTypes() {
  if (!window.monaco) return;
  if (jvmTypesLevel() === "lb") { try { await loadRegistryLibs(); } catch { log("could not load LiquidBounce type registry", "e"); } }
  const libs = jvmExtraLibs();
  monaco.languages.typescript.typescriptDefaults.setExtraLibs(libs);
  monaco.languages.typescript.javascriptDefaults.setExtraLibs(libs);
}
function setJvmTypes(level) { setBuildField("jvmTypes", level); applyJvmTypes(); }
let _jvmAppliedFor = null; // re-apply Monaco extra libs only when the active project changes

// "Error on any" linter — per-project (lbbuild.config.json `antiAny`). TypeScript has
// no compiler flag for this, so it runs via a custom worker method (ts-anyworker.js,
// wired by setWorkerOptions at init) that walks the TypeChecker for `any`-typed
// expressions; we surface them as error markers on the active model.
const ANY_MARKER_OWNER = "anti-any";
function antiAnyOn() { return !!(rawBuildConfig().config || {}).antiAny; }
function setAntiAny(on) { setBuildField("antiAny", !!on); lintAnyActive(); }
let _antiAnyTimer = null;
function scheduleLintAny() { clearTimeout(_antiAnyTimer); _antiAnyTimer = setTimeout(lintAnyActive, 400); }
async function lintAnyActive() {
  if (!window.monaco || !editor) return;
  const model = editor.getModel();
  if (!model) return;
  const clear = () => monaco.editor.setModelMarkers(model, ANY_MARKER_OWNER, []);
  const lang = model.getLanguageId();
  if (!antiAnyOn() || libView || (lang !== "typescript" && lang !== "javascript")) { clear(); return; }
  try {
    const getWorker = lang === "javascript" ? monaco.languages.typescript.getJavaScriptWorker : monaco.languages.typescript.getTypeScriptWorker;
    const w = await (await getWorker())(model.uri);
    if (typeof w.getAnyRanges !== "function") return;       // custom worker not active
    const ranges = await w.getAnyRanges(model.uri.toString());
    if (editor.getModel() !== model) return;                // switched files mid-await
    monaco.editor.setModelMarkers(model, ANY_MARKER_OWNER, ranges.map((r) => {
      const s = model.getPositionAt(r.start), e = model.getPositionAt(r.start + r.length);
      return { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column, message: r.message, severity: monaco.MarkerSeverity.Error, source: "any" };
    }));
  } catch { /* worker not ready / transient — next change re-lints */ }
}

async function build() {
  $("build").disabled = true; setStatus("building…");
  try {
    const { config, error } = rawBuildConfig();
    if (error) { log("✗ " + error, "e"); setStatus("build failed"); return; }
    const cfg = { ...DEFAULT_BUILD, ...(config || {}) };
    await initEsbuild();
    const { runBuild } = await coreBuild();
    if (cfg.inlineLbInject !== false && Object.values(proj.files).some((c) => /from\s+["']lb-inject["']/.test(c))) await ensureInjectBundle();
    const entry = cfg.entry && cfg.entry in proj.files ? cfg.entry : entryPoint();
    const built = await runBuild({ esbuild, files: proj.files, cfg, entry, injectBundle, debug: debugOn });
    builds.set(proj.id, { name: built.name, code: built.code });
    syncDownloadBtn();
    log("✓ built " + built.name + " — " + built.code.length + " bytes" + (cfg.minify ? " (minified)" : "") + (debugOn ? " (inline source map)" : ""), "s");
    for (const w of built.warnings) log("warn: " + w.text, "d");
    setStatus("build ok");
  } catch (e) {
    const errs = (e && e.errors) || [];
    if (errs.length) for (const er of errs) log("✗ " + (er.location ? er.location.file + ": " : "") + er.text, "e");
    else log("✗ build failed: " + (e && e.message || e), "e");
    setStatus("build failed");
  } finally { $("build").disabled = false; }
}
function saveBlob(content, filename, type) { const blob = new Blob([content], { type: type || "application/octet-stream" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 0); }
function download() { const b = currentBuild(); if (!b) return; saveBlob(b.code, b.name, "text/javascript"); }

// ---- downloads: current file + whole project as a (stored) .zip ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
// Minimal ZIP writer (store/no-compression) — enough to bundle a project's text files.
function makeZip(entries) {
  const enc = new TextEncoder(); const chunks = []; const central = []; let offset = 0;
  const u16 = (n) => [n & 255, (n >>> 8) & 255]; const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const e of entries) {
    const name = enc.encode(e.name); const data = e.data; const crc = crc32(data);
    const local = [0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    chunks.push(new Uint8Array(local), name, data);
    central.push([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), name]);
    offset += local.length + name.length + data.length;
  }
  let cdSize = 0; const cdChunks = [];
  for (const c of central) { const arr = []; for (const x of c) { if (x instanceof Uint8Array) arr.push(...x); else arr.push(x); } const u = new Uint8Array(arr); cdChunks.push(u); cdSize += u.length; }
  const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...chunks, ...cdChunks, end]; let total = 0; for (const c of all) total += c.length;
  const out = new Uint8Array(total); let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}
function activeFileName() { const m = editor && editor.getModel(); if (!m) return ""; const uri = m.uri.toString(); const prefix = proj ? "file:///" + proj.id + "/" : ""; return (prefix && uri.startsWith(prefix)) ? decodeURIComponent(uri.slice(prefix.length)) : decodeURIComponent(uri).split("/").pop(); }
function downloadCurrentFile() { const m = editor && editor.getModel(); if (!m) return; const name = (activeFileName() || "file.txt").split("/").pop(); saveBlob(m.getValue(), name, "text/plain"); }
function downloadProjectZip() { if (!proj) return; const enc = new TextEncoder(); const entries = Object.keys(proj.files).sort().map((name) => ({ name, data: enc.encode(proj.files[name]) })); saveBlob(makeZip(entries), (proj.name || "project").replace(/[^a-z0-9._-]+/gi, "_") + ".zip", "application/zip"); }

// ---- format the current file via the TS worker ---------------------------
async function formatActive() {
  const model = editor && editor.getModel(); if (!model) return;
  if (editor.getOption(monaco.editor.EditorOption.readOnly)) { setStatus("read-only — not formatted"); return; }
  try {
    const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
    const client = await getWorker(model.uri);
    const opts = { tabSize: 2, indentSize: 2, convertTabsToSpaces: true, insertSpaceAfterCommaDelimiter: true, insertSpaceAfterSemicolonInForStatements: true, insertSpaceBeforeAndAfterBinaryOperators: true, insertSpaceAfterKeywordsInControlFlowStatements: true, insertSpaceAfterFunctionKeywordForAnonymousFunctions: true, insertSpaceBeforeFunctionParenthesis: false, insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false, placeOpenBraceOnNewLineForFunctions: false, placeOpenBraceOnNewLineForControlBlocks: false, semicolons: "insert" };
    const edits = await client.getFormattingEditsForDocument(model.uri.toString(), opts);
    if (!edits || !edits.length) { setStatus("already formatted"); return; }
    editor.executeEdits("format", edits.map((e) => ({ range: monaco.Range.fromPositions(model.getPositionAt(e.span.start), model.getPositionAt(e.span.start + e.span.length)), text: e.newText })));
    editor.pushUndoStop(); setStatus("formatted");
  } catch (e) { log("format failed: " + (e && e.message || e), "e"); }
}

// ---- file import (button + drag-and-drop) --------------------------------
function importOneFile(path, content) {
  path = path.replace(/^\/+/, "").replace(/\\/g, "/");
  if (path in proj.files) { const dot = path.lastIndexOf("."); const b = dot >= 0 ? path.slice(0, dot) : path; const x = dot >= 0 ? path.slice(dot) : ""; let i = 1; while ((b + "-" + i + x) in proj.files) i++; path = b + "-" + i + x; }
  proj.files[path] = content; return path;
}
async function importFiles(fileList) {
  const arr = [...(fileList || [])]; if (!arr.length || !proj) return;
  let last = null;
  for (const f of arr) { try { const text = await f.text(); last = importOneFile((f.webkitRelativePath && f.webkitRelativePath.length ? f.webkitRelativePath : f.name), text); } catch { /* */ } }
  if (last) { openFile(last); log("imported " + arr.length + " file(s)", "s"); }
}

// ---- a tiny popover menu (export / build options) ------------------------
function hidePop() { const p = $("pop"); p.style.display = "none"; p.innerHTML = ""; document.removeEventListener("mousedown", popDismiss, true); }
function popDismiss(e) { const p = $("pop"); if (!p.contains(e.target)) hidePop(); }
function showPop(anchor, build) {
  document.removeEventListener("mousedown", popDismiss, true); // drop any prior listener (reopen without hidePop won't leak)
  const p = $("pop"); p.innerHTML = ""; build(p); p.style.display = "block";
  const r = anchor.getBoundingClientRect();
  p.style.left = Math.max(6, Math.min(r.left, window.innerWidth - p.offsetWidth - 8)) + "px";
  p.style.top = (r.bottom + 4) + "px";
  setTimeout(() => document.addEventListener("mousedown", popDismiss, true), 0);
}
function popItem(label, onClick, sub) { const d = document.createElement("div"); d.className = "item"; d.appendChild(document.createTextNode(label)); if (sub) { const s = document.createElement("span"); s.className = "sub"; s.textContent = sub; d.appendChild(s); } d.onclick = () => { hidePop(); onClick(); }; return d; }

// ---------------------------------------------------------------- themes
// Each theme drives the CSS design tokens + a Monaco color theme. The
// LiquidBounce theme uses LB's real palette (flat #4677ff accent, near-black
// surfaces, Inter, status reds/greens) — see docs.
const THEMES = {
  dark: {
    name: "Dark",
    editorBg: "#1e1e21",
    vars: { bg: "#1e1e1e", bg2: "#252526", bg3: "#2d2d2d", bg4: "#1b1b1b", fg: "#d4d4d4", fgdim: "#888", acc: "#0e639c", acc2: "#1177bb", err: "#f48771", ok: "#89d185", run: "#2d7d33", hover: "#2a2d2e", sel: "#094771", border: "#111", glassrgb: "30,30,33", font: 'ui-monospace, "SF Mono", Menlo, monospace' },
    monaco: { base: "vs-dark", colors: {} },
  },
  liquidbounce: {
    name: "LiquidBounce",
    editorBg: "#0a0c10",
    vars: { bg: "#050608", bg2: "#0c0e13", bg3: "#171a21", bg4: "#0a0c10", fg: "#ffffff", fgdim: "#8b93a7", acc: "#4677ff", acc2: "#5b86ff", err: "#fc4130", ok: "#4dac68", run: "#2f9e57", hover: "#ffffff14", sel: "#4677ff40", border: "#1b2030", glassrgb: "5,6,8", font: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
    monaco: { base: "vs-dark", colors: { "editor.background": "#0a0c10", "editor.lineHighlightBackground": "#4677ff12", "editor.selectionBackground": "#4677ff44", "editorCursor.foreground": "#4677ff", "editorLineNumber.foreground": "#39414f", "editorLineNumber.activeForeground": "#4677ff", "focusBorder": "#4677ff" } },
  },
};
let themeId = "dark";
let curGlassAlpha = 1; // <1 in-game (?opacity); blends the editor bg with the game
function applyTheme(id) {
  const t = THEMES[id] || THEMES.dark; themeId = THEMES[id] ? id : "dark";
  const r = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) r.style.setProperty("--" + k, v);
  const colors = { ...t.monaco.colors };
  if (curGlassAlpha < 1) colors["editor.background"] = (t.editorBg || "#1e1e21") + Math.round(curGlassAlpha * 255).toString(16).padStart(2, "0");
  monaco.editor.defineTheme("lb-active", { base: t.monaco.base, inherit: true, rules: [], colors });
  monaco.editor.setTheme("lb-active");
  try { localStorage.setItem("lb-ide:theme", themeId); } catch { /* */ }
}

// ---------------------------------------------------------------- init
require(["vs/editor/editor.main"], async () => {
  setStatus("loading templates + typings…");
  [CATEGORIES, INJECT_DTS] = await Promise.all([
    fetch("templates.json").then((r) => r.json()).then((d) => d.categories),
    fetch("lb-inject.d.ts").then((r) => r.text()),
  ]);
  // Pull the default source's published templates (editor-fetch, stripped) — non-blocking;
  // the New menu picks them up once they arrive. Works with or without a bridge.
  fetchTemplateSource().then((r) => { if (r.ok && r.count) log("fetched " + r.count + " template(s) from " + TEMPLATE_SOURCE.name, "d"); });
  // host-API bridge client (shared @lb-ide/core) — created once for /api/* calls.
  bridge = (await import("./lb-ide-core/bridge.js")).createBridge({ base: BASE, token: API_TOKEN });
  // typings closure + the lean (setExtraLibs) adapter live in @lb-ide/core; the
  // heavy editor uses the same closure via the build-time barrel (gen-barrel.mjs).
  const { getClosure, toExtraLibs } = await import("./lb-ide-core/typings.js");
  const closure = await getClosure("typings-bundle.json");
  baseExtraLibs = toExtraLibs(closure, [
    { content: INJECT_DTS, filePath: "file:///node_modules/@types/lb-inject/index.d.ts" },
    // `log(...)` is injected by the in-client host into REPL snippets — it streams
    // output live (incl. from async callbacks) to the REPL panel.
    { content: "/** REPL/in-client only: stream a value to the live REPL log panel. */\ndeclare function log(...args: any[]): void;", filePath: "file:///node_modules/@types/lb-repl/index.d.ts" },
  ]);
  configureTS(monaco.languages.typescript.typescriptDefaults, false);
  configureTS(monaco.languages.typescript.javascriptDefaults, true);
  // Custom TS worker adds getAnyRanges() for the "Error on any" linter (ts-anyworker.js).
  monaco.languages.typescript.typescriptDefaults.setWorkerOptions({ customWorkerPath: BASE + "ts-anyworker.js" });
  monaco.languages.typescript.javascriptDefaults.setWorkerOptions({ customWorkerPath: BASE + "ts-anyworker.js" });

  // In-game translucency: ?opacity=NN (20–100). <100 → see the game behind.
  try {
    const op = Math.max(20, Math.min(100, parseInt(new URLSearchParams(location.search).get("opacity") || "100", 10) || 100));
    if (op < 100) { curGlassAlpha = op / 100; document.documentElement.style.setProperty("--a", String(curGlassAlpha)); document.documentElement.classList.add("translucent"); }
  } catch { /* */ }
  // stored choice wins; else a ?theme= default (the host opens with LiquidBounce); else Dark
  themeId = (() => { try { return localStorage.getItem("lb-ide:theme") || new URLSearchParams(location.search).get("theme") || "dark"; } catch { return "dark"; } })();
  if (!THEMES[themeId]) themeId = "dark";

  applyTheme(themeId); // define + set "lb-active" BEFORE creating the editor (no vs-dark flash)
  editor = monaco.editor.create($("editor"), { theme: "lb-active", automaticLayout: true, fontSize: 13, minimap: { enabled: false } });

  // live TS status in the bottom bar: "checking…" while the language service
  // validates the active file, then the error/warning count (or "no problems").
  editor.onDidChangeModelContent(markChecking);
  editor.onDidChangeModel(() => {
    markChecking();
    // library/typings views are read-only; project files stay editable
    const m = editor.getModel();
    editor.updateOptions({ readOnly: !!m && !m.uri.toString().startsWith("file:///" + proj.id + "/") });
  });
  monaco.editor.onDidChangeMarkers((uris) => { const cur = editor && editor.getModel(); if (!cur) return; const u = cur.uri.toString(); if (uris.some((x) => x.toString() === u)) { clearTimeout(typeStatusTimer); refreshTypeStatus(); } });
  markChecking();

  // "Go to Definition" (F12 + Ctrl/Cmd+click). This standalone Monaco build ships
  // without the gotoDefinition contribution, and even with it the editor has no
  // workbench to open another file — so we implement it: ask the TS worker for the
  // definition, then navigate to a project file (editable) or open a library /
  // typings .d.ts (e.g. `lb-inject`, `@wunk/...`) as a read-only view.
  const libModels = new Map(); // uri string -> on-demand read-only model
  // Lookup keyed by the *normalized* (URI-encoded, e.g. @ → %40) form, since the
  // worker/Monaco hand us encoded URIs while the extraLib filePaths are literal.
  const libByUri = new Map();
  for (const l of baseExtraLibs) { try { libByUri.set(monaco.Uri.parse(l.filePath).toString(), l); } catch { /* */ } }
  // Switch the editor to `resource` (project file or library view). Returns the
  // now-active model on success, else null.
  function openTarget(resource, opts = {}) {
    const uri = resource.toString();
    const prefix = "file:///" + proj.id + "/";
    if (uri.startsWith(prefix)) {
      const path = decodeURIComponent(uri.slice(prefix.length));
      if (path in proj.files) { openFile(path, { preview: !opts.pin }); return editor.getModel(); }
    }
    let m = monaco.editor.getModel(resource) || libModels.get(uri);
    if (!m) { const lib = libByUri.get(uri); if (lib) { m = monaco.editor.createModel(lib.content, "typescript", monaco.Uri.parse(lib.filePath)); libModels.set(uri, m); } }
    if (m) {
      // a library / unlisted file: read-only. Surfaced as a preview (italic) tab
      // unless pinned, and revealed in the Type Libraries tree.
      const decoded = decodeURIComponent(uri.replace(/^file:\/\/\//, "")).replace(/^node_modules\//, "").replace(/^@types\//, "");
      const name = decoded.split("/").slice(-2).join("/");
      libView = { uri, name };
      libFiles.set(uri, { uri, name });
      if (opts.pin) pinLib({ uri, name }); else if (!isPinnedLib(uri)) preview = { kind: "lib", uri, name };
      revealLibPath(uri);
      editor.setModel(m); renderFiles(); renderFtabs();
      const row = $("files").querySelector(".tv-row.active"); if (row) row.scrollIntoView({ block: "nearest" });
      return m;
    }
    return null;
  }
  const revealSpan = (model, start, length) => {
    try {
      const a = model.getPositionAt(start), bcol = model.getPositionAt(start + (length || 0));
      const range = { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: bcol.lineNumber, endColumn: bcol.column };
      editor.setSelection(range); editor.revealRangeInCenterIfOutsideViewport(range); editor.focus();
    } catch { /* */ }
  };
  // Standalone go-to-definition can still route cross-model opens through here.
  monaco.editor.registerEditorOpener({ openCodeEditor(_s, resource, sel) { const m = openTarget(resource); if (!m) return false; if (sel && typeof sel.startLineNumber === "number") { editor.setSelection(sel); editor.revealRangeInCenterIfOutsideViewport(sel); } editor.focus(); return true; } });
  async function gotoDefinition(model, position) {
    if (!model || !position) return;
    try {
      const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
      const client = await getWorker(model.uri);
      const defs = await client.getDefinitionAtPosition(model.uri.toString(), model.getOffsetAt(position));
      if (!defs || !defs.length) return;
      const d = defs[0];
      const span = d.textSpan || { start: 0, length: 0 };
      const target = monaco.Uri.parse(d.fileName);
      if (target.toString() === model.uri.toString()) { revealSpan(model, span.start, span.length); return; }
      const tm = openTarget(target);
      if (tm) revealSpan(tm, span.start, span.length);
    } catch { /* */ }
  }
  // let the Explorer's "Libraries" rows re-open a declaration file read-only
  openLib = (uri, opts) => { const m = openTarget(monaco.Uri.parse(uri), opts); if (!m && libFiles.has(uri)) { libFiles.delete(uri); renderFiles(); } };
  // populate node_modules with EVERY declaration file the editor loaded — the
  // whole @wunk types closure + the lb-inject / lb-repl module decls — so the
  // full type tree is browsable (rendered lazily: collapsed folders cost nothing)
  for (const l of baseExtraLibs) { if (!/\/node_modules\//.test(l.filePath)) continue; const u = monaco.Uri.parse(l.filePath).toString(); libFiles.set(u, { uri: u, name: libRelPath(u).split("/").pop() }); }
  editor.addCommand(monaco.KeyCode.F12, () => gotoDefinition(editor.getModel(), editor.getPosition()));
  editor.onMouseDown((e) => {
    const oe = e.event;
    if ((oe.ctrlKey || oe.metaKey) && !oe.altKey && e.target && e.target.position && e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
      try { oe.preventDefault(); } catch { /* */ }
      // defer out of Monaco's mouse dispatch — invoking the TS worker synchronously
      // mid-dispatch deadlocks the worker channel
      const model = editor.getModel(), pos = e.target.position;
      setTimeout(() => gotoDefinition(model, pos), 0);
    }
  });

  // theme selector
  const themeSel = $("themeSel");
  for (const [id, t] of Object.entries(THEMES)) { const o = document.createElement("option"); o.value = id; o.textContent = t.name; themeSel.appendChild(o); }
  themeSel.value = themeId;
  themeSel.onchange = () => applyTheme(themeSel.value);

  meta = (await dbGet(M_STORE, "open")) || { ids: [], current: null };
  const wanted = location.hash.replace(/^#/, "");
  if (wanted.startsWith("share=")) {
    let payload = null;
    try { payload = await decodeShare(wanted); } catch { /* */ }
    if (payload && validShare(payload)) await importShared(payload);
    else { log("invalid share link", "e"); if (!(meta.ids.length && (await loadProject(meta.ids[0])))) await createProject("default-ts"); }
  }
  else if (wanted && meta.ids.includes(wanted)) await loadProject(wanted);
  else if (meta.current && meta.ids.includes(meta.current) && (await loadProject(meta.current))) {}
  else if (meta.ids.length && (await loadProject(meta.ids[0]))) {}
  else await createProject("default-ts");

  $("build").onclick = build;
  $("download").onclick = download;
  $("format").onclick = formatActive;
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, formatActive);
  $("exportBtn").onclick = () => showPop($("exportBtn"), (el) => {
    el.appendChild(popItem("Current file", downloadCurrentFile, activeFileName().split("/").pop() || "—"));
    el.appendChild(popItem("Project (.zip)", downloadProjectZip, (Object.keys(proj.files).length) + " files"));
    const b = currentBuild(); if (b) { const sep = document.createElement("div"); sep.className = "sep"; el.appendChild(sep); el.appendChild(popItem("Built .mjs", download, b.name)); }
  });
  $("buildCfg").onclick = () => showPop($("buildCfg"), (el) => {
    const cfg = buildConfig();
    const toggle = (key, label) => { const lbl = document.createElement("label"); lbl.className = "item"; const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!cfg[key]; cb.onchange = () => setBuildField(key, cb.checked); lbl.appendChild(cb); lbl.appendChild(document.createTextNode(label)); return lbl; };
    el.appendChild(toggle("minify", "Minify output"));
    el.appendChild(toggle("sourcemap", "Inline source map"));
    el.appendChild(toggle("keepNames", "Keep names"));
    const jsep = document.createElement("div"); jsep.className = "sep"; el.appendChild(jsep);
    // JVM type-info — same checkbox idiom as the toggles above. Per-project. On first
    // enable it fetches the registry-lb typings (~0.6 MB gz) and types bare
    // Java.type("net.ccbluex...") string literals; off leaves them `any`.
    const jlbl = document.createElement("label"); jlbl.className = "item";
    const jcb = document.createElement("input"); jcb.type = "checkbox"; jcb.checked = jvmTypesLevel() === "lb";
    jcb.onchange = () => { setJvmTypes(jcb.checked ? "lb" : "off"); log("JVM type info: " + (jcb.checked ? "LiquidBounce" : "off"), "d"); };
    jlbl.appendChild(jcb); jlbl.appendChild(document.createTextNode('Type Java.type("…") strings (LiquidBounce)'));
    el.appendChild(jlbl);
    // Error-on-any linter (strict): flags any-typed expressions (e.g. an untyped Java.type)
    const albl = document.createElement("label"); albl.className = "item";
    const acb = document.createElement("input"); acb.type = "checkbox"; acb.checked = antiAnyOn();
    acb.onchange = () => { setAntiAny(acb.checked); log("Error on any: " + (acb.checked ? "on" : "off"), "d"); };
    albl.appendChild(acb); albl.appendChild(document.createTextNode("Error on \u201cany\u201d (strict)"));
    el.appendChild(albl);
    const sep = document.createElement("div"); sep.className = "sep"; el.appendChild(sep);
    el.appendChild(popItem("Edit build config…", () => { ensureBuildConfigFile(); if (!showAux) setShowAux(true); openFile(BUILD_FILE); }, "lbbuild.config.json"));
    const note = document.createElement("div"); note.className = "item"; note.style.cssText = "cursor:default;font-size:11px;color:var(--fgdim)"; note.textContent = "target " + (cfg.target || "es2022") + " · " + (cfg.format || "esm"); el.appendChild(note);
  });
  $("importFiles").onclick = () => { const inp = $("fileInput"); inp.value = ""; inp.onchange = () => importFiles(inp.files); inp.click(); };
  for (const id of ["editor", "side"]) { const el = $(id); el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("dropping"); }); el.addEventListener("dragleave", (e) => { if (e.target === el) el.classList.remove("dropping"); }); el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("dropping"); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) importFiles(e.dataTransfer.files); }); }

  // resizable panels (sidebar width + output/log height), VS Code-style, persisted
  try { const sw = localStorage.getItem("lb-ide:sideW"); if (sw) document.documentElement.style.setProperty("--sideW", sw + "px"); const lh = localStorage.getItem("lb-ide:logH"); if (lh) document.documentElement.style.setProperty("--logH", lh + "px"); } catch { /* */ }
  const relayout = () => { try { editor.layout(); } catch { /* */ } };
  const dragSplit = (handle, onMove) => handle.addEventListener("mousedown", (e) => {
    e.preventDefault(); handle.classList.add("dragging"); document.body.style.userSelect = "none";
    const mv = (ev) => { onMove(ev); relayout(); };
    const up = () => { handle.classList.remove("dragging"); document.body.style.userSelect = ""; document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); relayout(); };
    document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
  });
  dragSplit($("resizeSide"), (ev) => { const r = $("mid").getBoundingClientRect(); let w = Math.round(ev.clientX - r.left); w = Math.max(140, Math.min(w, r.width - 240)); document.documentElement.style.setProperty("--sideW", w + "px"); try { localStorage.setItem("lb-ide:sideW", String(w)); } catch { /* */ } });
  dragSplit($("resizeLog"), (ev) => { const r = $("rightpane").getBoundingClientRect(); let h = Math.round(r.bottom - ev.clientY); h = Math.max(0, Math.min(h, r.height - 120)); document.documentElement.style.setProperty("--logH", h + "px"); try { localStorage.setItem("lb-ide:logH", String(h)); } catch { /* */ } });

  // Host-bridge mode: when served by the in-client server (lb-ide-host), an
  // /api/ping responds — then offer "build & run in client" (loads the built
  // .mjs straight into LiquidBounce). On the plain web deploy this 404s and the
  // button stays hidden, so this is purely additive.
  (async () => {
    try {
      const r = await apiFetch("api/ping", { method: "GET" });
      if (!(r.ok && (await r.json()).ok)) return;
      bridgeOn = true;
      $("sbBridge").style.display = "";
      $("runClient").style.display = ""; $("autoRun").style.display = ""; $("dbg").style.display = ""; $("replBtn").style.display = ""; $("openHeavy").style.display = "";
      log("connected to LiquidBounce (in-client) — projects persist on disk; run/hot-reload/debug enabled", "d");
      // pull any projects saved on disk (durable across CEF sessions) into the tabs
      try {
        const disk = await apiFetch("api/projects").then((x) => x.json());
        let added = 0;
        for (const dp of disk || []) {
          if (dp && dp.id && !meta.ids.includes(dp.id)) { await dbPut(P_STORE, dp.id, dp); meta.ids.push(dp.id); added++; }
        }
        if (added) { await saveMeta(); renderTabs(); log("restored " + added + " project(s) from disk", "d"); }
      } catch { /* */ }
      await refreshTemplates();  // pull user/fetched templates into the New menu
    } catch { /* not in-client */ }
  })();
  async function loadToClient() {
    await build();
    const b = currentBuild();
    if (!b) return;
    const res = await apiFetch("api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: proj.name, mjs: b.code, debug: debugOn }) }).then((r) => r.json());
    if (res.ok) {
      log("✓ loaded into client as " + res.name + (res.debugPort ? " · inspector on :" + res.debugPort : ""), "s");
      if (res.debugPort) log("attach a debugger: open chrome://inspect (or VS Code) → localhost:" + res.debugPort, "d");
    } else log("✗ load failed: " + (res.error || "?"), "e");
  }
  $("runClient").onclick = async () => { $("runClient").disabled = true; try { await loadToClient(); } catch (e) { log("✗ run-in-client failed: " + (e && e.message || e), "e"); } finally { $("runClient").disabled = false; } };

  // Open the current project in the heavy (full VS Code) editor. Persists it to
  // the host first (the heavy editor sources the SAME project from the bridge via
  // /api/projects), then opens the heavy host with ?project=<id>. The heavy URL is
  // configurable (localStorage "lb-ide:heavyUrl"); prompts once if unset.
  $("openHeavy").onclick = async () => {
    if (!proj) return;
    let heavy = (localStorage.getItem("lb-ide:heavyUrl") || "").trim();
    if (!heavy) { heavy = (prompt("Heavy editor URL:", "http://localhost:9900") || "").trim(); if (!heavy) return; localStorage.setItem("lb-ide:heavyUrl", heavy); }
    // Only navigate to an http(s) origin (reject javascript:/data: and other schemes).
    let heavyOrigin; try { heavyOrigin = new URL(heavy); } catch { log("✗ invalid heavy editor URL", "e"); return; }
    if (heavyOrigin.protocol !== "http:" && heavyOrigin.protocol !== "https:") { log("✗ heavy editor URL must be http(s)", "e"); return; }
    try { const r = await apiFetch("api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proj) }); if (!r.ok) throw new Error("HTTP " + r.status); }
    catch (e) { log("✗ couldn't persist project to host before opening heavy: " + (e && e.message || e), "e"); return; }
    const url = heavy.replace(/\/+$/, "") + "/?project=" + encodeURIComponent(proj.id);
    log("opening in heavy editor: " + url, "d");
    window.open(url, "_blank");
  };

  // hot reload: rebuild + reload in client on edits (debounced) when enabled
  hotReloadFn = () => { clearTimeout(hotTimer); hotTimer = setTimeout(() => { if (autoRun && bridgeOn) loadToClient().catch(() => {}); }, 900); };
  $("autoRun").onclick = () => { autoRun = !autoRun; $("autoRun").textContent = "hot-reload: " + (autoRun ? "on" : "off"); $("autoRun").classList.toggle("on", autoRun); if (autoRun) loadToClient().catch(() => {}); };
  $("dbg").onclick = () => { debugOn = !debugOn; $("dbg").textContent = "debug: " + (debugOn ? "on" : "off"); $("dbg").classList.toggle("on", debugOn); };

  // REPL: a typed snippet box that evals in the client (last expression shown).
  let replEd = null;
  const appendRepl = (text, cls) => { const o = $("replOut"); const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = text; o.appendChild(d); o.scrollTop = o.scrollHeight; };
  async function runRepl() {
    if (!replEd) return;
    const code = replEd.getModel().getValue();
    appendRepl("› " + code.replace(/\s*\n\s*/g, " ⏎ "), "in");
    try {
      const res = await apiFetch("api/repl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }).then((r) => r.json());
      if (res.output) appendRepl(res.output, "log");
      appendRepl(res.ok ? "⇐ " + String(res.result) : "✗ " + (res.error || "?"), res.ok ? "ok" : "err");
    } catch (e) { appendRepl("✗ " + (e && e.message || e), "err"); }
  }
  function ensureRepl() {
    if (replEd) return;
    const model = monaco.editor.createModel(
      '/// <reference types="@wunk/lb-script-api-types/ambient" />\n// runs in the client — the last expression is shown. Ctrl/Cmd+Enter.\nmc.player ? mc.player.position() : "no player"',
      "typescript", monaco.Uri.parse("file:///__repl__/snippet.ts"));
    replEd = monaco.editor.create($("replEditor"), { model, theme: "lb-active", automaticLayout: true, fontSize: 13, minimap: { enabled: false } });
    replEd.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runRepl);
  }
  // live log stream (SSE) — OPT-IN via the "live log" toggle. When on, log(...)
  // calls in snippets/scripts stream here in real time (incl. async callbacks).
  let replStream = null;
  function setLive(on) {
    if (on && !replStream && bridgeOn) {
      try {
        replStream = new EventSource(BASE + "api/repl/stream?token=" + encodeURIComponent(API_TOKEN));
        replStream.onmessage = (e) => { try { appendRepl(JSON.parse(e.data), "stream"); } catch { appendRepl(e.data, "stream"); } };
      } catch { /* */ }
    } else if (!on && replStream) { try { replStream.close(); } catch { /* */ } replStream = null; }
    $("replLive").textContent = "live log: " + (replStream ? "on" : "off");
    $("replLive").classList.toggle("on", !!replStream);
  }
  $("replLive").onclick = () => setLive(!replStream);
  $("replBtn").onclick = () => { const el = $("repl"); el.classList.toggle("open"); if (el.classList.contains("open")) { ensureRepl(); setTimeout(() => { replEd.layout(); replEd.focus(); }, 0); } };
  $("replRun").onclick = runRepl;
  $("replClose").onclick = () => { $("repl").classList.remove("open"); setLive(false); };
  $("addFile").onclick = () => addFileAt("");
  $("addFolder").onclick = () => addFolderAt("");
  $("collapseAll").onclick = () => { for (const d of allDirPaths()) collapsed.add(d); renderFiles(); };
  $("toggleAux").onclick = () => setShowAux(!showAux);
  $("toggleAux").classList.toggle("on", showAux);
  $("rename").onclick = async () => { const n = prompt("Project name:", proj.name); if (!n) return; proj.name = n; await saveProject(); renderTabs(); };
  $("share").onclick = shareProject;

  setStatus("ready");
  log("ready — " + meta.ids.length + " project(s), " + CATEGORIES.length + " templates", "d");
  checkVersion(); // non-blocking, best-effort GitHub release check (3s timeout)

  window.__ide = {
    ready: true,
    templates: () => CATEGORIES.map((t) => t.id),
    categories: () => CATEGORIES.map((c) => ({ id: c.id, name: c.name, baseFiles: Object.keys(c.base.files), examples: c.examples.map((e) => ({ id: e.id, name: e.name, files: Object.keys(e.files) })) })),
    listProjects: () => meta.ids.slice(),
    current: () => ({ id: proj.id, name: proj.name, templateId: proj.templateId }),
    listFiles: () => Object.keys(proj.files),
    writeFile: (path, content) => { proj.files[path] = content; openFile(path); },
    openFile: (path) => openFile(path),
    openTabs: () => (proj.openTabs || []).slice(),
    openFilePreview: (path) => openFile(path, { preview: true }),
    previewState: () => (preview ? (preview.kind === "file" ? { kind: "file", path: preview.path } : { kind: "lib", name: preview.name }) : null),
    pinnedLibs: () => pinnedLibs.map((l) => l.name),
    closeTab: (path) => closeTab(path),
    auxFiles: () => (proj.aux || []).slice(),
    treeLabels: () => [...document.querySelectorAll("#files .tv-row .nm")].map((n) => n.textContent),
    setShowAux: (v) => setShowAux(v),
    diagnosticsFor: async (path) => { const m = ensureModel(path); const gw = await monaco.languages.typescript.getTypeScriptWorker(); const c = await gw(m.uri); const u = m.uri.toString(); const ds = [...(await c.getSyntacticDiagnostics(u)), ...(await c.getSemanticDiagnostics(u))]; return ds.map((d) => ({ code: d.code })); },
    createProject: (cid, exId) => createProject(cid, exId),
    switchProject: (id) => loadProject(id),
    closeProject: (id) => closeProject(id),
    setActiveValue: (v) => editor.getModel().setValue(v),
    diagnostics: async () => { const m = editor.getModel(); const gw = await monaco.languages.typescript.getTypeScriptWorker(); const c = await gw(m.uri); const u = m.uri.toString(); const ds = [...(await c.getSyntacticDiagnostics(u)), ...(await c.getSemanticDiagnostics(u))]; return ds.map((d) => ({ code: d.code, message: typeof d.messageText === "string" ? d.messageText : d.messageText.messageText })); },
    build: async () => { await build(); return currentBuild(); },
    share: () => shareProject(),
    activeContent: () => editor.getModel().getValue(),
    // in-page exercise of the share decode→validate→import path (no page reload)
    loadShareFragment: async (frag) => { let p = null; try { p = await decodeShare("share=" + frag); } catch { /* */ } if (p && validShare(p)) { await importShared(p); return { imported: true }; } return { imported: false }; },
    gotoDefinition: async (line, col) => { await gotoDefinition(editor.getModel(), { lineNumber: line, column: col }); const m = editor.getModel(); return { uri: m.uri.toString(), readOnly: editor.getOption(monaco.editor.EditorOption.readOnly), sel: editor.getSelection() }; },
    libView: () => libView,
    activeRowVisible: () => { const r = $("files").querySelector(".tv-row.active"); if (!r) return false; const cr = r.getBoundingClientRect(), pr = $("side").getBoundingClientRect(); return cr.top >= pr.top - 1 && cr.bottom <= pr.bottom + 1; },
    format: async () => { await formatActive(); return editor.getModel().getValue(); },
    setMinify: (v) => { proj.build = { ...(proj.build || {}), minify: !!v }; },
    setBuildConfig: (obj) => writeBuildConfig({ ...DEFAULT_BUILD, ...obj }),
    getBuildConfig: () => buildConfig(),
    setJvmTypes: (level) => setJvmTypes(level),
    jvmTypes: () => jvmTypesLevel(),
    setAntiAny: (v) => setAntiAny(v),
    antiAny: () => antiAnyOn(),
    anyMarkers: () => monaco.editor.getModelMarkers({ owner: ANY_MARKER_OWNER }).map((m) => ({ message: m.message, line: m.startLineNumber, col: m.startColumn })),
    exportZipBytes: () => { const enc = new TextEncoder(); return Array.from(makeZip(Object.keys(proj.files).sort().map((n) => ({ name: n, data: enc.encode(proj.files[n]) })))); },
    importText: (name, content) => { const p = importOneFile(name, content); openFile(p); return p; },
    downloadBtnDisabled: () => $("download").disabled,
    themes: () => Object.keys(THEMES),
    theme: () => themeId,
    setTheme: (id) => applyTheme(id),
    reloadMeta: async () => await dbGet(M_STORE, "open"),
    getProject: async (id) => await dbGet(P_STORE, id),
  };
});
