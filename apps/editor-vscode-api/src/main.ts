import * as monaco from "monaco-editor";
import * as vscode from "vscode";
import { initialize } from "@codingame/monaco-vscode-api";
import getFileServiceOverride, { RegisteredFileSystemProvider, RegisteredMemoryFile, registerFileSystemOverlay } from "@codingame/monaco-vscode-files-service-override";
// --- the demo's known-good override set (terminal/chat/localization/remote omitted: heavy local setup, unrelated to TS activation) ---
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getNotificationServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getDebugServiceOverride from "@codingame/monaco-vscode-debug-service-override";
import getPreferencesServiceOverride from "@codingame/monaco-vscode-preferences-service-override";
import getOutlineServiceOverride from "@codingame/monaco-vscode-outline-service-override";
import getTimelineServiceOverride from "@codingame/monaco-vscode-timeline-service-override";
import getBannerServiceOverride from "@codingame/monaco-vscode-view-banner-service-override";
import getStatusBarServiceOverride from "@codingame/monaco-vscode-view-status-bar-service-override";
import getTitleBarServiceOverride from "@codingame/monaco-vscode-view-title-bar-service-override";
import getSnippetServiceOverride from "@codingame/monaco-vscode-snippets-service-override";
import getOutputServiceOverride from "@codingame/monaco-vscode-output-service-override";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getAccessibilityServiceOverride from "@codingame/monaco-vscode-accessibility-service-override";
import getLanguageDetectionWorkerServiceOverride from "@codingame/monaco-vscode-language-detection-worker-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getWorkspaceTrustOverride from "@codingame/monaco-vscode-workspace-trust-service-override";
import getWorkingCopyServiceOverride from "@codingame/monaco-vscode-working-copy-service-override";
import getScmServiceOverride from "@codingame/monaco-vscode-scm-service-override";
import getTestingServiceOverride from "@codingame/monaco-vscode-testing-service-override";
import getNotebookServiceOverride from "@codingame/monaco-vscode-notebook-service-override";
import getWelcomeServiceOverride from "@codingame/monaco-vscode-welcome-service-override";
import getWalkThroughServiceOverride from "@codingame/monaco-vscode-walkthrough-service-override";
import getUserDataProfileServiceOverride from "@codingame/monaco-vscode-user-data-profile-service-override";
import getUserDataSyncServiceOverride from "@codingame/monaco-vscode-user-data-sync-service-override";
import getAiServiceOverride from "@codingame/monaco-vscode-ai-service-override";
import getTaskServiceOverride from "@codingame/monaco-vscode-task-service-override";
import getCommentsServiceOverride from "@codingame/monaco-vscode-comments-service-override";
import getEmmetServiceOverride from "@codingame/monaco-vscode-emmet-service-override";
import getInteractiveServiceOverride from "@codingame/monaco-vscode-interactive-service-override";
import getIssueServiceOverride from "@codingame/monaco-vscode-issue-service-override";
import getMultiDiffEditorServiceOverride from "@codingame/monaco-vscode-multi-diff-editor-service-override";
import getPerformanceServiceOverride from "@codingame/monaco-vscode-performance-service-override";
import getRelauncherServiceOverride from "@codingame/monaco-vscode-relauncher-service-override";
import getShareServiceOverride from "@codingame/monaco-vscode-share-service-override";
import getSurveyServiceOverride from "@codingame/monaco-vscode-survey-service-override";
import getUpdateServiceOverride from "@codingame/monaco-vscode-update-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getTreeSitterServiceOverride from "@codingame/monaco-vscode-treesitter-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getViewsServiceOverride from "@codingame/monaco-vscode-views-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
// extensions
import "@codingame/monaco-vscode-typescript-language-features-default-extension";
import "@codingame/monaco-vscode-typescript-basics-default-extension";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "vscode/localExtensionHost";
// workers (?worker&url → URL string; works in the ext-host iframe context)
// @ts-ignore
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker.js?worker&url";
// @ts-ignore
import extHostWorkerUrl from "@codingame/monaco-vscode-api/workers/extensionHost.worker.js?worker&url";
// @ts-ignore
import textMateWorkerUrl from "@codingame/monaco-vscode-textmate-service-override/worker.js?worker&url";
// @ts-ignore
import langDetectWorkerUrl from "@codingame/monaco-vscode-language-detection-worker-service-override/worker.js?worker&url";
// @ts-ignore
import outputWorkerUrl from "@codingame/monaco-vscode-output-service-override/worker.js?worker&url";
// @ts-ignore
import notebookWorkerUrl from "@codingame/monaco-vscode-notebook-service-override/worker.js?worker&url";
// @ts-ignore
import searchWorkerUrl from "@codingame/monaco-vscode-search-service-override/worker.js?worker&url";

