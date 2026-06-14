// Pre-bundle @webcontainer/api into one ESM file the no-build page can import.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [path.join(app, "node_modules/@webcontainer/api/dist/index.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: path.join(app, "public/webcontainer-api.js"),
});
console.log("public/webcontainer-api.js bundled");
