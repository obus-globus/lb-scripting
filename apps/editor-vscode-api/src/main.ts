import * as monaco from "monaco-editor";
import { initialize } from "@codingame/monaco-vscode-api";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getFileServiceOverride, { RegisteredFileSystemProvider, RegisteredMemoryFile, registerFileSystemOverlay } from "@codingame/monaco-vscode-files-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getHostServiceOverride from "@codingame/monaco-vscode-host-service-override";
import getNotificationsServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getLanguageDetectionWorkerServiceOverride from "@codingame/monaco-vscode-language-detection-worker-service-override";
import getOutputServiceOverride from "@codingame/monaco-vscode-output-service-override";
import "@codingame/monaco-vscode-typescript-language-features-default-extension";
import "@codingame/monaco-vscode-typescript-basics-default-extension";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "vscode/localExtensionHost";
// @ts-ignore — ?worker&url gives the bundled worker's URL string (works in the
// extension-host iframe context too, unlike a page-constructed Worker instance)
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker.js?worker&url";
// @ts-ignore
import extHostWorkerUrl from "@codingame/monaco-vscode-api/workers/extensionHost.worker.js?worker&url";
// @ts-ignore
import textMateWorkerUrl from "@codingame/monaco-vscode-textmate-service-override/worker.js?worker&url";
// @ts-ignore
import langDetectWorkerUrl from "@codingame/monaco-vscode-language-detection-worker-service-override/worker.js?worker&url";
// @ts-ignore
import outputWorkerUrl from "@codingame/monaco-vscode-output-service-override/worker.js?worker&url";

const S: any = ((window as any).__spike = { ready: false, err: null, coi: (self as any).crossOriginIsolated });

const workerUrls: Record<string, string> = {
  editorWorkerService: editorWorkerUrl,
  extensionHostWorkerMain: extHostWorkerUrl,
  TextMateWorker: textMateWorkerUrl,
  LanguageDetectionWorker: langDetectWorkerUrl,
  OutputLinkDetectionWorker: outputWorkerUrl,
};
(window as any).MonacoEnvironment = {
  getWorkerUrl(_: unknown, label: string) { return workerUrls[label] || editorWorkerUrl; },
  getWorkerOptions(_: unknown, _label: string) { return { type: "module" }; },
};

(async () => {
  try {
    // register the virtual FS BEFORE init so the workspace folder resolves
    const uri = monaco.Uri.file("/workspace/main.ts");
    const fsp = new RegisteredFileSystemProvider(false);
    fsp.registerFile(new RegisteredMemoryFile(uri, 'const n: number = "type error here";\nconsole.log(n);\n'));
    fsp.registerFile(new RegisteredMemoryFile(monaco.Uri.file("/workspace/tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "es2020", module: "esnext", lib: ["es2021"], strict: true, allowJs: true }, include: ["**/*.ts"] })));
    registerFileSystemOverlay(1, fsp);
    await initialize({
      ...getEnvironmentServiceOverride(),
      ...getLogServiceOverride(),
      ...getExtensionServiceOverride({ enableWorkerExtensionHost: true } as any),
      ...getFileServiceOverride(),
      ...getModelServiceOverride(),
      ...getConfigurationServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getMarkersServiceOverride(),
      ...getStorageServiceOverride(),
      ...getLifecycleServiceOverride(),
      ...getHostServiceOverride(),
      ...getNotificationsServiceOverride(),
      ...getDialogsServiceOverride(),
      ...getOutputServiceOverride(),
      ...getLanguageDetectionWorkerServiceOverride(),
    }, undefined, {
      workspaceProvider: {
        trusted: true,
        workspace: { folderUri: monaco.Uri.file("/workspace") },
        async open() { return false; },
      },
    } as any);
    const ref = await (monaco.editor as any).createModelReference(uri);
    const editor = monaco.editor.create(document.getElementById("editor")!, { model: ref.object.textEditorModel, automaticLayout: true, theme: "Default Dark Modern" });
    S.editor = editor; S.uri = uri.toString();
    S.markers = () => monaco.editor.getModelMarkers({ resource: uri }).map((m: any) => ({ code: m.code, msg: String(m.message).slice(0, 80), sev: m.severity }));
    S.ready = true;
  } catch (e: any) { S.err = String(e?.stack || e?.message || e); }
})();
