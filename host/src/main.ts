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
import { scriptsRoot } from "./scriptLoader";

const PORT = 8791;                       // localhost only
const EDITOR_DIR = "lb-ide-editor";      // <LB root>/lb-ide-editor/
const EDITOR_URL = `http://127.0.0.1:${PORT}/`;

const script = registerScript({ name: "lb-ide-host", version: "0.1.0", authors: ["Obus"] });

let serverUp = false;

script.registerModule(
  { name: "ScriptIDE", category: "Misc", description: "Open the LB Script IDE in-game (.ide)." },
  (mod) => {
    mod.on("enable", () => {
      if (!serverUp) serverUp = startServer({ port: PORT, editorDirName: EDITOR_DIR, onClose: () => closeEditorScreen() });
      if (!openEditorScreen(EDITOR_URL)) Client.displayChatMessage("§c[ScriptIDE] could not open the CEF editor (LB browser backend unavailable).");
      // a module toggle is momentary here — opening the screen is the action
      try { (mod as unknown as { enabled: boolean }).enabled = false; } catch { /* */ }
    });
  },
);

// registerCommand is typed to GraalVM's `Value`; pass a plain object via a loose
// cast (the same shape lb-nodeflow uses).
(script as unknown as { registerCommand(cmd: Record<string, unknown>): void }).registerCommand({
  name: "ide",
  aliases: ["scriptide"],
  parameters: [{ name: "action", required: false, getCompletions: () => ["open", "close", "where"] }],
  onExecute: (action?: string) => {
    const a = (action || "open").toLowerCase();
    if (a === "close") { closeEditorScreen(); return; }
    if (a === "where") {
      Client.displayChatMessage("§b[ScriptIDE] editor dir: §f<LB root>/" + EDITOR_DIR + "/");
      Client.displayChatMessage("§b[ScriptIDE] scripts dir: §f" + (scriptsRoot() ?? "?"));
      Client.displayChatMessage("§b[ScriptIDE] server: §f" + EDITOR_URL + (serverUp ? " §a(up)" : " §c(down)"));
      return;
    }
    if (!serverUp) serverUp = startServer({ port: PORT, editorDirName: EDITOR_DIR, onClose: () => closeEditorScreen() });
    if (!serverUp) { Client.displayChatMessage("§c[ScriptIDE] could not start the local server."); return; }
    if (!openEditorScreen(EDITOR_URL)) Client.displayChatMessage("§c[ScriptIDE] could not open the CEF editor (LB browser backend unavailable).");
  },
});
