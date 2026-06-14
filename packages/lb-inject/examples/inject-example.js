// lb-inject usage example — a self-contained LiquidBounce userscript.
//
// Drop this whole folder's deliverables into your LiquidBounce `scripts/` dir:
//   scripts/
//     nf-inject.js            (the library)
//     nf-inject-agent.jar     (the precompiled agent)
//     nf-holder.jar           (bootstrap holder; MUST sit next to the agent jar)
//     inject-example.js       (this file)
//
// It registers a module "InjectDemo". While enabled, it patches three points of
// net.minecraft.client.Minecraft with mixin-style hooks; disabling removes them
// and restores the original bytecode.
//
// Requires instrumentation, auto-detected by the library (see README):
//   - launched with -javaagent:nf-inject-agent.jar   -> works on ANY JRE, or
//   - a JDK runtime (jdk.attach, e.g. GraalVM)        -> self-attaches at runtime.
// If neither is available, Inject.inject(...) throws with guidance and the error
// is logged to the Minecraft log (latest.log) as a failed script load.

// Load the library (defines globalThis.Inject). The library lives in
// scripts/lib/ as a versioned file — either of:
//   - nf-inject-<ver>.js          (plain; ship nf-inject-agent.jar + nf-holder.jar too), or
//   - nf-inject-bundled-<ver>.js  (single-file build with both jars embedded).
// ensureLib() finds the requested version in scripts/lib/, or — if you dropped
// it directly in scripts/ — loads it from there (the library then relocates
// itself into scripts/lib/ for next time). Pin the version your script targets.
const _root = "" + Client.configSystem.rootFolder.getAbsolutePath();
function ensureLib(version) {
    const Files = Java.type("java.nio.file.Files");
    const Paths = Java.type("java.nio.file.Paths");
    const names = ["nf-inject-" + version + ".js", "nf-inject-bundled-" + version + ".js"];
    for (const name of names) {                                  // prefer scripts/lib/
        const p = Paths.get(_root, "scripts", "lib", name);
        if (Files.exists(p)) return p.toString();
    }
    for (const name of names) {                                  // fall back to a stray copy in scripts/
        const p = Paths.get(_root, "scripts", name);
        if (Files.exists(p)) return p.toString();
    }
    throw new Error("InjectDemo: nf-inject " + version + " not found in scripts/lib/ or scripts/ " +
        "(expected nf-inject-" + version + ".js or nf-inject-bundled-" + version + ".js)");
}
// Tell the library it's being consumed (so it won't treat itself as a stray
// auto-load), then load it BEFORE our own registerScript(...) below.
globalThis.__nfLibConsumed = true;
load(ensureLib("1.0.0"));

const script = registerScript({ name: "InjectDemo", version: "1.0.0", authors: ["Obus"] });

script.registerModule(
    { name: "InjectDemo", category: "Misc", description: "Demonstrates runtime bytecode injection via lb-inject" },
    function (mod) {
        // Handles returned by Inject.inject(...), removed on disable.
        let handles = [];
        let fpsCalls = 0;

        mod.on("enable", function () {
            handles = [];
            fpsCalls = 0;

            // 1) HEAD of Minecraft.getFps — runs every time the FPS getter is
            //    called (render thread, so a JS hook is safe here).
            handles.push(Inject.inject(
                "net.minecraft.client.Minecraft", "getFps", "HEAD",
                function () { fpsCalls++; }
            ));

            // 2) RETURN of Minecraft.tick — fires once per client tick, right
            //    before the method returns.
            handles.push(Inject.inject(
                "net.minecraft.client.Minecraft", "tick", "RETURN",
                function () {
                    if (fpsCalls > 0 && fpsCalls % 600 === 0) {
                        Client.displayChatMessage("§b[InjectDemo] getFps called " + fpsCalls + " times");
                    }
                }
            ));

            // 3) BEFORE a specific call inside a method (mixin @At INVOKE). The
            //    5th arg is the target "owner.member" the hook fires around.
            //    Here: just before Minecraft.tick calls Minecraft.getFps.
            handles.push(Inject.inject(
                "net.minecraft.client.Minecraft", "tick", "BEFORE_INVOKE",
                function () { /* runs right before the getFps() call site */ },
                "net.minecraft.client.Minecraft.getFps"
            ));

            Client.displayChatMessage("§a[InjectDemo] injected " + handles.length + " hooks: " + Inject.list().join(", "));
        });

        mod.on("disable", function () {
            // Remove every hook this module added; restores original bytecode.
            const removed = handles.length;
            handles.forEach(function (h) { Inject.remove(h); });
            handles = [];
            Client.displayChatMessage("§c[InjectDemo] removed " + removed + " hooks (getFps was called " + fpsCalls + "x)");
        });
    }
);
