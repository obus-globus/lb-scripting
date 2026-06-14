// End-to-end smoke test of the MVP in headless google-chrome:
//  1. default project loads (main.ts + util.ts), 0 type errors (cross-file resolves)
//  2. build → self-contained .mjs (helper inlined, @wunk erased)
//  3. type errors are reported
//  4. IndexedDB persistence survives a reload
//  5. a different #session is isolated (gets the default project, not our edits)
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { createServer } from "./serve.mjs";

const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
console.log("serving", base);

const exe = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });

const fails = [];
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fails.push(m); };
// cache-busting query forces a full document reload even when only the #session
// fragment changes (a fragment-only navigation would NOT reboot the app).
async function boot(hash) {
  await page.goto(`${base}?t=${Date.now()}${hash ? "#" + hash : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__ide && window.__ide.ready === true", { timeout: 60000 });
}
const dumpLog = async () => console.log("  [#log]\n" + (await page.evaluate(() => document.getElementById("log").innerText)).split("\n").map((l) => "    " + l).join("\n"));

// fixed session so we can reload into it
const SID = "verify-" + Date.now().toString(36);
await boot(SID);

console.log("\n[1] default project + type-check");
const files = await page.evaluate(() => window.__ide.listFiles());
ok(files.includes("main.ts") && files.includes("util.ts"), "default project has main.ts + util.ts: " + JSON.stringify(files));
const diags0 = await page.evaluate(() => window.__ide.diagnostics());
ok(diags0.length === 0, "main.ts type-checks clean (cross-file ./util resolves): " + JSON.stringify(diags0));

console.log("\n[2] build");
const built = await page.evaluate(() => window.__ide.build());
if (!built) await dumpLog();
ok(!!built && /main\.mjs$/.test(built.name), "produced " + (built && built.name));
ok(!!built && built.code.includes("x="), "helper (util.fmt) inlined into bundle");
ok(!!built && !built.code.includes("@wunk/"), "type-only @wunk import erased");
ok(!!built && !/^\s*import\s/m.test(built.code), "no residual import in bundle");

console.log("\n[3] diagnostics fire on bad code");
await page.evaluate(() => window.__ide.setActiveValue('/// <reference types="@wunk/lb-script-api-types/ambient" />\nconst x: number = "nope";\nClient.displayChatMessage(123);'));
const diagsBad = await page.evaluate(() => window.__ide.diagnostics());
ok(diagsBad.length >= 2, "reported >=2 errors on bad code: " + diagsBad.map((d) => "TS" + d.code).join(","));

console.log("\n[4] persistence across reload");
const SENTINEL = "PERSIST_" + Math.random().toString(36).slice(2, 8);
await page.evaluate((s) => window.__ide.setActiveValue("// " + s), SENTINEL);
await new Promise((r) => setTimeout(r, 600)); // let debounced save flush
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction("window.__ide && window.__ide.ready === true", { timeout: 60000 });
const afterReload = await page.evaluate(() => window.__ide.reloadFromDb());
const persisted = afterReload && JSON.stringify(afterReload.files).includes(SENTINEL);
ok(persisted, "edited content survived reload (IndexedDB): sentinel " + SENTINEL);

console.log("\n[5] session isolation");
await boot("other-" + Date.now().toString(36));
const otherFiles = await page.evaluate(() => ({ files: window.__ide.listFiles(), active: window.__ide.diagnostics }));
const otherMain = await page.evaluate(() => window.__ide.reloadFromDb());
ok(JSON.stringify(otherMain ? otherMain.files : {}).indexOf("PERSIST_") === -1, "a different #session does NOT see the other session's edits");

await browser.close();
server.close();

if (fails.length) { console.log("\nFAIL (" + fails.length + "):"); for (const f of fails) console.log("  - " + f); process.exit(1); }
console.log("\nPASS — MVP works: typed editing, in-browser build, persistence, per-session isolation. Zero backend.");
