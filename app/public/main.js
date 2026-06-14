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
let CATEGORIES = [];
let INJECT_DTS = "";
let injectBundle = null; // lazily fetched lb-inject runtime
let baseExtraLibs = [];

let meta = { ids: [], current: null };   // open project tabs + selection
let proj = null;                          // current project { id, name, templateId, files, active }
let bridgeOn = false;                     // talking to the in-client host (lb-ide-host)
let autoRun = false, debugOn = false;     // hot-reload + debug toggles (in-client)
let hotReloadFn = null, hotTimer = null;
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
    m.onDidChangeContent(() => { proj.files[path] = m.getValue(); scheduleSave(); if (hotReloadFn) hotReloadFn(); });
    models.set(path, m);
  }
  return m;
}
function openFile(path) {
  proj.active = path;
  if (!proj.openTabs) proj.openTabs = [];
  if (!proj.openTabs.includes(path)) proj.openTabs.push(path);
  editor.setModel(ensureModel(path));
  renderFiles(); renderFtabs(); scheduleSave();
}
function closeTab(path) {
  proj.openTabs = (proj.openTabs || []).filter((p) => p !== path);
  if (proj.active === path) {
    const next = proj.openTabs[proj.openTabs.length - 1];
    if (next) openFile(next);
    else { proj.active = null; editor.setModel(null); renderFiles(); renderFtabs(); scheduleSave(); }
  } else { renderFtabs(); scheduleSave(); }
}
function renderFtabs() {
  const wrap = $("ftabs"); wrap.innerHTML = "";
  for (const path of proj.openTabs || []) {
    if (!(path in proj.files)) continue;
    const tab = document.createElement("div"); tab.className = "ftab" + (path === proj.active ? " active" : "");
    const slash = path.lastIndexOf("/");
    const label = document.createElement("span");
    if (slash >= 0) { const dir = document.createElement("span"); dir.className = "dir"; dir.textContent = path.slice(0, slash + 1); label.appendChild(dir); label.appendChild(document.createTextNode(path.slice(slash + 1))); }
    else label.textContent = path;
    label.onclick = () => { if (path !== proj.active) openFile(path); };
    tab.appendChild(label);
    const x = document.createElement("span"); x.className = "x"; x.textContent = "✕"; x.title = "close tab"; x.onclick = (e) => { e.stopPropagation(); closeTab(path); };
    tab.appendChild(x);
    wrap.appendChild(tab);
  }
}

const collapsed = new Set(); // folder paths the user has collapsed (per session)
const isAux = (path) => !!(proj && proj.aux && proj.aux.includes(path));
let showAux = localStorage.getItem("lb-ide:showAux") === "1";

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
};
function fileIcon(name) {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const color = ext === "ts" ? "#4e9bd6" : ext === "js" ? "#cbcb41" : ext === "json" ? "#cbcb41" : ext === "md" ? "#519aba" : "#9aa0a6";
  return `<svg viewBox="0 0 16 16"><path fill="${color}" d="M9.5 1H4l-.5.5v13l.5.5h9l.5-.5V5L9.5 1zM9 2.2L11.8 5H9V2.2z"/></svg>`;
}
function allDirPaths() {
  const out = []; const walk = (n) => { for (const [, d] of n.dirs) { out.push(d.path); walk(d); } }; walk(buildTree()); return out;
}

function tvRow({ depth, twisty, iconHtml, label, isActive, isRoot, dim, onClick, actions }) {
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
        depth, twisty: "", iconHtml: fileIcon(f.name), label: f.name, isActive: f.path === proj.active, dim: isAux(f.path),
        onClick: () => openFile(f.path),
        actions: [{ title: "Delete", icon: SVG.trash, run: () => deleteFile(f.path) }],
      }));
    }
  };
  render(buildTree(filter), 1);
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
function categoryById(cid) { return CATEGORIES.find((c) => c.id === cid) || CATEGORIES[0]; }
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
      it.innerHTML = "<div><b>" + title + "</b>" + (desc ? "<span>" + desc + "</span>" : "") + "</div>";
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
  for (const cat of CATEGORIES) {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = "<span>" + cat.name + "</span><span class='arrow'>▸</span>";
    row.onmouseenter = () => openSub(cat, row);
    row.onclick = () => openSub(cat, row);
    menu.appendChild(row);
  }
  if (bridgeOn) {
    const sep = document.createElement("div"); sep.className = "sep"; menu.appendChild(sep);
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = "<span>Open installed script…</span>";
    row.onmouseenter = () => { sub.style.display = "none"; [...menu.querySelectorAll(".row")].forEach((r) => r.classList.remove("active")); };
    row.onclick = () => { hideTemplateMenu(); openInstalledScriptPicker(); };
    menu.appendChild(row);
  }
  const r = $("newProj").getBoundingClientRect();
  menu.style.left = Math.max(6, r.left) + "px"; menu.style.top = r.bottom + 4 + "px"; menu.style.display = "block";
}

