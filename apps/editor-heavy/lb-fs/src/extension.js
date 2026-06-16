// LB heavy-mode workspace FILE SYSTEM PROVIDER (web). Provisions the heavy editor's
// workspace from the same ScriptManager bridge the lean editor uses, so both modes
// edit the one project rather than a fixture.
//
// On activation (onFileSystem:lbfs) it:
//   1. derives the heavy host origin from its own extensionUri, fetches /lb/config
//      ({bridgeBase, bridgeToken, projectId}),
//   2. pulls the project from the bridge (createBridge(...).projects(), by id),
//      the same token-headered API lean's save writes to,
//   3. seeds an in-memory FS with the project files + the barrel typings
//      (barrel.d.ts/ambient.d.ts fetched from the host) + a tsconfig that includes
//      them (full @wunk intellisense with zero per-file FS probing),
//   4. registers an `lbfs:/` FileSystemProvider; writes are mirrored back to the
//      bridge via save() (debounced) so heavy edits land in the same project.
import * as vscode from "vscode";
import { createBridge } from "@lb-ide/core/bridge";

const enc = new TextEncoder();
const dec = new TextDecoder();
const F = vscode.FileType;

// tsconfig that pulls the barrel + ambient globals into the program (no /// refs
// needed in user files). bundler resolution matches the lean editor's @wunk setup.
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext"], strict: true, skipLibCheck: true, noEmit: true, allowJs: true },
  include: ["**/*.ts", "**/*.js", "barrel.d.ts", "ambient.d.ts"],
}, null, 2);

class LbFs {
  constructor() {
    this.files = new Map();          // path → { type, data?:Uint8Array, mtime, ctime }
    this.provisioned = new Set();    // paths we injected (excluded from writeback)
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this._emitter.event;
    this.project = null;             // { id, name, files }
    this.ready = null;
    this._saveTimer = null;
  }

  // ---- provisioning ---------------------------------------------------------
  async init(context) {
    // Never leave `ready` rejected - a rejected promise would make every stat/
    // readFile throw forever (unrecoverable broken window). On failure, surface
    // the error and resolve with whatever was seeded (at worst an empty root).
    if (!this.ready) this.ready = this._provision(context).catch((e) => {
      vscode.window.showErrorMessage("LB workspace failed to load: " + (e && e.message || e));
      console.error("[lbfs] provision failed", e);
    });
    return this.ready;
  }
  async _provision(context) {
    // Host root = origin + base path. The base is whatever prefix the extension is
    // served under (".../fsext"), so the static build works under Caddy's
    // handle_path prefix (e.g. /liquid-ide) AND at the root in dev.
    const u = context.extensionUri;
    const origin = `${u.scheme}://${u.authority}`;
    const base = u.path.replace(/\/fsext\/?$/, "");
    const root = origin + base;
    const cfg = await fetch(root + "/lb/config").then((r) => r.json());
    // The project id rides in the workspace folder authority (lbfs://<id>/) so the
    // lean-to-heavy switch can target any project; fall back to the host's default.
    // Constrain it to the project-id charset (it keys bridge lookups + writeback).
    let wantId = vscode.workspace.workspaceFolders?.[0]?.uri.authority || cfg.projectId || "";
    if (!/^[a-zA-Z0-9_-]+$/.test(wantId)) wantId = cfg.projectId || "";
    const [barrel, ambient] = await Promise.all([
      fetch(root + "/typings/barrel.d.ts").then((r) => r.text()),
      fetch(root + "/typings/ambient.d.ts").then((r) => r.text()),
    ]);
    // Project source: the live ScriptManager bridge (read/write) when configured,
    // else a static read-only project baked into the deploy (no bridge yet).
    // bridgeBase: "" = no bridge; "self" = same-origin HTTP (resolve to the absolute
    // host root, since a relative base can't be fetched from the ext-host worker);
    // an absolute ws(s)://… or http(s)://… is used as-is.
    let proj;
    const bridgeBase = cfg.bridgeBase === "self" ? root + "/" : cfg.bridgeBase;
    if (bridgeBase) {
      const bridge = createBridge({ base: bridgeBase, token: cfg.bridgeToken, fetchImpl: (...a) => fetch(...a) });
      const projects = await bridge.projects();
      this.bridge = bridge;
      proj = (Array.isArray(projects) ? projects : []).find((p) => p.id === wantId) || (Array.isArray(projects) ? projects[0] : null);
    } else {
      proj = await fetch(root + "/lb/project.json").then((r) => r.json()).catch(() => null);  // read-only demo
    }
    if (!proj) throw new Error("lbfs: project not found: " + wantId);
    this.project = { id: proj.id, name: proj.name, files: { ...proj.files } };
    // seed user project files
    for (const [p, content] of Object.entries(proj.files)) this._set("/" + p, enc.encode(content));
    // seed provisioned files (excluded from writeback): barrel typings, a tsconfig
    // that pulls them in, and .vscode/settings.json so lb-glue's commands reach the
    // SAME bridge. Inject the RESOLVED absolute base (not "self") so the glue, which
    // can't resolve "self", gets a directly-usable http(s)/ws(s) base.
    const settings = JSON.stringify({ "lb.hostBase": bridgeBase || "", "lb.hostToken": cfg.bridgeToken }, null, 2);
    for (const [p, content] of [["/barrel.d.ts", barrel], ["/ambient.d.ts", ambient], ["/tsconfig.json", TSCONFIG], ["/.vscode/settings.json", settings]]) {
      this._set(p, enc.encode(content)); this.provisioned.add(p);
    }
  }
  _set(path, data) { this.files.set(path, { type: F.File, data, mtime: Date.now(), ctime: Date.now() }); }

