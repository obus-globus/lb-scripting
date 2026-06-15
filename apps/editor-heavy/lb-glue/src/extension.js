// LB heavy-mode glue extension (web). The thin layer wiring VS Code's command/UI
// to the SHARED @lb-ide/core pipeline — it consumes core, never reimplements it.
//
// buildAndRun: read the workspace's script files → run @lb-ide/core's runBuild
// (esbuild-wasm, in-thread under cross-origin isolation) → (next) hand the built
// .mjs to the ScriptManager host bridge. esbuild-wasm is initialized from the
// extension's bundled esbuild.wasm asset via `wasmModule` (no URL fetch, no nested
// worker) so it works inside the isolated vscode-web ext-host worker.
import * as vscode from "vscode";
import * as esbuild from "esbuild-wasm";
import { runBuild, DEFAULT_BUILD } from "@lb-ide/core/build";
import { createBridge } from "@lb-ide/core/bridge";

const BUILD_FILE = "lbbuild.config.json"; // per-project build config (matches the lean editor)

// Runtime assets ship alongside the bundled `dist/extension.js` browser entry.
const assetUri = (context, name) => vscode.Uri.joinPath(context.extensionUri, "dist", name);

let esbuildReady = null;
async function initEsbuild(context) {
  if (!esbuildReady) {
    esbuildReady = (async () => {
      const wasmBytes = await vscode.workspace.fs.readFile(assetUri(context, "esbuild.wasm"));
      const wasmModule = await WebAssembly.compile(wasmBytes);
      await esbuild.initialize({ wasmModule, worker: false });
    })();
  }
  return esbuildReady;
}

const dec = new TextDecoder();
async function readAsset(context, name) {
  return dec.decode(await vscode.workspace.fs.readFile(assetUri(context, name)));
}

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

export function activate(context) {
  const ch = vscode.window.createOutputChannel("LB Glue");
  ch.appendLine("[lb-glue] activated");
  context.subscriptions.push(vscode.commands.registerCommand("lb.buildAndRun", async () => {
    ch.appendLine("[lb-glue] buildAndRun invoked");
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || !folders.length) { vscode.window.showErrorMessage("LB-GLUE: no workspace folder open"); return; }
      const root = folders[0].uri;
      const [files] = await Promise.all([readWorkspaceFiles(root), initEsbuild(context)]);
      // Per-project build config (an editable lbbuild.config.json, like the lean
      // editor) merged over the shared defaults. Pull it out of the build inputs.
      let projCfg = {};
      if (BUILD_FILE in files) { try { projCfg = JSON.parse(files[BUILD_FILE]); } catch (e) { throw new Error(`${BUILD_FILE}: ${e.message}`); } }
      delete files[BUILD_FILE];
      const bcfg = { ...DEFAULT_BUILD, ...projCfg };
      ch.appendLine(`[lb-glue] read ${Object.keys(files).length} files: ${Object.keys(files).join(", ")}`);
      let injectBundle = "";
      if (bcfg.inlineLbInject !== false && Object.values(files).some((c) => /from\s+["']lb-inject["']/.test(c))) injectBundle = await readAsset(context, "lb-inject-bundled.js");
      // runBuild merges DEFAULT_BUILD again and resolves cfg.entry via resolveEntry.
      const built = await runBuild({ esbuild, files, cfg: bcfg, injectBundle });
      ch.appendLine(`[lb-glue] built ${built.name} — ${built.code.length} bytes`);

      // Hand the built .mjs to the in-client ScriptManager host (if configured).
      // Web-only with no live host → base unset → build-only. The bridge is the
      // SAME shared @lb-ide/core client the lean editor uses (token-headered).
      const cfg = vscode.workspace.getConfiguration("lb");
      const base = cfg.get("hostBase", "");
      if (base) {
        const bridge = createBridge({ base, token: cfg.get("hostToken", "") });
        const res = await bridge.load({ name: built.name.replace(/\.mjs$/, ""), mjs: built.code, debug: false });
        ch.appendLine(`[lb-glue] host load → ${JSON.stringify(res)}`);
        vscode.window.showInformationMessage(`LB-GLUE-OK: loaded ${built.name} → host ${JSON.stringify(res)}`);
      } else {
        vscode.window.showInformationMessage(`LB-GLUE-OK: built ${built.name} (${built.code.length} bytes)`);
      }
    } catch (e) {
      // esbuild build failures carry a structured e.errors[] with locations.
      const errs = (e && e.errors) || [];
      if (errs.length) for (const er of errs) ch.appendLine("[lb-glue] ✗ " + (er.location ? er.location.file + ": " : "") + er.text);
      ch.appendLine("[lb-glue] build failed: " + (e && (e.stack || e.message) || e));
      vscode.window.showErrorMessage("LB-GLUE-FAIL: " + (errs.length ? errs[0].text : (e && e.message || e)));
    }
  }));
  // Headless self-test only: when lb.selfTestOnStartup is set, fire the command
  // once after activation so a probe can observe the whole path. Off by default
  // (never auto-builds in a real workspace).
  if (vscode.workspace.getConfiguration("lb").get("selfTestOnStartup", false)) {
    setTimeout(() => { vscode.commands.executeCommand("lb.buildAndRun"); }, 3000);
  }
}

export function deactivate() {}
