// Build a LiquidBounce script project: src/ -> dist/, with real bundling.
//
// Each *entry script* (any src file that calls `registerScript`) is bundled by
// esbuild into a single self-contained `.mjs`: its local `./...` imports are
// inlined, so you can split a script across as many files as you like. Files
// that don't call `registerScript` are treated as shared modules — they're
// inlined into the entries that import them and never emitted on their own.
//
// Two esbuild plugins preserve the project's conventions:
//   • JVM-type imports —
//       import { Mth } from "@wunk/lb-script-api-types/types/net/minecraft/util/Mth"
//     becomes  const Mth = Java.type("net.minecraft.util.Mth")  (GraalJS).
//   • the lb-inject import —
//       import { Inject } from "lb-inject"
//     binds to the global the loader defines, and marks the entry so the loader
//     (or, with --bundle, the whole library) gets prepended.
//
// Usage:
//   node scripts/build.mjs            # one-shot build
//   node scripts/build.mjs --bundle   # also emit <name>.bundled.mjs (library inlined)
//   node scripts/build.mjs --watch    # rebuild on change

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, watch, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const srcRoot = join(projectRoot, "src");
const outRoot = join(projectRoot, "dist");

// `--bundle`: in addition to each `<name>.mjs`, emit a single-file
// `<name>.bundled.mjs` with the lb-inject library prepended, so the script can
// be deployed on its own (the library's agent jars still self-extract to
// scripts/lib/nf-inject-<ver>/ on first run — a JVM agent must be a real file).
const BUNDLE = process.argv.includes("--bundle");
const LIB_BUNDLE = join(projectRoot, "vendor", "lib", "nf-inject-bundled-1.1.0.js");
// Single source of truth for the lb-inject version: the vendored bundle's name.
const LIB_VERSION = (/nf-inject-bundled-([\d.]+)\.js$/.exec(LIB_BUNDLE) || [, "1.1.0"])[1];

const TYPES_PREFIX = "@wunk/lb-script-api-types/types/";

// The body of the virtual `lb-inject` module. esbuild inlines this wherever a
// script does `import { Inject } from "lb-inject"`, so the library is wired in
// by the import itself — no separate prepend step. `--bundle` decides what the
// module *is*:
//   • default → a loader that finds + load()s the library from scripts/lib/ at
//     runtime (side-by-side deploy: ship the script + the library file).
//   • --bundle → the whole self-extracting library, inlined (single-file deploy).
// Either way it ends by re-exporting the global the library defines. The guard
// reads `globalThis.Inject` (not the module-scoped `Inject` const, which is in
// its TDZ here).
function lbInjectModuleBody() {
    const tail = "\nexport const Inject = globalThis.Inject;\n";
    if (BUNDLE) {
        return "globalThis.__nfLibConsumed = true;\n" + readFileSync(LIB_BUNDLE, "utf8") + tail;
    }
    return `globalThis.__nfLibConsumed = true;
(function () {
    if (typeof globalThis.Inject !== "undefined") return;
    var Files = Java.type("java.nio.file.Files");
    var Paths = Java.type("java.nio.file.Paths");
    var root = "" + Client.configSystem.rootFolder.getAbsolutePath();
    var names = ["nf-inject-${LIB_VERSION}.js", "nf-inject-bundled-${LIB_VERSION}.js"];
    for (var i = 0; i < names.length; i++) {
        var inLib = Paths.get(root, "scripts", "lib", names[i]);
        if (Files.exists(inLib)) { load(inLib.toString()); return; }
    }
    for (var j = 0; j < names.length; j++) {
        var inScripts = Paths.get(root, "scripts", names[j]);
        if (Files.exists(inScripts)) { load(inScripts.toString()); return; }
    }
    throw new Error("lb-inject ${LIB_VERSION} not found in scripts/lib/ or scripts/ — see README.");
})();${tail}`;
}

