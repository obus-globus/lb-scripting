// @lb-ide/core - the esbuild-wasm build plugin (mode-agnostic).
//
// Rewrites the LB script pipeline at build time:
//   - `import { X } from "@wunk/lb-script-api-types/types/<fqcn>"`  →  `Java.type("<fqcn>")`
//     (the JVM value-import → Java.type rewrite; disabled → left external/raw)
//   - any other `@wunk/*` import is types-only → emptied
//   - `import ... from "lb-inject"`  →  the inlined lb-inject runtime (or external)
//   - project files resolved against an in-memory `files` map (vfs)
//
// Pure: no globals. `injectBundle` (the lb-inject runtime source text) is passed in
// so this is identical for the lean (Monaco) and heavy (vscode-web) editors.
//
// @param {Record<string,string>} files   project file map (path → source)
// @param {object} cfg                     build config ({ javaTypeRewrite, inlineLbInject, ... })
// @param {string} [injectBundle]          lb-inject runtime source (required only if inlineLbInject)
// @returns {{name:string, setup:(build:any)=>void}}  an esbuild plugin
export function buildPlugins(files, cfg = {}, injectBundle = "") {
  const dir = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
  const join = (base, rel) => { const parts = (base + "/" + rel).split("/"); const out = []; for (const s of parts) { if (s === "" || s === ".") continue; if (s === "..") out.pop(); else out.push(s); } return out.join("/"); };
  const norm = (p) => p.replace(/^\/+/, "");
  const TYPES = "@wunk/lb-script-api-types/types/";
  const jvmRewrite = cfg.javaTypeRewrite !== false;
  const inlineInject = cfg.inlineLbInject !== false;
  return {
    name: "lb",
    setup(build) {
      // JVM-type value import → Java.type("<fqcn>")  (matches the template build).
      // When disabled in the config, leave the import external (raw).
      if (jvmRewrite) {
        build.onResolve({ filter: /^@wunk\/lb-script-api-types\/types\// }, (a) => ({ path: a.path, namespace: "jvm" }));
        build.onLoad({ filter: /.*/, namespace: "jvm" }, (a) => {
          const fqcn = a.path.slice(TYPES.length).replace(/\//g, "."); const name = fqcn.slice(fqcn.lastIndexOf(".") + 1);
          return { contents: `export const ${name} = Java.type(${JSON.stringify(fqcn)});`, loader: "js" };
        });
      } else build.onResolve({ filter: /^@wunk\/lb-script-api-types\/types\// }, (a) => ({ path: a.path, external: true }));
      // any other @wunk/* import is types-only → empty
      build.onResolve({ filter: /^@wunk\// }, (a) => ({ path: a.path, namespace: "empty" }));
      // lb-inject → inlined runtime + re-export of the global it defines (or external)
      if (inlineInject) {
        build.onResolve({ filter: /^lb-inject$/ }, () => ({ path: "lb-inject", namespace: "lbinject" }));
        build.onLoad({ filter: /.*/, namespace: "lbinject" }, () => ({ contents: "globalThis.__nfLibConsumed = true;\n" + (injectBundle || "") + "\nexport const Inject = globalThis.Inject;", loader: "js" }));
      } else build.onResolve({ filter: /^lb-inject$/ }, (a) => ({ path: a.path, external: true }));
      build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
      // project files
      build.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point") return { path: norm(a.path), namespace: "vfs" };
        let p = a.path; if (p.startsWith("./") || p.startsWith("../")) p = join(dir(a.importer), p); p = norm(p);
        const cands = [p, p + ".ts", p + ".js", p + "/index.ts", p + "/index.js"]; const hit = cands.find((c) => c in files);
        return { path: hit || p, namespace: "vfs" };
      });
      build.onLoad({ filter: /.*/, namespace: "vfs" }, (a) => { const c = files[a.path]; if (c == null) return { errors: [{ text: "not in project: " + a.path }] }; return { contents: c, loader: a.path.endsWith(".js") ? "js" : "ts" }; });
    },
  };
}
