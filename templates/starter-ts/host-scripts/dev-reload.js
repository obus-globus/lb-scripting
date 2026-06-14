// dev-reload.js — LiquidBounce-side companion for `npm run dev` hot-reload + debug.
//
// Load this ONCE in your client (drop it in <LiquidBounce>/scripts/ and
// `.script reload`, or `.script load dev-reload.js`). It watches a trigger
// DIRECTORY that `npm run dev` writes to on every build and reloads each target
// script through LiquidBounce's own ScriptManager — optionally with the GraalJS
// debugger attached, so breakpoints survive across reloads.
//
// Multiple dev envs can target one client at once: each writes its own
// .dev-reload/<entry>.json (its own debug port), and this companion reloads each
// independently. Channel is plain files polled on a background thread — no HTTP
// server. The reload runs on the MC thread (ScriptManager isn't thread-safe).
//
// Trigger file (written by scripts/build.mjs --dev), one per entry:
//   <scripts>/.dev-reload/<entry>.json
//   { "file": "main.mjs", "ts": 1718000000000,
//     "debug": { "enabled": true, "protocol": "INSPECT", "port": 9229,
//                "suspendOnStart": false, "inspectInternals": false } }

const Files          = Java.type("java.nio.file.Files");
const JString        = Java.type("java.lang.String");
const JFile          = Java.type("java.io.File");
const Thread         = Java.type("java.lang.Thread");
const ScriptManager  = Java.type("net.ccbluex.liquidbounce.script.ScriptManager").INSTANCE;
const DebugOptions   = Java.type("net.ccbluex.liquidbounce.script.ScriptDebugOptions");
const DebugProtocol  = Java.type("net.ccbluex.liquidbounce.script.DebugProtocol");

const script = registerScript({ name: "dev-reload", version: "1.1.0", authors: ["Obus"] });

const ROOT        = ScriptManager.root;                   // <LiquidBounce>/scripts (a File)
const TRIGGER_DIR = new JFile(ROOT, ".dev-reload");
const seen = {};                                          // trigger filename -> last ts handled

function findLoaded(fileName, abs) {
    // ScriptManager.scripts is a Kotlin List (not a plain array) — iterate it.
    const it = ScriptManager.scripts.iterator();
    while (it.hasNext()) {
        const s = it.next();
        const f = s.file;
        if (("" + f.getName()) === fileName || ("" + f.getAbsolutePath()) === abs) return s;
    }
    return null;
}

function buildDebugOptions(d) {
    d = d || {};
    const proto = ("" + (d.protocol || "INSPECT")).toUpperCase() === "DAP"
        ? DebugProtocol.DAP : DebugProtocol.INSPECT;
    return new DebugOptions(
        !!d.enabled, proto, !!d.suspendOnStart, !!d.inspectInternals, (d.port | 0) || 9229);
}

function reload(cfg) {
    const target = new JFile(ROOT, cfg.file);
    const abs    = "" + target.getAbsolutePath();
    const opts   = buildDebugOptions(cfg.debug);
    // ScriptManager mutates engine state — must run on the MC/render thread.
    mc.execute(function () {
        try {
            const old = findLoaded(cfg.file, abs);
            if (old) ScriptManager.unloadScript(old);
            // loadScript only parses + registers; enable() adds the script's
            // modules to ModuleManager (so they show up + are toggleable again).
            ScriptManager.loadScript(target, "js", opts).enable();
            const dbg = cfg.debug && cfg.debug.enabled
                ? " §7(debug " + ("" + opts.protocol.name()) + ":" + opts.port + ")" : "";
            Client.displayChatMessage("§a[dev-reload] §rreloaded §e" + cfg.file + dbg);
        } catch (e) {
            Client.displayChatMessage("§c[dev-reload] reload failed: §r" + e);
        }
    });
}

function readTrigger(file) {
    try { return JSON.parse("" + new JString(Files.readAllBytes(file.toPath()))); }
    catch (e) { return null; }
}

// Scan .dev-reload/*.json; reload any whose ts changed. `seedOnly` records the
// current ts without reloading (so loading this companion doesn't reload
// everything from triggers left over by a previous session).
function scan(seedOnly) {
    if (!TRIGGER_DIR.isDirectory()) return;
    const files = TRIGGER_DIR.listFiles();
    if (files == null) return;
    for (let i = 0; i < files.length; i++) {
        const tf = files[i];
        if (!("" + tf.getName()).endsWith(".json")) continue;
        const cfg = readTrigger(tf);
        if (!cfg || typeof cfg.ts !== "number" || !cfg.file) continue;
        const key = "" + tf.getName();
        if (seen[key] === cfg.ts) continue;
        seen[key] = cfg.ts;
        if (!seedOnly) reload(cfg);
    }
}

UnsafeThread.run(function () {
    Client.displayChatMessage("§a[dev-reload] §rwatching §7" + TRIGGER_DIR.getAbsolutePath());
    scan(true);                                           // seed; don't reload on load
    while (true) {
        try { scan(false); } catch (e) { /* keep polling */ }
        try { Thread.sleep(300); } catch (e) { break; }
    }
});
