// Bundle the lb-fs web extension: src/extension.js (+ the @lb-ide/core bridge) →
// dist/extension.js. `vscode` stays external. Run: `node build.mjs`.
import { build } from "../../host/node_modules/esbuild/lib/main.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
mkdirSync(join(here, "dist"), { recursive: true });

await build({
  entryPoints: [join(here, "src/extension.js")],
  outfile: join(here, "dist/extension.js"),
  bundle: true, format: "cjs", platform: "browser", target: "es2022",
  external: ["vscode"], legalComments: "none",
  alias: { "@lb-ide/core/bridge": join(repo, "packages/lb-ide-core/src/bridge.js") },
});
console.log("built lb-fs dist/extension.js");