// esbuild plugin: rewrite `@wunk/lb-script-api-types/types/<fqcn>` value imports
// into `Java.type("<fqcn>")`. The named import must match the terminal path
// segment (the class name) — the documented convention.
function jvmTypePlugin(state) {
    return {
        name: "jvm-types",
        setup(build) {
            build.onResolve({ filter: /^@wunk\/lb-script-api-types\/types\// }, (args) => ({
                path: args.path,
                namespace: "jvm-type",
            }));
            build.onLoad({ filter: /.*/, namespace: "jvm-type" }, (args) => {
                const fqcn = args.path.slice(TYPES_PREFIX.length).replace(/\//g, ".");
                const name = fqcn.slice(fqcn.lastIndexOf(".") + 1);
                state.jvm++;
                return { contents: `export const ${name} = Java.type(${JSON.stringify(fqcn)});`, loader: "js" };
            });
        },
    };
}

// esbuild plugin: resolve `import { Inject } from "lb-inject"` to the virtual
// module above, so the loader/library is bundled in by the import itself.
function lbInjectPlugin(state) {
    return {
        name: "lb-inject",
        setup(build) {
            build.onResolve({ filter: /^lb-inject$/ }, () => ({ path: "lb-inject", namespace: "lb-inject" }));
            build.onLoad({ filter: /.*/, namespace: "lb-inject" }, () => {
                state.used = true;
                return { contents: lbInjectModuleBody(), loader: "js" };
            });
        },
    };
}

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if ((entry.endsWith(".ts") && !entry.endsWith(".d.ts")) || entry.endsWith(".js")) out.push(full);
    }
    return out;
}

// An entry is a loadable LiquidBounce script — it registers itself. Everything
// else is a shared module (bundled into entries that import it).
function isEntry(absPath) {
    return /\bregisterScript\b/.test(readFileSync(absPath, "utf8"));
}

async function buildEntry(absPath) {
    const rel = relative(srcRoot, absPath);
    const state = { used: false, jvm: 0 };
    let result;
    try {
        result = await esbuild.build({
            entryPoints: [absPath],
            bundle: true,
            format: "esm",
            target: "es2022",
            platform: "neutral",
            sourcemap: "inline",
            sourcesContent: true,
            logLevel: "silent",
            write: false,
            absWorkingDir: projectRoot,
            plugins: [jvmTypePlugin(state), lbInjectPlugin(state)],
        });
    } catch (e) {
        for (const m of e.errors ?? []) console.error(`[${rel}] ${m.text}${m.location ? ` (${m.location.file}:${m.location.line})` : ""}`);
        throw new Error(`esbuild failed for ${rel}`);
    }
    for (const w of result.warnings) console.warn(`[${rel}] ${w.text}`);
    const out = result.outputFiles[0].text;

    const outRel = rel.replace(/\.(ts|js)$/, ".mjs");
    const outPath = join(outRoot, outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, out, "utf8");
    const libNote = state.used ? (BUNDLE ? " (+ lb-inject library inlined)" : " (+ lb-inject loader)") : "";
    const jvmNote = state.jvm ? `, ${state.jvm} JVM type${state.jvm > 1 ? "s" : ""}` : "";
    console.log(`  ${rel} -> dist/${outRel}${libNote}${jvmNote}`);
}

async function buildAll() {
    try { rmSync(outRoot, { recursive: true, force: true }); } catch { /* fine */ }
    const all = walk(srcRoot);
    const entries = all.filter(isEntry);
    const shared = all.length - entries.length;
    if (entries.length === 0) {
        console.warn("No entry scripts found — an entry must call registerScript(). Shared modules are bundled into entries.");
        return;
    }
    const start = Date.now();
    for (const f of entries) await buildEntry(f);
    console.log(`Built ${entries.length} script(s)${shared ? ` (${shared} shared module(s) inlined)` : ""} in ${Date.now() - start}ms`);
}

await buildAll();

if (process.argv.includes("--watch")) {
    console.log(`Watching ${srcRoot} for changes…`);
    let pending = null;
    watch(srcRoot, { recursive: true }, (_evt, filename) => {
        if (!filename || (!filename.endsWith(".ts") && !filename.endsWith(".js"))) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => { pending = null; buildAll().catch((e) => console.error(e)); }, 100);
    });
}
