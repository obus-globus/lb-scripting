// Headless end-to-end check of the Monaco page: serve public/, load it in
// google-chrome via puppeteer-core, wait for window.__spike, assert the typings
// resolve and diagnostics fire. Exit non-zero on any failed assertion.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".ttf": "font/ttf", ".map": "application/json" };

const server = http.createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/") rel = "/index.html";
    const file = path.join(root, rel);
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
console.log("serving", url);

const exe = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"].find((p) => existsSync(p));

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [page error]", m.text()); });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction("window.__spike && window.__spike.ready === true", { timeout: 60000 });
const r = await page.evaluate(() => window.__spike);

await browser.close();
server.close();

// ---- assertions ----
const fails = [];
console.log("\n=== Monaco spike results ===");
console.log("typing files registered:", r.libCount);
console.log("good.ts diagnostics:", r.good.length, JSON.stringify(r.good));
console.log("bad.ts diagnostics: ", r.bad.length);
for (const d of r.bad) console.log("   TS" + d.code + ":", d.message);
console.log("mc.* completions:", r.mcCompletionCount, "sample:", r.mcSample.join(", "));

if (r.libCount < 1000) fails.push(`expected many typing files, got ${r.libCount}`);
if (r.good.length !== 0) fails.push(`good.ts should have 0 errors, got ${r.good.length}: ${JSON.stringify(r.good)}`);
if (r.bad.length < 3) fails.push(`bad.ts should have >=3 errors, got ${r.bad.length}`);
if (r.mcCompletionCount < 1) fails.push(`mc.* should yield completions (ambient global), got ${r.mcCompletionCount}`);

if (fails.length) {
  console.log("\nFAIL:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log("\nPASS — typings resolve in-browser, autocomplete + diagnostics work, zero backend.");
