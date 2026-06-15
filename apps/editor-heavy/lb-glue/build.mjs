// Bundle the LB glue web extension: src/extension.js (+ the @lb-ide/core pipeline
// and esbuild-wasm browser API) → dist/extension.js, and stage the runtime assets
// the extension reads at load time (esbuild.wasm, lb-inject-bundled.js). Web
// extensions must ship a single bundled `browser` entry; `vscode` stays external
// (the ext-host provides it). Run: `node build.mjs`.
import { build } from "../../host/node_modules/esbuild/lib/main.js";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(here, "src/extension.js")],
  outfile: join(dist, "extension.js"),
  bundle: true, format: "cjs", platform: "browser", target: "es2022",
  external: ["vscode"], legalComments: "none",
  // Resolve the workspace deps explicitly (they live outside lb-glue's node_modules):
  // @lb-ide/core's pipeline + esbuild-wasm's browser API (bundled into the worker).
  alias: {
    "@lb-ide/core/build": join(repo, "packages/lb-ide-core/src/build.js"),
    "esbuild-wasm": join(repo, "apps/editor/node_modules/esbuild-wasm/esm/browser.js"),
  },
});

// esbuild-wasm browser build picks the browser worker, but the extension feeds the
// .wasm bytes itself (wasmModule) — stage the binary + the lb-inject runtime.
const editorPub = join(repo, "apps/editor/node_modules/esbuild-wasm/esbuild.wasm");
cpSync(editorPub, join(dist, "esbuild.wasm"));
cpSync(join(repo, "apps/editor/public/lb-inject-bundled.js"), join(dist, "lb-inject-bundled.js"));
console.log("built dist/extension.js + staged esbuild.wasm, lb-inject-bundled.js");
