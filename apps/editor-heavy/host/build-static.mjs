// Build a STATIC, deployable heavy-mode bundle (no node server in prod - COI comes
// from the fronting web server, e.g. Caddy). Produces dist/:
//   index.html        baked workbench shell (config inlined; a tiny inline script
//                     fixes extension/folder URIs from window.location so the build
//                     is origin-agnostic and works under a path prefix)
//   out/ extensions/ node_modules/ resources/   → symlinks into the vscode-web bundle
//   devext/ fsext/    the lb-glue + lb-fs extension dirs (package.json + dist/)
//   typings/          the generated barrel (barrel.d.ts + ambient.d.ts)
//   lb/config         static config (no live bridge → read-only demo project)
//   lb/project.json   a read-only demo project so the deploy renders WITH content
//
// Base path: LB_BASE_PATH (e.g. "/liquid-ide" behind Caddy handle_path; "" at root).
import { mkdirSync, rmSync, cpSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const BUNDLE = process.env.LB_BUNDLE || "/home/clawd/obus/vscode-web";
const OUT = process.env.LB_OUT || path.join(HERE, "dist");
const BASE = (process.env.LB_BASE_PATH || "").replace(/\/$/, ""); // "" or "/liquid-ide"
const PROJECT_ID = "demo";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1) symlink the big bundle trees (reproducible; no 194 MB copy).
for (const d of ["out", "extensions", "node_modules", "resources"]) {
  if (existsSync(path.join(BUNDLE, d))) symlinkSync(path.join(BUNDLE, d), path.join(OUT, d));
}

// 2) extensions: package.json + dist/ for lb-glue (devext) and lb-fs (fsext).
for (const [src, dst] of [["lb-glue", "devext"], ["lb-fs", "fsext"]]) {
  const s = path.join(REPO, "apps/editor-heavy", src);
  mkdirSync(path.join(OUT, dst), { recursive: true });
  cpSync(path.join(s, "package.json"), path.join(OUT, dst, "package.json"));
  cpSync(path.join(s, "dist"), path.join(OUT, dst, "dist"), { recursive: true });
}

// 3) typings (the generated barrel).
cpSync(path.join(HERE, "typings"), path.join(OUT, "typings"), { recursive: true });

// 4) static config + demo project (no live bridge → read-only).
mkdirSync(path.join(OUT, "lb"), { recursive: true });
writeFileSync(path.join(OUT, "lb", "config"), JSON.stringify({ bridgeBase: "", bridgeToken: "", projectId: PROJECT_ID }));
const demo = {
  id: PROJECT_ID, name: "Heavy Demo",
  files: {
    "main.ts": `import { Vec3 } from "@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3";\n` +
      `// Full @wunk intellisense + an in-browser esbuild build - no install, no server.\n` +
      `const script = registerScript({ name: "HeavyDemo", version: "1.0.0", authors: ["you"] });\n` +
      `const player = mc.player;                 // ambient global, fully typed\n` +
      `const pos: Vec3 = null as unknown as Vec3;\n` +
      `const height: number = pos.y;             // Vec3.y → number (hover to see it)\n`,
  },
};
writeFileSync(path.join(OUT, "lb", "project.json"), JSON.stringify(demo, null, 2));

// 5) index.html - bake the workbench config + a runtime origin-fixup.
const bootstrap = readFileSync(path.join(HERE, "web", "bootstrap.js"), "utf8")
  .replace("./workbench.api", `${BASE}/out/vs/workbench/workbench.web.main.internal.js`);
const config = {
  productConfiguration: { nameShort: "LB Heavy", nameLong: "LB Script IDE (heavy)", enableTelemetry: false },
  // scheme/authority are filled at runtime (origin-agnostic); paths carry the base.
  developmentOptions: { extensions: [{ scheme: "", authority: "", path: `${BASE}/devext` }] },
  additionalBuiltinExtensions: [{ scheme: "", authority: "", path: `${BASE}/fsext` }],
  folderUri: { scheme: "lbfs", authority: PROJECT_ID, path: "/" },
};
const html = `<!DOCTYPE html>
<html><head>
  <script>performance.mark('code/didStartRenderer')</script>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
  <meta id="vscode-workbench-web-configuration" data-settings='${JSON.stringify(config)}'>
  <link rel="stylesheet" href="${BASE}/out/vs/workbench/workbench.web.main.internal.css" />
  <style id="vscode-css-modules" type="text/css" media="screen"></style>
  <script>
    // Origin-agnostic: fill the workbench/webview origins from where we're actually
    // served, so the same static build works on localhost and the deploy domain.
    (function () {
      var el = document.getElementById('vscode-workbench-web-configuration');
      var cfg = JSON.parse(el.getAttribute('data-settings'));
      var scheme = location.protocol.replace(':', ''), authority = location.host, base = ${JSON.stringify(BASE)};
      (cfg.developmentOptions && cfg.developmentOptions.extensions || []).forEach(function (e) { e.scheme = scheme; e.authority = authority; });
      (cfg.additionalBuiltinExtensions || []).forEach(function (e) { e.scheme = scheme; e.authority = authority; });
      cfg.productConfiguration.webEndpointUrlTemplate = scheme + '://{{uuid}}.' + authority + base;
      cfg.productConfiguration.webviewContentExternalBaseUrlTemplate = scheme + '://{{uuid}}.' + authority + base + '/out/vs/workbench/contrib/webview/browser/pre/';
      el.setAttribute('data-settings', JSON.stringify(cfg));
    })();
    const baseUrl = new URL('${BASE}' || '/', window.location.origin).toString();
    globalThis._VSCODE_FILE_ROOT = baseUrl.replace(/\\/$/, '') + '/out/';
  </script>
  <script>performance.mark('code/willLoadWorkbenchMain');</script>
  <script src="${BASE}/out/nls.messages.js"></script>
</head><body aria-label=""></body>
  <script type="module">${bootstrap}</script>
</html>`;
writeFileSync(path.join(OUT, "index.html"), html);

console.log(`static heavy build → ${OUT}  (base="${BASE || "/"}", bundle=${BUNDLE})`);
