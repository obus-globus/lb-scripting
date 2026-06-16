// Build step: emit public/typings-bundle.json — the transitive .d.ts closure the
// editor ships to the browser. The full @wunk/lb-script-api-types package is
// ~96MB / 56k files; we ship only what a representative script references
// (~6k files / ~1.2MB gzipped) by asking tsc --listFiles for the closure of a
// seed that pulls in the ambient globals + a common JVM-path import.
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgRoot = path.join(appRoot, "node_modules/@wunk/lb-script-api-types");

// Temp dir must live inside appRoot so node_modules resolution reaches the
// installed @wunk/typescript packages.
const tmp = mkdtempSync(path.join(appRoot, ".gen-tmp-"));
const seed = `/// <reference types="@wunk/lb-script-api-types/ambient" />
import { Vec3 } from "@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3";
const _v: Vec3 | null = null; void _v;
registerScript({ name: "seed", version: "0", authors: [] });
`;
writeFileSync(path.join(tmp, "seed.ts"), seed);
writeFileSync(
  path.join(tmp, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2022",
      module: "esnext",
      moduleResolution: "bundler",
      lib: ["es2023"],
      types: ["@wunk/lb-script-api-types/ambient"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    files: ["seed.ts"],
  }),
);

const tscBin = path.join(appRoot, "node_modules/.bin/tsc");
const bundle = {};
let bytes = 0;
try {
  const listed = execSync(`"${tscBin}" -p "${path.join(tmp, "tsconfig.json")}" --listFiles`, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    cwd: appRoot,
  })
    .split("\n")
    .map((l) => l.trim())
    .filter((p) => p.startsWith(pkgRoot));

  for (const abs of listed) {
    const rel = "node_modules/@wunk/lb-script-api-types/" + path.relative(pkgRoot, abs);
    const content = readFileSync(abs, "utf8");
    bundle[rel] = content;
    bytes += content.length;
  }
  bundle["node_modules/@wunk/lb-script-api-types/package.json"] = readFileSync(path.join(pkgRoot, "package.json"), "utf8");
  writeFileSync(path.join(appRoot, "public/typings-bundle.json"), JSON.stringify(bundle));

  // Second artifact: the registry-lb DELTA — the Java.type string-literal registry
  // for LiquidBounce classes + the extra .d.ts it pulls in beyond the base closure.
  // Shipped separately and loaded into Monaco only when the editor's "JVM type info"
  // toggle is on, so the default editor stays lean. (registry-full is intentionally
  // NOT shipped — it's effectively the whole package; that's the lazy/export path.)
  const regTmp = mkdtempSync(path.join(appRoot, ".gen-reg-"));
  try {
    writeFileSync(path.join(regTmp, "seed.ts"),
      `/// <reference types="@wunk/lb-script-api-types/ambient" />\n` +
      `/// <reference types="@wunk/lb-script-api-types/registry-lb" />\n` +
      `registerScript({ name: "seed", version: "0", authors: [] });\n`);
    writeFileSync(path.join(regTmp, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", lib: ["es2023"],
        types: ["@wunk/lb-script-api-types/ambient", "@wunk/lb-script-api-types/registry-lb"],
        strict: true, noEmit: true, skipLibCheck: true },
      files: ["seed.ts"],
    }));
    const reg = {};
    let regBytes = 0;
    const regListed = execSync(`"${tscBin}" -p "${path.join(regTmp, "tsconfig.json")}" --listFiles`, {
      encoding: "utf8", maxBuffer: 256 * 1024 * 1024, cwd: appRoot,
    }).split("\n").map((l) => l.trim()).filter((p) => p.startsWith(pkgRoot));
    for (const abs of regListed) {
      const rel = "node_modules/@wunk/lb-script-api-types/" + path.relative(pkgRoot, abs);
      if (rel in bundle) continue; // delta only — the base closure already ships these
      const content = readFileSync(abs, "utf8");
      reg[rel] = content; regBytes += content.length;
    }
    writeFileSync(path.join(appRoot, "public/typings-registry-lb.json"), JSON.stringify(reg));
    console.log(`typings-registry-lb.json: ${Object.keys(reg).length} delta files, ${(regBytes / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    rmSync(regTmp, { recursive: true, force: true });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true }); // always clean the temp dir, even on tsc error
}
console.log(`typings-bundle.json: ${Object.keys(bundle).length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
