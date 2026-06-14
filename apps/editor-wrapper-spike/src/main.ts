import "@codingame/monaco-vscode-typescript-language-features-default-extension";
import "@codingame/monaco-vscode-typescript-basics-default-extension";
import { MonacoEditorLanguageClientWrapper } from "monaco-editor-wrapper";
import { configureDefaultWorkerFactory } from "monaco-editor-wrapper/workers/workerLoaders";
(window as any).__spikeErr = null;
window.addEventListener("unhandledrejection", (e) => { (window as any).__spikeErr = "unhandled:" + String((e as any).reason?.message || (e as any).reason); });
(async () => {
  try {
    const wrapper = new MonacoEditorLanguageClientWrapper();
    await wrapper.initAndStart({
      $type: "extended",
      htmlContainer: document.getElementById("editor")!,
      vscodeApiConfig: { userConfiguration: { json: JSON.stringify({ "workbench.colorTheme": "Default Dark Modern" }) } },
      editorAppConfig: { codeResources: { modified: { uri: "/workspace/hello.ts", text: "const x: string = 0;\n" } }, monacoWorkerFactory: configureDefaultWorkerFactory },
    });
    (window as any).__spikeReady = true;
  } catch (e: any) { (window as any).__spikeErr = "caught:" + String(e?.message || e); }
})();
