// Headless check: load the esbuild-wasm page in google-chrome, read the bundles
// it produced in-tab, and assert they are correct self-contained .mjs outputs.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

const server = http.createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/") rel = "/index.html";
    const data = await readFile(path.join(root, rel));
    res.writeHead(200, { "content-type": MIME[path.extname(rel)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;
console.log("serving", url);

const exe = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction("window.__build && window.__build.ready === true", { timeout: 60000 });
const r = await page.evaluate(() => window.__build);
await browser.close();
server.close();

const fails = [];
console.log("\n=== esbuild-wasm build spike ===");
if (r.error) {
  console.log("build threw:\n", r.error);
  process.exit(1);
}
console.log("esbuild version:", r.version);

for (const lang of ["ts", "js"]) {
  const out = r[lang];
  console.log(`\n[${lang}] output ${out.length} bytes; head:`);
  console.log(out.split("\n").slice(0, 6).map((l) => "   " + l).join("\n"));
  // 1) the helper file was actually inlined
  if (!out.includes("INLINED_UTIL_42")) fails.push(`${lang}: helper not inlined (MARKER missing)`);
  // 2) no unresolved bare imports remain (fully self-contained .mjs)
  if (/^\s*import\s/m.test(out)) fails.push(`${lang}: residual import statement in bundle`);
  if (/require\(/.test(out)) fails.push(`${lang}: residual require() in bundle`);
  // 3) the type-only @wunk import was erased
  if (out.includes("@wunk/")) fails.push(`${lang}: @wunk import not erased`);
  // 4) ambient globals survive as free references (runtime-provided by LB)
  if (!out.includes("registerScript")) fails.push(`${lang}: registerScript reference lost`);
  // 5) output parses as valid ESM (module syntax compiles)
  try {
    new Function("return (async()=>{})"); // sanity
    // eslint-disable-next-line no-new-func
    new Function(out.replace(/\bexport\b/g, "")); // strip export kw; checks syntax otherwise
  } catch (e) {
    fails.push(`${lang}: bundle is not syntactically valid JS: ${e.message}`);
  }
}

if (fails.length) {
  console.log("\nFAIL:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log("\nPASS — esbuild-wasm bundles multi-file TS & JS into one self-contained .mjs in-browser, type-only imports erased, ambient globals preserved.");
