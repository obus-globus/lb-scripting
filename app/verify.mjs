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

console.log("\n[1] categories: base (no examples) + per-example projects");
const cats = await page.evaluate(() => window.__ide.categories());
ok(["default-ts", "plain-js", "starter-ts", "inject-ts"].every((id) => cats.some((c) => c.id === id)), "4 categories: " + cats.map((c) => c.id).join(","));
const def = cats.find((c) => c.id === "default-ts");
ok(def.baseFiles.length === 1 && def.baseFiles[0] === "main.ts", "base project is just main.ts (no examples bundled): " + JSON.stringify(def.baseFiles));
ok(def.examples.length > 5, "default category exposes example projects: " + def.examples.length);
const src0 = await page.evaluate(() => { const aux = window.__ide.auxFiles(); return window.__ide.listFiles().filter((f) => !aux.includes(f)); });
ok(src0.length === 1 && src0[0] === "main.ts", "opened blank project has only main.ts (excl. aux): " + JSON.stringify(src0));
const d0 = await page.evaluate(() => window.__ide.diagnostics());
ok(d0.length === 0, "base main.ts type-checks clean: " + JSON.stringify(d0));
const b0 = await page.evaluate(() => window.__ide.build());
ok(!!b0, "base project builds");

console.log("\n[1a] a multi-file example project (folders + cross-import)");
const mf = def.examples.find((e) => e.id === "multi-file");
ok(!!mf && mf.files.some((f) => f.includes("/")), "multi-file example carries a folder: " + JSON.stringify(mf && mf.files));
await page.evaluate(() => { const m = window.__ide.categories().find((c) => c.id === "default-ts").examples.find((e) => e.id === "multi-file"); return window.__ide.createProject("default-ts", m.id); });
const mfFiles = await page.evaluate(() => window.__ide.listFiles());
ok(mfFiles.includes("examples/multi-file/lib/format.ts") || mfFiles.some((f) => f.endsWith("lib/format.ts")), "multi-file project has the lib helper: " + JSON.stringify(mfFiles));
const dmf = await page.evaluate(() => window.__ide.diagnostics());
ok(dmf.length === 0, "multi-file example main type-checks (cross-folder import): " + JSON.stringify(dmf));
const bmf = await page.evaluate(() => window.__ide.build());
ok(!!bmf && !/from\s*["']\.\//.test(bmf.code), "multi-file example builds with the local helper inlined (no residual ./import)");

console.log("\n[1b] add a nested file + cross-folder import, rebuild");
await page.evaluate(() => {
  window.__ide.writeFile("lib/greet.ts", 'export const greet = (n: string): string => "hi " + n;');
  window.__ide.writeFile("main.ts",
    '/// <reference types="@wunk/lb-script-api-types/ambient" />\n' +
    'import { greet } from "./lib/greet";\n' +
    'registerScript({ name: "t", version: "0", authors: [] });\n' +
    'Client.displayChatMessage(greet("world"));');
});
const dNested = await page.evaluate(() => window.__ide.diagnosticsFor("main.ts"));
ok(dNested.length === 0, "main.ts importing ./lib/greet type-checks: " + JSON.stringify(dNested));
const bNested = await page.evaluate(() => window.__ide.build());
ok(!!bNested && bNested.code.includes("hi "), "nested lib/greet.ts inlined into build");

console.log("\n[1c] open-file tabs (second tier)");
await page.evaluate(() => window.__ide.createProject("default-ts", "multi-file")); // main.ts + lib/format.ts
await page.evaluate(() => window.__ide.openFile("lib/format.ts"));
await page.evaluate(() => window.__ide.writeFile("extra.ts", "export const x = 1;"));
let tabs = await page.evaluate(() => window.__ide.openTabs());
ok(tabs.length === 3 && tabs.includes("lib/format.ts") && tabs.includes("extra.ts"), "opening files adds editor tabs: " + JSON.stringify(tabs));
const domTabs = await page.evaluate(() => document.querySelectorAll("#ftabs .ftab").length);
ok(domTabs === 3, "file tab bar renders " + domTabs + " tabs");
await page.evaluate(() => window.__ide.closeTab("lib/format.ts"));
tabs = await page.evaluate(() => window.__ide.openTabs());
ok(tabs.length === 2 && !tabs.includes("lib/format.ts"), "closing a tab removes it (file kept): " + JSON.stringify(tabs));
ok((await page.evaluate(() => window.__ide.listFiles())).includes("lib/format.ts"), "closed tab's file still exists in the project");

console.log("\n[1d] supporting (aux) files toggle");
await page.evaluate(() => window.__ide.createProject("inject-ts"));
const aux = await page.evaluate(() => window.__ide.auxFiles());
ok(aux.includes("package.json") && aux.some((f) => f.startsWith("vendor/")) && aux.some((f) => f.startsWith("scripts/")), "inject project has aux files (lib + build script + config): " + JSON.stringify(aux));
await page.evaluate(() => window.__ide.setShowAux(false));
let labels = await page.evaluate(() => window.__ide.treeLabels());
ok(!labels.includes("package.json") && !labels.includes("vendor"), "aux files hidden by default (no package.json/vendor in tree)");
await page.evaluate(() => window.__ide.setShowAux(true));
labels = await page.evaluate(() => window.__ide.treeLabels());
ok(labels.includes("package.json") && labels.includes("scripts") && labels.includes("vendor"), "toggle reveals supporting files (package.json, scripts/, vendor/)");
// aux files must NOT change the build output
const bAux = await page.evaluate(() => window.__ide.build());
ok(!!bAux && bAux.code.includes("__nfLibConsumed"), "build still produces the inject bundle (aux files not part of the entry graph)");
await page.evaluate(() => window.__ide.setShowAux(false));

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
