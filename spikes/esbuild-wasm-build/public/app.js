// Prove esbuild-wasm can bundle a multi-file LB script project — entirely in the
// browser tab — into one self-contained .mjs:
//  - multiple TS files (entry imports a local helper) inlined into one output
//  - a type-only `@wunk/lb-script-api-types` import erased (no resolution needed)
//  - ambient globals (registerScript/Client) left as free references (runtime-provided)
//  - also bundle a // @ts-check .js entry, to cover both languages
// Publishes window.__build for the headless verifier (verify.mjs).

// A tiny in-memory project. `MARKER` must survive into the bundle (proves the
// helper file was actually inlined, not dropped).
const PROJECT = {
  "/util.ts": `
export const MARKER = "INLINED_UTIL_42";
export function fmt(x: number): string { return "pos=" + x.toFixed(2); }
`,
  "/main.ts": `
/// <reference types="@wunk/lb-script-api-types/ambient" />
import { Vec3 } from "@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3"; // type-only -> erased
import { MARKER, fmt } from "./util";

const script = registerScript({ name: "BuildProbe", version: "0.1.0", authors: ["obus"] });
script.registerModule({ name: "BuildProbe", category: "Misc" }, (mod) => {
  mod.on("playerJump", () => {
    const p = mc.player;
    if (p === null) return;
    const v: Vec3 = p.position();
    Client.displayChatMessage(MARKER + " " + fmt(v.x));
  });
});
`,
  // a plain-JS entry too (LB allows // @ts-check .js with no build, but you can
  // still bundle multi-file JS projects)
  "/main.js": `
// @ts-check
import { MARKER, fmt } from "./util.js";
registerScript({ name: "BuildProbeJs", version: "0.1.0", authors: ["obus"] })
  .registerModule({ name: "BuildProbeJs", category: "Misc" }, (mod) => {
    mod.on("enable", () => Client.displayChatMessage(MARKER + " " + fmt(1.5)));
  });
`,
  "/util.js": `
export const MARKER = "INLINED_UTIL_42";
export function fmt(x) { return "pos=" + x.toFixed(2); }
`,
};

// esbuild plugin: resolve & load from the in-memory PROJECT, treat the types
// package as an empty module (its imports are type-only and get erased anyway).
function vfsPlugin() {
  const dir = (p) => p.slice(0, p.lastIndexOf("/")) || "";
  const join = (base, rel) => {
    const parts = (base + "/" + rel).split("/");
    const out = [];
    for (const seg of parts) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return "/" + out.join("/");
  };
  return {
    name: "vfs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith("@wunk/")) return { path: args.path, namespace: "empty" };
        if (args.kind === "entry-point") return { path: args.path, namespace: "vfs" };
        // relative import from another vfs file
        let p = args.path;
        if (p.startsWith("./") || p.startsWith("../")) p = join(dir(args.importer), p);
        // add extension if missing
        const cands = [p, p + ".ts", p + ".js", p + "/index.ts", p + "/index.js"];
        const hit = cands.find((c) => c in PROJECT);
        return { path: hit || p, namespace: "vfs" };
      });
      build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "vfs" }, (args) => {
        const contents = PROJECT[args.path];
        if (contents == null) return { errors: [{ text: "not in vfs: " + args.path }] };
        return { contents, loader: args.path.endsWith(".js") ? "js" : "ts" };
      });
    },
  };
}

async function bundle(entry) {
  const res = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    plugins: [vfsPlugin()],
    legalComments: "none",
  });
  return res.outputFiles[0].text;
}

(async () => {
  const status = document.getElementById("status");
  try {
    status.textContent = "initializing esbuild-wasm…";
    await esbuild.initialize({ wasmURL: "esbuild.wasm" });
    status.textContent = "bundling…";
    const tsOut = await bundle("/main.ts");
    const jsOut = await bundle("/main.js");
    document.getElementById("out").textContent = "// ---- main.ts bundle ----\n" + tsOut;
    window.__build = { ts: tsOut, js: jsOut, version: esbuild.version, ready: true };
    status.textContent = `done — esbuild ${esbuild.version}; ts ${tsOut.length}B, js ${jsOut.length}B`;
  } catch (e) {
    window.__build = { error: String(e && e.stack || e), ready: true };
    status.textContent = "ERROR: " + e;
  }
})();
