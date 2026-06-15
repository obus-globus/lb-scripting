// Minimal LB heavy-mode glue extension (web). Proves the seam: a custom web
// extension activates in the packaged vscode-web bundle, registers a command, and
// its command logic runs (observable via a notification). Auto-invokes once on
// activation so a headless probe can confirm the whole path. (Next: wire to
// @lb-ide/core runBuild + bridge.)
const vscode = require("vscode");
function activate(context) {
  const ch = vscode.window.createOutputChannel("LB Glue");
  ch.appendLine("[lb-glue] activated");
  context.subscriptions.push(vscode.commands.registerCommand("lb.buildAndRun", async () => {
    ch.appendLine("[lb-glue] buildAndRun invoked");
    await vscode.window.showInformationMessage("LB-GLUE-OK: build & run reached (stub)");
  }));
  // self-test: invoke once shortly after activation so the harness can observe it
  setTimeout(() => { vscode.commands.executeCommand("lb.buildAndRun"); }, 3000);
}
function deactivate() {}
module.exports = { activate, deactivate };
