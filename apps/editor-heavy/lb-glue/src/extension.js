// LB heavy-mode glue extension (web). The thin layer wiring VS Code's command/UI
// to the SHARED @lb-ide/core pipeline - it consumes core, never reimplements it.
// Brings the heavy editor to parity with the lean editor's in-client dev features:
// build-and-run, hot-reload, a REPL, a live-log stream, and build-and-debug
// (GraalJS inspector on :9229) - all over the @lb-ide/core bridge (HTTP or WS).
import * as vscode from "vscode";
import * as esbuild from "esbuild-wasm";
import { runBuild, DEFAULT_BUILD } from "@lb-ide/core/build";
import { createBridge } from "@lb-ide/core/bridge";

const BUILD_FILE = "lbbuild.config.json"; // per-project build config (matches the lean editor)
const assetUri = (context, name) => vscode.Uri.joinPath(context.extensionUri, "dist", name);
const dec = new TextDecoder();

let esbuildReady = null;
async function initEsbuild(context) {
  if (!esbuildReady) {
    esbuildReady = (async () => {
      const wasmBytes = await vscode.workspace.fs.readFile(assetUri(context, "esbuild.wasm"));
      await esbuild.initialize({ wasmModule: await WebAssembly.compile(wasmBytes), worker: false });
    })();
  }
  return esbuildReady;
}
async function readAsset(context, name) { return dec.decode(await vscode.workspace.fs.readFile(assetUri(context, name))); }

// Recursively read the workspace's buildable sources into a { relpath → content } map.
async function readWorkspaceFiles(root) {
  const files = {};
  async function walk(dir, prefix) {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const uri = vscode.Uri.joinPath(dir, name);
      const rel = prefix ? prefix + "/" + name : name;
      if (type === vscode.FileType.Directory) { await walk(uri, rel); continue; }
      if (name.endsWith(".d.ts")) continue;            // typings aren't build inputs
      if (/\.(ts|js|json)$/.test(name)) files[rel] = dec.decode(await vscode.workspace.fs.readFile(uri));
    }
  }
  await walk(root, "");
  return files;
}

// The shared ScriptManager bridge (base/token from lb.hostBase/hostToken; lb-fs
// injects the resolved absolute base). Memoized by {base,token} so commands +
// hot-reload reuse ONE connection (a WS bridge opens a socket; a fresh bridge per
// call would leak sockets). null when no host is configured.
let _bridge = null, _bridgeKey = "";
function getBridge() {
  const cfg = vscode.workspace.getConfiguration("lb");
  const base = cfg.get("hostBase", ""), token = cfg.get("hostToken", "");
  if (!base) return null;
  const key = base + "\u0000" + token;
  if (key !== _bridgeKey) { try { _bridge && _bridge.close && _bridge.close(); } catch { /* */ } _bridge = createBridge({ base, token }); _bridgeKey = key; }
  return _bridge;
}
let hotTimer = null;