  _dirs() {
    // implicit directories from file paths
    const dirs = new Set(["/"]);
    for (const p of this.files.keys()) { const parts = p.split("/").slice(1, -1); let cur = ""; for (const seg of parts) { cur += "/" + seg; dirs.add(cur); } }
    return dirs;
  }

  // ---- FileSystemProvider ---------------------------------------------------
  watch() { return new vscode.Disposable(() => {}); }
  async stat(uri) {
    await this.ready;
    const p = uri.path === "" ? "/" : uri.path;
    if (this._dirs().has(p)) return { type: F.Directory, ctime: 0, mtime: 0, size: 0 };
    const f = this.files.get(p);
    if (!f) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: F.File, ctime: f.ctime, mtime: f.mtime, size: f.data.length };
  }
  async readDirectory(uri) {
    await this.ready;
    const base = uri.path === "/" ? "" : uri.path;
    const seen = new Map();
    for (const p of this.files.keys()) {
      if (!p.startsWith(base + "/")) continue;
      const rest = p.slice(base.length + 1);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, F.File);
      else seen.set(rest.slice(0, slash), F.Directory);
    }
    return [...seen.entries()];
  }
  async readFile(uri) {
    await this.ready;
    const f = this.files.get(uri.path);
    if (!f) throw vscode.FileSystemError.FileNotFound(uri);
    return f.data;
  }
  createDirectory() { /* implicit dirs */ }
  async writeFile(uri, content, _opts) {
    await this.ready;
    const existed = this.files.has(uri.path);
    this._set(uri.path, content);
    this._emitter.fire([{ type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
    this._scheduleSave();
  }
  _forget(path) { this.files.delete(path); this.provisioned.delete(path); }
  _move(from, to) { const v = this.files.get(from); this.files.delete(from); this.files.set(to, v); if (this.provisioned.delete(from)) this.provisioned.add(to); }
  async delete(uri) {
    await this.ready;
    // A file, or a directory (every key under <path>/).
    if (this.files.has(uri.path)) this._forget(uri.path);
    else { const pre = uri.path + "/"; for (const k of [...this.files.keys()]) if (k.startsWith(pre)) this._forget(k); }
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    this._scheduleSave();
  }
  async rename(oldUri, newUri) {
    await this.ready;
    // Keep the provisioned set in lockstep so renamed typings/tsconfig aren't
    // persisted into the project (and renamed user files become writeback-eligible).
    if (this.files.has(oldUri.path)) this._move(oldUri.path, newUri.path);
    else { // directory rename: move every child key
      const pre = oldUri.path + "/";
      for (const k of [...this.files.keys()]) if (k.startsWith(pre)) this._move(k, newUri.path + k.slice(oldUri.path.length));
    }
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri }]);
    this._scheduleSave();
  }

  // ---- writeback to the bridge (same project lean sees) ---------------------
  _scheduleSave() {
    if (!this.bridge || !this.project) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 600);
  }
  async _save() {
    const files = {};
    for (const [p, f] of this.files) { if (this.provisioned.has(p)) continue; files["/" === p[0] ? p.slice(1) : p] = dec.decode(f.data); }
    this.project.files = files;
    try { await this.bridge.save({ ...this.project, updatedAt: Date.now() }); } catch (e) { console.error("lbfs save failed", e); }
  }
}

export function activate(context) {
  const fs = new LbFs();
  fs.init(context);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider("lbfs", fs, { isCaseSensitive: true }));
}
export function deactivate() {}
