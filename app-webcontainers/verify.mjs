// End-to-end smoke test of the WebContainers IDE in headless google-chrome:
//  1. default project loads, type-checks clean (Monaco, same as the wasm app)
//  2. REAL build: boots a WebContainer, npm install + native esbuild in-tab,
//     producing a self-contained .mjs (helper inlined, @wunk type-import erased)
//  3. IndexedDB persistence survives reload
//  4. a different #session is isolated
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { createServer } from "./serve.mjs";

const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
console.log("serving", base);

const exe = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 180000, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

const fails = [];
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fails.push(m); };
async function boot(hash) { await page.goto(`${base}?t=${Date.now()}${hash ? "#" + hash : ""}`, { waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__ide && window.__ide.ready === true", { timeout: 60000 }); }

const SID = "verify-" + Date.now().toString(36);
await boot(SID);

console.log("\n[0] cross-origin isolated");
ok(await page.evaluate(() => self.crossOriginIsolated === true), "page is cross-origin isolated (COOP/COEP ok)");

console.log("\n[1] default project + type-check");
const files = await page.evaluate(() => window.__ide.listFiles());
ok(files.includes("main.ts") && files.includes("util.ts"), "default project: " + JSON.stringify(files));
const diags0 = await page.evaluate(() => window.__ide.diagnostics());
ok(diags0.length === 0, "main.ts type-checks clean: " + JSON.stringify(diags0));

console.log("\n[2] REAL in-container build (npm install + native esbuild) — may take ~30s");
const built = await page.evaluate(() => window.__ide.build());
ok(!!built && /main\.mjs$/.test(built.name), "produced " + (built && built.name));
ok(!!built && built.code.includes("x="), "helper (util.fmt) inlined into bundle");
ok(!!built && !built.code.includes("@wunk/"), "type-only @wunk import erased");
ok(!!built && !/^\s*import\s/m.test(built.code), "no residual import in bundle");

console.log("\n[3] persistence across reload");
const SENTINEL = "PERSIST_" + Math.random().toString(36).slice(2, 8);
await page.evaluate((s) => window.__ide.setActiveValue("// " + s), SENTINEL);
await new Promise((r) => setTimeout(r, 600));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction("window.__ide && window.__ide.ready === true", { timeout: 60000 });
const after = await page.evaluate(() => window.__ide.reloadFromDb());
ok(after && JSON.stringify(after.files).includes(SENTINEL), "edit survived reload (IndexedDB)");

console.log("\n[4] session isolation");
await boot("other-" + Date.now().toString(36));
const other = await page.evaluate(() => window.__ide.reloadFromDb());
ok(JSON.stringify(other ? other.files : {}).indexOf("PERSIST_") === -1, "different #session does not see the edits");

await browser.close();
server.close();
if (fails.length) { console.log("\nFAIL (" + fails.length + "):"); for (const f of fails) console.log("  - " + f); process.exit(1); }
console.log("\nPASS — WebContainers IDE: typed editing + REAL in-tab npm/esbuild build + persistence + isolation.");
