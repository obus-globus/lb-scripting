// End-to-end smoke test in headless google-chrome:
//  1. templates load (4); default project builds
//  2. INJECT template: type-checks clean (lb-inject + ambient) and builds —
//     lb-inject runtime inlined, `from "lb-inject"` gone
//  3. JVM-type value import rewritten to Java.type("…") in the bundle
//  4. multiple projects: create / switch / isolation, persist across reload
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { createServer } from "./serve.mjs";

const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
console.log("serving", base);

const exe = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 120000, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

const fails = [];
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fails.push(m); };
async function boot() { await page.goto(`${base}?t=${Date.now()}`, { waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__ide && window.__ide.ready === true", { timeout: 60000 }); }

// fresh storage each run
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase("lb-ide"); r.onsuccess = r.onerror = () => res(); }));
await boot();

console.log("\n[1] templates + default build");
const templates = await page.evaluate(() => window.__ide.templates());
ok(["default-ts", "plain-js", "starter-ts", "inject-ts"].every((t) => templates.includes(t)), "4 templates: " + JSON.stringify(templates));
const d0 = await page.evaluate(() => window.__ide.diagnostics());
ok(d0.length === 0, "default project type-checks clean: " + JSON.stringify(d0));
const b0 = await page.evaluate(() => window.__ide.build());
ok(!!b0 && b0.code.includes("x="), "default project builds (helper inlined)");

console.log("\n[2] inject template");
await page.evaluate(() => window.__ide.createProject("inject-ts"));
const cur = await page.evaluate(() => window.__ide.current());
ok(cur.templateId === "inject-ts", "created inject project: " + cur.name);
const dInj = await page.evaluate(() => window.__ide.diagnostics());
ok(dInj.length === 0, "inject main.ts type-checks clean (lb-inject + ambient resolve): " + JSON.stringify(dInj));
const bInj = await page.evaluate(() => window.__ide.build());
ok(!!bInj && bInj.code.includes("__nfLibConsumed"), "lb-inject runtime inlined into bundle");
ok(!!bInj && !/from\s*["']lb-inject["']/.test(bInj.code), "no residual lb-inject import");
ok(!!bInj && /Inject/.test(bInj.code), "Inject API present in bundle");

console.log("\n[3] JVM-type value import → Java.type(...)");
await page.evaluate(() => window.__ide.createProject("default-ts"));
await page.evaluate(() => window.__ide.setActiveValue(
  '/// <reference types="@wunk/lb-script-api-types/ambient" />\n' +
  'import { Vec3 } from "@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3";\n' +
  'registerScript({ name: "t", version: "0", authors: [] });\n' +
  'const v = new Vec3(1, 2, 3);\n' +
  'Client.displayChatMessage("" + v.x);'));
const bJvm = await page.evaluate(() => window.__ide.build());
ok(!!bJvm && bJvm.code.includes('Java.type("net.minecraft.world.phys.Vec3")'), "Vec3 import compiled to Java.type(...)");

console.log("\n[4] multiple projects + isolation + persistence");
const projects = await page.evaluate(() => window.__ide.listProjects());
ok(projects.length >= 3, "three projects open in tabs: " + projects.length);
const SENT = "SENT_" + Math.random().toString(36).slice(2, 7);
await page.evaluate((s) => window.__ide.setActiveValue("// " + s), SENT);
await new Promise((r) => setTimeout(r, 500));
// switch to the first project and confirm it does NOT contain the sentinel
await page.evaluate((id) => window.__ide.switchProject(id), projects[0]);
const firstFiles = await page.evaluate(() => window.__ide.listFiles());
const firstProj = await page.evaluate((id) => window.__ide.getProject(id), projects[0]);
ok(JSON.stringify(firstProj.files).indexOf(SENT) === -1, "other project is isolated (no sentinel)");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction("window.__ide && window.__ide.ready === true", { timeout: 60000 });
const metaAfter = await page.evaluate(() => window.__ide.reloadMeta());
ok(metaAfter && metaAfter.ids.length >= 3, "projects persisted across reload: " + (metaAfter && metaAfter.ids.length));

await browser.close();
server.close();
if (fails.length) { console.log("\nFAIL (" + fails.length + "):"); for (const f of fails) console.log("  - " + f); process.exit(1); }
console.log("\nPASS — project tabs + templates (incl. inject) + JVM-type/lb-inject build + isolation + persistence.");
