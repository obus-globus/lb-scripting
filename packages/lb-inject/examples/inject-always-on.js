// lb-inject "always-on" example — a LiquidBounce userscript that installs its
// hooks at load time and keeps them active for the whole session. Unlike
// inject-example.js it registers NO module; there is nothing to toggle.
//
// Drop this + the library (nf-inject.js + jars, OR nf-inject-bundled.js) in your
// scripts/ folder. Instrumentation requirements are the same as the README
// (-javaagent on any JRE, or a JDK runtime so it can self-attach).

// Load the library (defines globalThis.Inject). It lives in scripts/lib/ as a
// versioned file (nf-inject-<ver>.js or nf-inject-bundled-<ver>.js). ensureLib()
// finds the requested version there, or loads a stray copy from scripts/ (which
// the library then relocates into scripts/lib/). Pin the version you target.
const _root = "" + Client.configSystem.rootFolder.getAbsolutePath();
function ensureLib(version) {
    const Files = Java.type("java.nio.file.Files");
    const Paths = Java.type("java.nio.file.Paths");
    const names = ["nf-inject-" + version + ".js", "nf-inject-bundled-" + version + ".js"];
    for (const name of names) {
        const p = Paths.get(_root, "scripts", "lib", name);
        if (Files.exists(p)) return p.toString();
    }
    for (const name of names) {
        const p = Paths.get(_root, "scripts", name);
        if (Files.exists(p)) return p.toString();
    }
    throw new Error("InjectAlwaysOn: nf-inject " + version + " not found in scripts/lib/ or scripts/ " +
        "(expected nf-inject-" + version + ".js or nf-inject-bundled-" + version + ".js)");
}
// Mark as consumed so the library won't relocate itself out from under us, then
// load it BEFORE registerScript(...).
globalThis.__nfLibConsumed = true;
load(ensureLib("1.0.0"));

// A script still must call registerScript(...) even with no module, otherwise
// LiquidBounce rejects it with "missing required information!".
registerScript({ name: "InjectAlwaysOn", version: "1.0.0", authors: ["Obus"] });

const System_ = Java.type("java.lang.System");

// Idempotency guard. LiquidBounce re-runs scripts on `.script reload`, which
// would stack duplicate injections (each load owns its own Inject handles). A
// shared sentinel (a bootstrap System property, visible across script contexts)
// makes the install happen at most once per game session. Namespaced by library
// version so different versions don't suppress each other.
const SENTINEL = "nf.alwayson.installed." + Inject.VERSION;
if (System_.getProperty(SENTINEL) === null) {
    try {
        let ticks = 0;

        // Minecraft.tick fires continuously (even at the main menu), so this hook
        // is genuinely "always on". Chat a heartbeat roughly once a minute.
        Inject.inject("net.minecraft.client.Minecraft", "tick", "RETURN", function () {
            if (++ticks % 1200 === 0) {
                Client.displayChatMessage("§b[InjectAlwaysOn] tick hook alive — " + ticks + " ticks");
            }
        });

        System_.setProperty(SENTINEL, "true");
        Client.displayChatMessage("§a[InjectAlwaysOn] hook installed (active for the whole session)");
    } catch (e) {
        Client.displayChatMessage("§c[InjectAlwaysOn] failed to install: " + e);
    }
} else {
    Client.displayChatMessage("§e[InjectAlwaysOn] already installed this session — skipping re-inject");
}
