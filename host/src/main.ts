/// <reference types="@wunk/lb-script-api-types/ambient" />
//
// lb-ide-host — opens the LB Script IDE inside the client (CEF) and loads the
// scripts you build there straight into LiquidBounce.
//
//   .ide            open the editor in-game
//   .ide close      close it
//   .ide where      print where the editor build + scripts live
//
// Setup: drop the editor build into  <LB config root>/lb-ide-editor/
// (copy the app/dist contents there — see host/README.md). Then `.ide`.

import { openEditorScreen, closeEditorScreen } from "./cef";
import { startServer } from "./server";
import { scriptsRoot, unloadByName } from "./scriptLoader";

const PORT = 8791;                       // localhost only
const EDITOR_DIR = "lb-ide-editor";      // <LB root>/lb-ide-editor/
const BASE_URL = `http://127.0.0.1:${PORT}/`;

const script = registerScript({ name: "lb-ide-host", version: "0.1.0", authors: ["Obus"] });

// Settings (shown under the ScriptIDE module; also bind the module to a key in
// the ClickGUI to open the editor with that key).
const OPACITY = Setting.int({ name: "opacity", default: 100, range: [20, 100], suffix: "%" });
const BLUR = Setting.boolean({ name: "blur", default: true });

let serverUp = false;

function ensureServer(): boolean {
  if (!serverUp) serverUp = startServer({ port: PORT, editorDirName: EDITOR_DIR, onClose: () => closeEditorScreen() });
  return serverUp;
}
function openIde(): void {
  if (!ensureServer()) { Client.displayChatMessage("§c[ScriptIDE] could not start the local server."); return; }
  const url = BASE_URL + "?opacity=" + OPACITY.get();
  if (!openEditorScreen(url, BLUR.get())) Client.displayChatMessage("§c[ScriptIDE] could not open the CEF editor (LB browser backend unavailable).");
}

script.registerModule(
  { name: "ScriptIDE", category: "Misc", description: "Open the LB Script IDE in-game — bind a key to open, or use .ide." },
  (mod) => {
    mod.on("enable", () => {
      openIde();
      // momentary: opening the screen is the action, not a persistent toggle
      try { (mod as unknown as { enabled: boolean }).enabled = false; } catch { /* */ }
    });
  },
);

// registerCommand is typed to GraalVM's `Value`; pass a plain object via a loose
// cast (the same shape lb-nodeflow uses).
(script as unknown as { registerCommand(cmd: Record<string, unknown>): void }).registerCommand({
  name: "ide",
  aliases: ["scriptide"],
  parameters: [
    { name: "action", required: false, getCompletions: () => ["open", "close", "where", "unload"] },
    { name: "name", required: false, getCompletions: () => [] },
  ],
  onExecute: (action?: string, name?: string) => {
    const a = (action || "open").toLowerCase();
    if (a === "close") { closeEditorScreen(); return; }
    if (a === "unload") {
      if (!name) { Client.displayChatMessage("§c[ScriptIDE] usage: .ide unload <script.mjs>"); return; }
      Client.displayChatMessage(unloadByName(name) ? "§a[ScriptIDE] unloaded " + name : "§c[ScriptIDE] no loaded script named " + name);
      return;
    }
    if (a === "where") {
      Client.displayChatMessage("§b[ScriptIDE] editor dir: §f<LB root>/" + EDITOR_DIR + "/");
      Client.displayChatMessage("§b[ScriptIDE] scripts dir: §f" + (scriptsRoot() ?? "?"));
      Client.displayChatMessage("§b[ScriptIDE] server: §f" + BASE_URL + (serverUp ? " §a(up)" : " §c(down)"));
      return;
    }
    openIde();
  },
});
