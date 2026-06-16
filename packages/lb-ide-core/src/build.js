// @lb-ide/core - esbuild-wasm build orchestration (mode-agnostic, pure).
//
// Runs the in-browser esbuild bundle for an LB script project and returns the
// built `.mjs`. The caller supplies the esbuild instance (the lean editor uses
// the global `esbuild` from esbuild.js; the heavy editor imports esbuild-wasm),
// the project files, the merged build config, the entry point, and the lb-inject
// runtime source. UI concerns (status, logging, download wiring) stay in the host.
import { buildPlugins } from "./build-plugin.js";

// Default per-project build config (an editable lbbuild.config.json overrides it).
export const DEFAULT_BUILD = {
  entry: "",                 // "" → auto-detect (main.ts / main.js)
  format: "esm",             // esm | iife | cjs
  target: "es2022",          // es2017 … es2022 | esnext
  minify: false,
  sourcemap: false,          // false | true → INLINE. external/linked are coerced to inline:
                             // runBuild uses write:false (no output path), and esbuild rejects
                             // an external map there + a separate .map would be lost on load.
                             // Build-and-Debug forces inline regardless (so TS breakpoints bind).
  keepNames: false,
  treeShaking: true,
  charset: "utf8",           // utf8 | ascii
  define: {},                // { "FLAG": "true" }  (values are raw JS)
  drop: [],                  // ["console","debugger"]
  pure: [],                  // functions safe to drop if unused
  banner: "",                // prepended to the output
  footer: "",                // appended to the output
  javaTypeRewrite: true,     // @wunk/.../types/* value import → Java.type("…")
  inlineLbInject: true,      // inline the lb-inject runtime (else leave external)
};

/** Pick the entry point: explicit cfg.entry if present in files, else main.ts/main.js, else first file. */
export function resolveEntry(files, cfg = {}) {
  if (cfg.entry && cfg.entry in files) return cfg.entry;
  return "main.ts" in files ? "main.ts" : "main.js" in files ? "main.js" : Object.keys(files)[0];
}

/**
 * Bundle a project to a single `.mjs`.
 * @param {{esbuild:any, files:Record<string,string>, cfg?:object, entry?:string, injectBundle?:string, debug?:boolean}} o
 *   debug: force an inline source map (TS→.mjs) so a client-side inspector binds breakpoints to source.
 * @returns {Promise<{name:string, code:string, warnings:any[]}>}
 */
export async function runBuild({ esbuild, files, cfg = {}, entry, injectBundle = "", debug = false }) {
  const c = { ...DEFAULT_BUILD, ...cfg };
  const ep = entry || resolveEntry(files, c);
  // Only INLINE source maps survive our write:false, single-artifact load path: esbuild
  // rejects "external"/"linked" with no output path, and a standalone .map would be dropped
  // (the load path ships one .mjs string). So any sourcemap request — and always for debug —
  // becomes inline, keeping the map embedded so TS breakpoints can bind in the client.
  const sourcemap = (debug || c.sourcemap) ? "inline" : false;
  const res = await esbuild.build({
    entryPoints: [ep], bundle: true, write: false, legalComments: "none",
    format: c.format || "esm", target: c.target || "es2022", minify: !!c.minify,
    sourcemap, keepNames: !!c.keepNames, treeShaking: c.treeShaking !== false,
    charset: c.charset || "utf8", define: c.define || {}, drop: c.drop || [], pure: c.pure || [],
    banner: c.banner ? { js: c.banner } : undefined, footer: c.footer ? { js: c.footer } : undefined,
    plugins: [buildPlugins(files, c, injectBundle)],
  });
  const outJs = res.outputFiles.find((f) => !f.path.endsWith(".map")) || res.outputFiles[0];
  return { name: ep.replace(/\.(ts|js)$/, "") + ".mjs", code: outJs.text, warnings: res.warnings };
}
