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

// Plain-JS variants (LB scripts can be // @ts-check'd .js with no build step).
const GOOD_JS = `// @ts-check
/// <reference types="@wunk/lb-script-api-types/ambient" />
const script = registerScript({ name: "JsProbe", version: "0.1.0", authors: ["obus"] });
const VERBOSE = Setting.boolean({ name: "verbose", default: false });
script.registerModule({ name: "JsProbe", category: "Misc" }, (mod) => {
  mod.on("playerJump", () => {
    const p = mc.player;
    if (p === null) return;
    Client.displayChatMessage("x=" + p.position().x.toFixed(2));
    if (VERBOSE.get()) Client.displayChatMessage("v");
  });
});
`;

const BAD_JS = `// @ts-check
/// <reference types="@wunk/lb-script-api-types/ambient" />
const script = registerScript({ name: "BadJs", version: "0.1.0", authors: ["x"] });
script.registerModule({ name: "BadJs", category: "Misc" }, (mod) => {
  mod.on("playerJump", () => {
    const p = mc.player;
    if (p === null) return;
    p.position().x.toUpperCase();    // number has no toUpperCase
    Client.displayChatMessage(42);   // expects string
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

  // Same typings, but for plain-JS models. javascriptDefaults is a separate
  // config; checkJs makes // @ts-check'd .js files report type errors too.
  const js = monaco.languages.typescript.javascriptDefaults;
  js.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    lib: ["es2023"],
    types: ["@wunk/lb-script-api-types/ambient"],
    allowJs: true,
    checkJs: true,
    skipLibCheck: true,
    allowNonTsExtensions: true,
    noEmit: true,
  });
  js.setExtraLibs(libs);
  js.setEagerModelSync(true);
  setStatus(`registered ${libs.length} typing files — booting editor…`);

  const model = monaco.editor.createModel(GOOD, "typescript", monaco.Uri.parse("file:///main.ts"));
  const editor = monaco.editor.create(document.getElementById("editor"), {
    model,
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 13,
  });

  // getWorker: the TS worker getter handles BOTH .ts and .js models.
  const getWorker = () => monaco.languages.typescript.getTypeScriptWorker();

  // A scratch model we reuse per language; uri extension picks ts vs js routing.
  function scratch(uri) {
    const existing = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (existing) return existing;
    const lang = uri.endsWith(".js") ? "javascript" : "typescript";
    return monaco.editor.createModel("", lang, monaco.Uri.parse(uri));
  }

  // Pull semantic+syntactic diagnostics straight from the worker for a file.
  async function diagnose(m, code) {
    m.setValue(code);
    const worker = await getWorker();
    const client = await worker(m.uri);
    const uri = m.uri.toString();
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
  async function completionsAfter(m, snippet, marker) {
    m.setValue(snippet);
    const idx = snippet.indexOf(marker) + marker.length;
    const pos = m.getPositionAt(idx);
    const worker = await getWorker();
    const client = await worker(m.uri);
    const info = await client.getCompletionsAtPosition(m.uri.toString(), m.getOffsetAt(pos));
    return info ? info.entries.map((e) => e.name) : [];
  }

  document.getElementById("loadGood").onclick = () => model.setValue(GOOD);
  document.getElementById("loadBad").onclick = () => model.setValue(BAD);

  // Run the assertions and publish results for the headless verifier.
  setStatus("running diagnostics…");
  const refLine = `/// <reference types="@wunk/lb-script-api-types/ambient" />\n`;

  // --- TypeScript ---
  const tsModel = scratch("file:///main.ts");
  const goodDiags = await diagnose(tsModel, GOOD);
  const badDiags = await diagnose(tsModel, BAD);
  const mcCompletions = await completionsAfter(tsModel, refLine + "mc.", "mc.");

  // --- JavaScript (// @ts-check) ---
  const jsModel = scratch("file:///probe.js");
  const goodJsDiags = await diagnose(jsModel, GOOD_JS);
  const badJsDiags = await diagnose(jsModel, BAD_JS);
  const mcJsCompletions = await completionsAfter(jsModel, "// @ts-check\n" + refLine + "mc.", "mc.");

  model.setValue(GOOD);

  window.__spike = {
    libCount: libs.length,
    ts: { good: goodDiags, bad: badDiags, mcCount: mcCompletions.length, mcSample: mcCompletions.slice(0, 8) },
    js: { good: goodJsDiags, bad: badJsDiags, mcCount: mcJsCompletions.length, mcSample: mcJsCompletions.slice(0, 8) },
    ready: true,
  };
  setStatus(
    `done — TS good:${goodDiags.length}/bad:${badDiags.length}/mc:${mcCompletions.length}  ` +
      `JS good:${goodJsDiags.length}/bad:${badJsDiags.length}/mc:${mcJsCompletions.length}`,
  );
});
