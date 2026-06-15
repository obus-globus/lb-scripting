// LB heavy-mode workspace FILE SYSTEM PROVIDER (web). Provisions the heavy editor's
// workspace from the SAME ScriptManager bridge the lean editor uses, so both modes
// edit the same project — not a fixture.
//
// On activation (onFileSystem:lbfs) it:
//   1. derives the heavy host origin from its own extensionUri, fetches /lb/config
//      ({bridgeBase, bridgeToken, projectId}),
//   2. pulls the project from the bridge (createBridge(...).projects() → by id) —
//      same token-headered API lean's save writes to,
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
    if (!this.ready) this.ready = this._provision(context);
    return this.ready;
  }
  async _provision(context) {
    const origin = `${context.extensionUri.scheme}://${context.extensionUri.authority}`;
    const cfg = await fetch(origin + "/lb/config").then((r) => r.json());
    // The project id rides in the workspace folder authority (lbfs://<id>/) so the
    // lean→heavy switch can target any project; fall back to the host's default.
    const wantId = vscode.workspace.workspaceFolders?.[0]?.uri.authority || cfg.projectId;
    const bridge = createBridge({ base: cfg.bridgeBase, token: cfg.bridgeToken, fetchImpl: (...a) => fetch(...a) });
    const [projects, barrel, ambient] = await Promise.all([
      bridge.projects(),
      fetch(origin + "/typings/barrel.d.ts").then((r) => r.text()),
      fetch(origin + "/typings/ambient.d.ts").then((r) => r.text()),
    ]);
    this.bridge = bridge;
    const proj = (Array.isArray(projects) ? projects : []).find((p) => p.id === wantId) || (Array.isArray(projects) ? projects[0] : null);
    if (!proj) throw new Error("lbfs: project not found: " + wantId);
    this.project = { id: proj.id, name: proj.name, files: { ...proj.files } };
    // seed user project files
    for (const [p, content] of Object.entries(proj.files)) this._set("/" + p, enc.encode(content));
    // seed provisioned files (excluded from writeback): barrel typings, a tsconfig
    // that pulls them in, and .vscode/settings.json so the lb-glue build command
    // can reach the SAME bridge (build & run in client).
    const settings = JSON.stringify({ "lb.hostBase": cfg.bridgeBase, "lb.hostToken": cfg.bridgeToken }, null, 2);
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
  async delete(uri) {
    await this.ready;
    this.files.delete(uri.path);
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    this._scheduleSave();
  }
  async rename(oldUri, newUri) {
    await this.ready;
    const f = this.files.get(oldUri.path);
    if (!f) throw vscode.FileSystemError.FileNotFound(oldUri);
    this.files.delete(oldUri.path); this.files.set(newUri.path, f);
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
