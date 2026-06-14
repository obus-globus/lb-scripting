// Boot Monaco, feed it the lb-script-api-types closure, and prove:
//  - ambient globals (registerScript, Setting, Client, mc) type-check
//  - an importable JVM-path module (@wunk/.../types/.../Vec3) resolves
//  - diagnostics actually fire on bad code
// Exposes window.__spike for the headless verifier (verify.mjs).

// Workers in the AMD/min build resolve sub-modules relative to themselves, which
// breaks under a plain script tag — give them an absolute baseUrl.
self.MonacoEnvironment = {
  getWorkerUrl: function () {
    return (
      "data:text/javascript;charset=utf-8," +
      encodeURIComponent(
        `self.MonacoEnvironment = { baseUrl: '${location.origin}/' };\n` +
          `importScripts('${location.origin}/vs/base/worker/workerMain.js');`,
      )
    );
  },
};

require.config({ paths: { vs: "vs" } });

const GOOD = `/// <reference types="@wunk/lb-script-api-types/ambient" />
import { Vec3 } from "@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3";

const script = registerScript({ name: "SpikeProbe", version: "0.1.0", authors: ["obus"] });
const VERBOSE = Setting.boolean({ name: "verbose", default: false });

script.registerModule(
  { name: "SpikeProbe", category: "Misc", description: "probe" },
  (mod) => {
    mod.on("playerJump", () => {
      const p = mc.player;
      if (p === null) return;
      const pos: Vec3 = p.position();
      Client.displayChatMessage(\`x=\${pos.x.toFixed(2)}\`);
      if (VERBOSE.get()) Client.displayChatMessage("verbose");
    });
  },
);
`;

const BAD = `/// <reference types="@wunk/lb-script-api-types/ambient" />
import { Vec3 } from "@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3";

const script = registerScript({ name: "Bad", version: "0.1.0", authors: ["x"] });
script.registerModule({ name: "Bad", category: "Misc" }, (mod) => {
  mod.on("playerJump", () => {
    const p = mc.player;
    if (p === null) return;
    const pos: Vec3 = p.position();
    pos.x.toUpperCase();            // number has no toUpperCase
    Client.displayChatMessage(42);  // expects string
    mod.on("totallyNotAnEvent", () => {}); // not a real event
  });
});
`;

const setStatus = (s) => (document.getElementById("status").textContent = s);

require(["vs/editor/editor.main"], async () => {
  const ts = monaco.languages.typescript.typescriptDefaults;
  ts.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    lib: ["es2023"],
    types: ["@wunk/lb-script-api-types/ambient"],
    strict: true,
    skipLibCheck: true,
    allowNonTsExtensions: true,
    noEmit: true,
  });
  ts.setEagerModelSync(true);

  // Load the precomputed closure and register every file under file:///<path>.
  setStatus("fetching typings bundle…");
  const bundle = await fetch("typings-bundle.json").then((r) => r.json());
  const libs = Object.entries(bundle).map(([p, content]) => ({
    content,
    filePath: "file:///" + p,
  }));
  ts.setExtraLibs(libs);
  setStatus(`registered ${libs.length} typing files — booting editor…`);

  const model = monaco.editor.createModel(GOOD, "typescript", monaco.Uri.parse("file:///main.ts"));
  const editor = monaco.editor.create(document.getElementById("editor"), {
    model,
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 13,
  });

  // Pull semantic+syntactic diagnostics straight from the worker for a file.
  async function diagnose(code) {
    model.setValue(code);
    const worker = await monaco.languages.typescript.getTypeScriptWorker();
    const client = await worker(model.uri);
    const uri = model.uri.toString();
    const [syn, sem] = await Promise.all([
      client.getSyntacticDiagnostics(uri),
      client.getSemanticDiagnostics(uri),
    ]);
    return [...syn, ...sem].map((d) => ({
      code: d.code,
      message: typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
    }));
  }

  // Completions at a position (to prove ambient-global autocomplete works).
  async function completionsAfter(snippet, marker) {
    model.setValue(snippet);
    const idx = snippet.indexOf(marker) + marker.length;
    const pos = model.getPositionAt(idx);
    const worker = await monaco.languages.typescript.getTypeScriptWorker();
    const client = await worker(model.uri);
    const info = await client.getCompletionsAtPosition(model.uri.toString(), model.getOffsetAt(pos));
    return info ? info.entries.map((e) => e.name) : [];
  }

  document.getElementById("loadGood").onclick = () => model.setValue(GOOD);
  document.getElementById("loadBad").onclick = () => model.setValue(BAD);

  // Run the assertions and publish results for the headless verifier.
  setStatus("running diagnostics…");
  const goodDiags = await diagnose(GOOD);
  const badDiags = await diagnose(BAD);
  // autocomplete on `mc.` — ambient global should yield members
  const mcCompletions = await completionsAfter(
    `/// <reference types="@wunk/lb-script-api-types/ambient" />\nmc.`,
    "mc.",
  );
  model.setValue(GOOD);

  window.__spike = {
    libCount: libs.length,
    good: goodDiags,
    bad: badDiags,
    mcCompletionCount: mcCompletions.length,
    mcSample: mcCompletions.slice(0, 12),
    ready: true,
  };
  setStatus(
    `done — good: ${goodDiags.length} errors, bad: ${badDiags.length} errors, mc.* completions: ${mcCompletions.length}`,
  );
});