const S: any = ((window as any).__spike = { ready: false, err: null, coi: (self as any).crossOriginIsolated, activated: false });

const workerUrls: Record<string, string> = {
  editorWorkerService: editorWorkerUrl,
  extensionHostWorkerMain: extHostWorkerUrl,
  TextMateWorker: textMateWorkerUrl,
  LanguageDetectionWorker: langDetectWorkerUrl,
  OutputLinkDetectionWorker: outputWorkerUrl,
  NotebookEditorWorker: notebookWorkerUrl,
  LocalFileSearchWorker: searchWorkerUrl,
};
(window as any).MonacoEnvironment = {
  getWorkerUrl(_: unknown, label: string) { return workerUrls[label] || editorWorkerUrl; },
  getWorkerOptions(_: unknown, _label: string) { return { type: "module" }; },
};

(async () => {
  try {
    const wsUri = monaco.Uri.file("/workspace");
    const uri = monaco.Uri.file("/workspace/main.ts");
    const fsp = new RegisteredFileSystemProvider(false);
    fsp.registerFile(new RegisteredMemoryFile(uri, 'const n: number = "type error here";\nconsole.log(n);\n'));
    fsp.registerFile(new RegisteredMemoryFile(monaco.Uri.file("/workspace/tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "es2020", module: "esnext", lib: ["es2021"], strict: true, allowJs: true }, include: ["**/*.ts"] })));
    registerFileSystemOverlay(1, fsp);

    await initialize({
      ...getLogServiceOverride(),
      ...getExtensionServiceOverride({ enableWorkerExtensionHost: true } as any),
      ...getFileServiceOverride(),
      ...getModelServiceOverride(),
      ...getNotificationServiceOverride(),
      ...getDialogsServiceOverride(),
      ...getConfigurationServiceOverride(),
      ...getKeybindingsServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getTreeSitterServiceOverride(),
      ...getThemeServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getDebugServiceOverride(),
      ...getPreferencesServiceOverride(),
      ...getOutlineServiceOverride(),
      ...getTimelineServiceOverride(),
      ...getBannerServiceOverride(),
      ...getStatusBarServiceOverride(),
      ...getTitleBarServiceOverride(),
      ...getSnippetServiceOverride(),
      ...getOutputServiceOverride(),
      ...getSearchServiceOverride(),
      ...getMarkersServiceOverride(),
      ...getAccessibilityServiceOverride(),
      ...getLanguageDetectionWorkerServiceOverride(),
      ...getStorageServiceOverride(),
      ...getLifecycleServiceOverride(),
      ...getEnvironmentServiceOverride(),
      ...getWorkspaceTrustOverride(),
      ...getWorkingCopyServiceOverride(),
      ...getScmServiceOverride(),
      ...getTestingServiceOverride(),
      ...getNotebookServiceOverride(),
      ...getWelcomeServiceOverride(),
      ...getWalkThroughServiceOverride(),
      ...getUserDataProfileServiceOverride(),
      ...getUserDataSyncServiceOverride(),
      ...getAiServiceOverride(),
      ...getTaskServiceOverride(),
      ...getCommentsServiceOverride(),
      ...getEmmetServiceOverride(),
      ...getInteractiveServiceOverride(),
      ...getIssueServiceOverride(),
      ...getMultiDiffEditorServiceOverride(),
      ...getPerformanceServiceOverride(),
      ...getRelauncherServiceOverride(),
      ...getShareServiceOverride(),
      ...getSurveyServiceOverride(),
      ...getUpdateServiceOverride(),
      ...getExplorerServiceOverride(),
      ...getViewsServiceOverride(),
      ...getQuickAccessServiceOverride(),
    }, undefined, {
      workspaceProvider: { trusted: true, workspace: { folderUri: wsUri }, async open() { return false; } },
    } as any);
    S.ready = true;

    // open the document THROUGH the vscode API so onLanguage:typescript activation fires
    const doc = await vscode.workspace.openTextDocument(uri);
    S.opened = doc.languageId;
    try { await vscode.window.showTextDocument(doc); } catch { /* no workbench editor pane — opening is enough to activate */ }

    S.markers = () => monaco.editor.getModelMarkers({ resource: uri }).map((m: any) => ({ code: m.code, msg: String(m.message).slice(0, 80) }));
    S.exts = vscode.extensions.all.map((e:any)=>e.id).filter((id:string)=>/typescript|tsserver|builtin/i.test(id)).slice(0,10);
    S.extCount = vscode.extensions.all.length;
    S.tsExt = (()=>{const e=vscode.extensions.getExtension("vscode.typescript-language-features") as any; return e?{isActive:e.isActive}:"not-found";})();
  } catch (e: any) { S.err = String(e?.stack || e?.message || e).slice(0, 400); }
})();