// Bridge: list installed scripts, open the chosen one as a single-file project.
async function openInstalledScriptPicker() {
  let names = [];
  try { names = await fetch(BASE + "api/scripts").then((r) => r.json()); } catch { /* */ }
  if (!names || !names.length) { log("no installed scripts found", "d"); return; }
  const menu = $("tmplMenu"); menu.innerHTML = "";
  for (const name of names) {
    const item = document.createElement("div"); item.className = "item";
    item.innerHTML = "<b>" + name + "</b><span>open from LiquidBounce scripts/</span>";
    item.onclick = async () => {
      menu.style.display = "none";
      try {
        const res = await fetch(BASE + "api/script?name=" + encodeURIComponent(name)).then((r) => r.json());
        if (!res.ok) { log("could not read " + name, "e"); return; }
        await openAsProject(name, res.content);
      } catch (e) { log("open failed: " + (e && e.message || e), "e"); }
    };
    menu.appendChild(item);
  }
  const r = $("newProj").getBoundingClientRect();
  menu.style.left = Math.max(6, r.left) + "px"; menu.style.top = r.bottom + 4 + "px"; menu.style.display = "block";
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
const openAsProject = openInstalledScriptProject;
document.addEventListener("click", (e) => { const m = $("tmplMenu"), s = $("tmplSub"); if (m.style.display === "block" && !m.contains(e.target) && !s.contains(e.target) && e.target.id !== "newProj") hideTemplateMenu(); });

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
async function decodeShare(hash) {
  const raw = hash.slice("share=".length);
  const json = new TextDecoder().decode(await gunzip(b64uDec(raw)));
  return JSON.parse(json);
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
// may be ephemeral). Fire-and-forget; the local copy is the source of truth.
function bridgeSave(p) { try { fetch(BASE + "api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).catch(() => {}); } catch { /* */ } }
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
  [CATEGORIES, INJECT_DTS] = await Promise.all([
    fetch("templates.json").then((r) => r.json()).then((d) => d.categories),
    fetch("lb-inject.d.ts").then((r) => r.text()),
  ]);
  const bundle = await fetch("typings-bundle.json").then((r) => r.json());
  baseExtraLibs = Object.entries(bundle).map(([p, content]) => ({ content, filePath: "file:///" + p }));
  baseExtraLibs.push({ content: INJECT_DTS, filePath: "file:///node_modules/@types/lb-inject/index.d.ts" });
  // `log(...)` is injected by the in-client host into REPL snippets — it streams
  // output live (incl. from async callbacks) to the REPL panel.
  baseExtraLibs.push({ content: "/** REPL/in-client only: stream a value to the live REPL log panel. */\ndeclare function log(...args: any[]): void;", filePath: "file:///node_modules/@types/lb-repl/index.d.ts" });
  configureTS(monaco.languages.typescript.typescriptDefaults, false);
  configureTS(monaco.languages.typescript.javascriptDefaults, true);

  // In-game translucency: ?opacity=NN (20–100). <100 → see the game behind.
  let theme = "vs-dark";
  try {
    const op = Math.max(20, Math.min(100, parseInt(new URLSearchParams(location.search).get("opacity") || "100", 10) || 100));
    if (op < 100) {
      const a = op / 100;
      document.documentElement.style.setProperty("--a", String(a));
      document.documentElement.classList.add("translucent");
      const hex = Math.round(a * 255).toString(16).padStart(2, "0");
      monaco.editor.defineTheme("lb-glass", { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": "#1e1e21" + hex } });
      theme = "lb-glass";
    }
  } catch { /* */ }

  editor = monaco.editor.create($("editor"), { theme, automaticLayout: true, fontSize: 13, minimap: { enabled: false } });

  meta = (await dbGet(M_STORE, "open")) || { ids: [], current: null };
  const wanted = location.hash.replace(/^#/, "");
  if (wanted.startsWith("share=")) {
    try { await importShared(await decodeShare(wanted)); }
    catch { log("invalid share link", "e"); if (!(meta.ids.length && (await loadProject(meta.ids[0])))) await createProject("default-ts"); }
  }
  else if (wanted && meta.ids.includes(wanted)) await loadProject(wanted);
  else if (meta.current && meta.ids.includes(meta.current) && (await loadProject(meta.current))) {}
  else if (meta.ids.length && (await loadProject(meta.ids[0]))) {}
  else await createProject("default-ts");

  $("build").onclick = build;
  $("download").onclick = download;

  // Host-bridge mode: when served by the in-client server (lb-ide-host), an
  // /api/ping responds — then offer "build & run in client" (loads the built
  // .mjs straight into LiquidBounce). On the plain web deploy this 404s and the
  // button stays hidden, so this is purely additive.
  (async () => {
    try {
      const r = await fetch(BASE + "api/ping", { method: "GET" });
      if (!(r.ok && (await r.json()).ok)) return;
      bridgeOn = true;
      $("runClient").style.display = ""; $("autoRun").style.display = ""; $("dbg").style.display = ""; $("replBtn").style.display = "";
      log("connected to LiquidBounce (in-client) — projects persist on disk; run/hot-reload/debug enabled", "d");
      // pull any projects saved on disk (durable across CEF sessions) into the tabs
      try {
        const disk = await fetch(BASE + "api/projects").then((x) => x.json());
        let added = 0;
        for (const dp of disk || []) {
          if (dp && dp.id && !meta.ids.includes(dp.id)) { await dbPut(P_STORE, dp.id, dp); meta.ids.push(dp.id); added++; }
        }
        if (added) { await saveMeta(); renderTabs(); log("restored " + added + " project(s) from disk", "d"); }
      } catch { /* */ }
    } catch { /* not in-client */ }
  })();
  async function loadToClient() {
    await build();
    if (!lastBuild) return;
    const res = await fetch(BASE + "api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: proj.name, mjs: lastBuild.code, debug: debugOn }) }).then((r) => r.json());
    if (res.ok) {
      log("✓ loaded into client as " + res.name + (res.debugPort ? " · inspector on :" + res.debugPort : ""), "s");
      if (res.debugPort) log("attach a debugger: open chrome://inspect (or VS Code) → localhost:" + res.debugPort, "d");
    } else log("✗ load failed: " + (res.error || "?"), "e");
  }
  $("runClient").onclick = async () => { $("runClient").disabled = true; try { await loadToClient(); } catch (e) { log("✗ run-in-client failed: " + (e && e.message || e), "e"); } finally { $("runClient").disabled = false; } };

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
      const res = await fetch(BASE + "api/repl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }).then((r) => r.json());
      if (res.output) appendRepl(res.output, "log");
      appendRepl(res.ok ? "⇐ " + String(res.result) : "✗ " + (res.error || "?"), res.ok ? "ok" : "err");
    } catch (e) { appendRepl("✗ " + (e && e.message || e), "err"); }
  }
  function ensureRepl() {
    if (replEd) return;
    const model = monaco.editor.createModel(
      '/// <reference types="@wunk/lb-script-api-types/ambient" />\n// runs in the client — the last expression is shown. Ctrl/Cmd+Enter.\nmc.player ? mc.player.position() : "no player"',
      "typescript", monaco.Uri.parse("file:///__repl__/snippet.ts"));
    replEd = monaco.editor.create($("replEditor"), { model, theme, automaticLayout: true, fontSize: 13, minimap: { enabled: false } });
    replEd.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runRepl);
  }
  // live log stream (SSE) — OPT-IN via the "live log" toggle. When on, log(...)
  // calls in snippets/scripts stream here in real time (incl. async callbacks).
  let replStream = null;
  function setLive(on) {
    if (on && !replStream && bridgeOn) {
      try {
        replStream = new EventSource(BASE + "api/repl/stream");
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
  const syncAuxBtn = () => $("toggleAux").classList.toggle("on", showAux);
  $("toggleAux").onclick = () => { showAux = !showAux; localStorage.setItem("lb-ide:showAux", showAux ? "1" : "0"); syncAuxBtn(); renderFiles(); };
  syncAuxBtn();
  $("rename").onclick = async () => { const n = prompt("Project name:", proj.name); if (!n) return; proj.name = n; await saveProject(); renderTabs(); };
  $("share").onclick = shareProject;

  setStatus("ready");
  log("ready — " + meta.ids.length + " project(s), " + CATEGORIES.length + " templates", "d");

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
    closeTab: (path) => closeTab(path),
    auxFiles: () => (proj.aux || []).slice(),
    treeLabels: () => [...document.querySelectorAll("#files .tv-row .nm")].map((n) => n.textContent),
    setShowAux: (v) => { showAux = !!v; localStorage.setItem("lb-ide:showAux", showAux ? "1" : "0"); $("toggleAux").classList.toggle("on", showAux); renderFiles(); },
    diagnosticsFor: async (path) => { const m = ensureModel(path); const gw = await monaco.languages.typescript.getTypeScriptWorker(); const c = await gw(m.uri); const u = m.uri.toString(); const ds = [...(await c.getSyntacticDiagnostics(u)), ...(await c.getSemanticDiagnostics(u))]; return ds.map((d) => ({ code: d.code })); },
    createProject: (cid, exId) => createProject(cid, exId),
    switchProject: (id) => loadProject(id),
    closeProject: (id) => closeProject(id),
    setActiveValue: (v) => editor.getModel().setValue(v),
    diagnostics: async () => { const m = editor.getModel(); const gw = await monaco.languages.typescript.getTypeScriptWorker(); const c = await gw(m.uri); const u = m.uri.toString(); const ds = [...(await c.getSyntacticDiagnostics(u)), ...(await c.getSemanticDiagnostics(u))]; return ds.map((d) => ({ code: d.code, message: typeof d.messageText === "string" ? d.messageText : d.messageText.messageText })); },
    build: async () => { await build(); return lastBuild; },
    share: () => shareProject(),
    activeContent: () => editor.getModel().getValue(),
    reloadMeta: async () => await dbGet(M_STORE, "open"),
    getProject: async (id) => await dbGet(P_STORE, id),
  };
});