// Build the workspace to a single .mjs via @lb-ide/core (shared by run/hot-reload/debug).
async function buildWorkspace(context, ch) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) throw new Error("no workspace folder open");
  const [files] = await Promise.all([readWorkspaceFiles(folders[0].uri), initEsbuild(context)]);
  let projCfg = {};
  if (BUILD_FILE in files) { try { projCfg = JSON.parse(files[BUILD_FILE]); } catch (e) { throw new Error(`${BUILD_FILE}: ${e.message}`); } }
  delete files[BUILD_FILE];
  const bcfg = { ...DEFAULT_BUILD, ...projCfg };
  let injectBundle = "";
  if (bcfg.inlineLbInject !== false && Object.values(files).some((c) => /from\s+["']lb-inject["']/.test(c))) injectBundle = await readAsset(context, "lb-inject-bundled.js");
  const built = await runBuild({ esbuild, files, cfg: bcfg, injectBundle });
  ch.appendLine(`built ${built.name} - ${built.code.length} bytes`);
  return built;
}

// Build + load into the client. `debug` loads with the GraalJS inspector.
async function buildAndLoad(context, ch, { debug = false, quiet = false } = {}) {
  let built;
  try { built = await buildWorkspace(context, ch); }
  catch (e) {
    const errs = (e && e.errors) || [];
    if (errs.length) for (const er of errs) ch.appendLine("✗ " + (er.location ? er.location.file + ": " : "") + er.text);
    ch.appendLine("build failed: " + (e && (e.stack || e.message) || e));
    if (!quiet) vscode.window.showErrorMessage("LB build failed: " + (errs.length ? errs[0].text : (e && e.message || e)));
    return;
  }
  const bridge = getBridge();
  if (!bridge) { if (!quiet) vscode.window.showInformationMessage(`LB: built ${built.name} (${built.code.length} bytes; no host configured)`); return; }
  try {
    const res = await bridge.load({ name: built.name.replace(/\.mjs$/, ""), mjs: built.code, debug, userGesture: true });
    ch.appendLine("host load → " + JSON.stringify(res));
    if (!quiet) {
      if (debug && res && res.debugPort) vscode.window.showInformationMessage(`LB: loaded ${built.name} with inspector on :${res.debugPort} — attach via chrome://inspect or a VS Code attach config.`);
      else vscode.window.showInformationMessage(`LB: loaded ${built.name} → ${JSON.stringify(res)}`);
    }
  } catch (e) { ch.appendLine("host load failed: " + (e && e.message || e)); if (!quiet) vscode.window.showErrorMessage("LB load failed: " + (e && e.message || e)); }
}

export function activate(context) {
  const ch = vscode.window.createOutputChannel("LB Glue");
  const logCh = vscode.window.createOutputChannel("LB Logs");
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("lb.buildAndRun", () => buildAndLoad(context, ch));
  reg("lb.buildAndDebug", () => buildAndLoad(context, ch, { debug: true }));

  // Hot-reload: rebuild + reload on save when on (debounced), like the lean editor.
  let hotReload = false;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = "lb.toggleHotReload";
  const renderStatus = () => { status.text = "$(sync) LB hot-reload: " + (hotReload ? "on" : "off"); status.show(); };
  renderStatus();
  context.subscriptions.push(status);
  reg("lb.toggleHotReload", () => { hotReload = !hotReload; if (!hotReload) clearTimeout(hotTimer); renderStatus(); vscode.window.showInformationMessage("LB hot-reload " + (hotReload ? "on" : "off")); });
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
    if (!hotReload || !getBridge()) return;
    clearTimeout(hotTimer);
    hotTimer = setTimeout(() => buildAndLoad(context, ch, { quiet: true }), 600);
  }));

  // REPL: eval a snippet in the client (explicit user action → userGesture).
  reg("lb.repl", async () => {
    const bridge = getBridge();
    if (!bridge) { vscode.window.showErrorMessage("LB REPL: no host configured"); return; }
    const code = await vscode.window.showInputBox({ prompt: "LB REPL — eval in client", placeHolder: "e.g. mc.player?.getName()?.getString()" });
    if (!code) return;
    try { const res = await bridge.repl(code, { userGesture: true }); ch.appendLine("repl> " + code); ch.appendLine("  = " + JSON.stringify(res)); ch.show(true); }
    catch (e) { vscode.window.showErrorMessage("LB REPL failed: " + (e && e.message || e)); }
  });

  // Live log stream: subscribe to the client's log(...) output.
  let unsubLog = null;
  context.subscriptions.push({ dispose: () => { if (unsubLog) unsubLog(); } });
  reg("lb.toggleLogStream", () => {
    if (unsubLog) { unsubLog(); unsubLog = null; logCh.appendLine("[log stream stopped]"); return; }
    const bridge = getBridge();
    if (!bridge || !bridge.subscribeLog) { vscode.window.showErrorMessage("LB logs: no host configured"); return; }
    logCh.show(true);
    unsubLog = bridge.subscribeLog((line) => logCh.appendLine(typeof line === "string" ? line : JSON.stringify(line)));
  });

  // Headless self-test only (off by default): fire buildAndRun once so a probe can observe it.
  if (vscode.workspace.getConfiguration("lb").get("selfTestOnStartup", false)) {
    setTimeout(() => vscode.commands.executeCommand("lb.buildAndRun"), 3000);
  }
}

export function deactivate() {
  clearTimeout(hotTimer);
  try { _bridge && _bridge.close && _bridge.close(); } catch { /* */ }
}
