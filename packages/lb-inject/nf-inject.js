// @ts-check
// lb-inject — runtime bytecode injection for LiquidBounce GraalJS scripts.
//
// Type-checked (`// @ts-check`) against nf-inject.d.ts (the public `InjectApi`)
// and graaljs-env.d.ts (loose host-interop stubs). The `globalThis.Inject =
// Inject` assignment below is what enforces the implementation matches the
// shipped `.d.ts` — a missing/wrong public member is a compile error, so the
// types can't drift. Run `npm run typecheck`.
//
//   load("/abs/path/nf-inject.js");           // defines globalThis.Inject
//   var h = Inject.inject("net.minecraft.client.Minecraft", "getFps", "HEAD",
//             function () { /* JS hook — runs at the inject point */ });
//   Inject.remove(h);  Inject.list();  Inject.removeAll();
//
// Positions: HEAD, RETURN, BEFORE_INVOKE, AFTER_INVOKE, BEFORE_FIELD, AFTER_FIELD.
// The *_INVOKE/_FIELD positions take a 5th arg = target "owner.member"
// (e.g. "net.minecraft.client.Minecraft.getFps").
//
// hook: a JS function OR a java.lang.Runnable, run at the injection point. A JS
// function runs on whatever thread the patched method runs on, so it's only safe
// for points on the client/render thread (ticks, render, getFps, …). For points
// that fire on other threads, pass a precompiled java.lang.Runnable instead.
//
// Instrumentation is obtained with NO JDK needed at runtime, via the precompiled
// nf-inject-agent.jar (ASM bundled). The library auto-detects how to load it:
//   1. launched with `-javaagent:nf-inject-agent.jar`  -> premain already ran
//      (works on any JRE; nothing else needed)
//   2. else a JDK runtime (jdk.attach present, e.g. GraalVM)  -> the lib spawns
//      the bundled attacher to attach + loadAgent at runtime
//   3. neither -> throws with guidance.
// The injected bytecode is bootstrap-only:
//   ((Runnable) System.getProperties().get("nf.hook.<id>")).run()

(function () {
    const VERSION = "1.1.0";

    const System_ = Java.type("java.lang.System");
    const ProcessBuilder = Java.type("java.lang.ProcessBuilder");
    const ProcessHandle = Java.type("java.lang.ProcessHandle");
    const JString = Java.type("java.lang.String");
    const Paths = Java.type("java.nio.file.Paths");
    const Files = Java.type("java.nio.file.Files");
    const RunnableAdapter = Java.extend(Java.type("java.lang.Runnable"));

    const Integer_ = Java.type("java.lang.Integer");

    function rootFolder() {
        try { return "" + Client.configSystem.rootFolder.getAbsolutePath(); }
        catch (e) { return "" + System_.getProperty("user.dir"); }
    }

    // NfHolder is bootstrap-loaded once the agent is active; before that, Java.type
    // throws (class not found), which we treat as "not loaded yet".
    function holder() { try { return Java.type("NfHolder"); } catch (e) { return null; } }

    // Normalize one declaration (used by module()/always()) into inject() args.
    // Accepts a tuple  [className, method, position, hook, target?]  or a
    // mixin-style object  { class|className, method, at|position, hook|run, target? }.
    /**
     * @param {InjectDecl | any} d
     * @returns {any[]} inject() args: [className, method, position, hook, target?]
     */
    function declToArgs(d) {
        if (Array.isArray(d)) return d;
        return [d["class"] || d.className, d.method, d.at || d.position, d.hook || d.run, d.target];
    }

    // The public API, defined on globalThis.Inject. Conformance to the shipped
    // public type (nf-inject.d.ts `InjectApi`) is enforced by the `_apiConformance`
    // guard just before `globalThis.Inject = Inject` below — a missing or wrong
    // public member is a compile error there. The object keeps its own (richer,
    // with privates) inferred type here for internal use.
    const Inject = {
        VERSION,
        // Path to the precompiled generic agent jar (nf-holder.jar must sit next to
        // it). Defaults to <LiquidBounce>/scripts/lib/nf-inject-<VERSION>/nf-inject-agent.jar
        // (where the bundle self-extracts it). For the plain library, put the two
        // jars there yourself, or set Inject.agentJar to wherever they live.
        agentJar: null,
        // Optional path to a JDK home (a folder containing bin/java) whose
        // jdk.attach module is used to run the external attacher. Set this to
        // attach even when LiquidBounce itself runs on a *JRE* (the attacher
        // process supplies jdk.attach; the target VM doesn't need it). Leave null
        // to use the runtime java.home (which must itself be a JDK).
        jdkHome: null,
        // Set true to suppress the informational chat messages (errors still show).
        quiet: false,
        /** @type {Record<string, { tr: any, id: number, internal: string }>} */
        _handles: {},
        _n: 0,

        // Notify the user. severity ∈ "INFO" | "SUCCESS" | "ERROR" (default "INFO").
        // Posts a chat message + a LiquidBounce toast, and — because neither is
        // visible at the title screen — also a modal Swing message box the user
        // must click OK on (it blocks the game thread). The message box shows for
        // ERROR always, and for info/success unless Inject.quiet. Never throws.
        /** @param {string} msg @param {InjectSeverity} [severity] @returns {boolean} */
        notify(msg, severity) {
            severity = severity || "INFO";
            const plain = ("" + msg).replace(/§./g, "");       // strip §color codes
            // 1) LiquidBounce toast (in-game / web UI).
            try {
                const EM = Java.type("net.ccbluex.liquidbounce.event.EventManager");
                const NE = Java.type("net.ccbluex.liquidbounce.event.events.NotificationEvent");
                const Sev = Java.type("net.ccbluex.liquidbounce.event.events.NotificationEvent$Severity");
                EM.INSTANCE.callEvent(new NE("nf-inject", plain, Sev[severity] || Sev.INFO));
            } catch (e) { /* notification API unavailable */ }
            // 2) chat message (persists in the in-game chat history).
            try { Client.displayChatMessage("" + msg); } catch (e) { /* no chat (foreign thread) */ }
            // 3) native message box — guaranteed visible, even at the title screen.
            if (severity === "ERROR" || !this.quiet) this._dialog(plain, severity);
            try { System_.out.println(plain); } catch (e) { /* ignore */ }
            return true;
        },

        // Show a native Swing message box with an OK button. Preferred path: write
        // the embedded NfToast helper to disk and launch it as a SEPARATE process,
        // so it has its own AWT event thread and reliably appears (an in-process
        // modal shown from Minecraft's render thread is flaky). Falls back to an
        // in-process modal if the helper bytecode isn't embedded. Best-effort.
        /** @param {string} plain @param {string} severity */
        _dialog(plain, severity) {
            try {
                const b64 = globalThis.__NF_TOAST_CLASS_B64;
                if (b64) {
                    const dir = Paths.get(rootFolder(), "scripts", "lib", "nf-inject-" + VERSION);
                    Files.createDirectories(dir);
                    const cls = dir.resolve("NfToast.class");
                    const bytes = Java.type("java.util.Base64").getDecoder().decode(b64);
                    if (!Files.exists(cls) || Files.size(cls) !== bytes.length) Files.write(cls, bytes);
                    const home = "" + System_.getProperty("java.home");
                    const win = ("" + System_.getProperty("os.name")).toLowerCase().indexOf("win") >= 0;
                    const bin = home + "/bin/" + (win ? "javaw" : "java");   // javaw avoids a console flash on Windows
                    new ProcessBuilder(Java.to([bin, "-cp", "" + dir.toAbsolutePath(), "NfToast", severity, plain], "java.lang.String[]")).start();
                    return;
                }
                // Fallback: in-process modal (may be unreliable from the render thread).
                const JOptionPane = Java.type("javax.swing.JOptionPane");
                const type = severity === "ERROR" ? JOptionPane.ERROR_MESSAGE : JOptionPane.INFORMATION_MESSAGE;
                const html = "<html><body style='width:430px;font-family:sans-serif'>" +
                    plain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>") + "</body></html>";
                const pane = new JOptionPane(html, type);
                const dlg = pane.createDialog("nf-inject");
                dlg.setModal(true);
                dlg.setAlwaysOnTop(true);
                dlg.setVisible(true);
                dlg.dispose();
            } catch (e) { /* best-effort — toast + chat already fired */ }
        },

        _jar() { return this.agentJar ? ("" + this.agentJar) : Paths.get(rootFolder(), "scripts", "lib", "nf-inject-" + VERSION, "nf-inject-agent.jar").toString(); },

        ready() { const H = holder(); return H !== null && H.injector !== null; },

        // Ensure NfHolder.injector / .inst are available (idempotent).
        //
        // Three ways an Instrumentation is obtained, in order:
        //   (0) already there  — -javaagent premain, or a prior attach this session.
        //   (A) in-process self-attach — fast path. Needs a JDK runtime (jdk.attach)
        //       AND a LiquidBounce with the GraalVM caller-sensitive fix (b759cac57+),
        //       because VirtualMachine.attach() goes through ServiceLoader/reflection
        //       that the pre-fix client blocks from guest JS. Harmless on older
        //       clients — it throws and we fall through to (B). No subprocess.
        //   (B) external attacher subprocess — robust fallback. Runs a JDK's `java`
        //       (Inject.jdkHome if set, else the runtime java.home) to attach by pid
        //       and loadAgent. Setting jdkHome lets this work even when LiquidBounce
        //       runs on a JRE — the attacher process supplies jdk.attach; the target
        //       VM does not need it.
        ensure() {
            if (this.ready()) return;                                   // (0)
            const jar = this._jar();
            if (!Files.exists(Paths.get(jar))) {
                this.notify("§c[nf-inject] agent jar not found at §f" + jar + "§c — reinstall the library, or set Inject.agentJar.", "ERROR");
                throw new Error("nf-inject: agent jar not found at " + jar + " (set Inject.agentJar)");
            }
            const pid = "" + ProcessHandle.current().pid();

            // (A) in-process self-attach — best effort.
            try {
                // Allow attaching to our own VM. Read on the first attach, so set it
                // before VirtualMachine is touched. System.setProperty is not
                // caller-sensitive, so this is safe on any client.
                System_.setProperty("jdk.attach.allowAttachSelf", "true");
                // Java.type throws here if the runtime is a JRE (no jdk.attach).
                const VirtualMachine = Java.type("com.sun.tools.attach.VirtualMachine");
                const vm = VirtualMachine.attach(pid);                  // CS-gated on pre-fix clients -> throws -> (B)
                try { vm.loadAgent(jar); } finally { vm.detach(); }
                if (this.ready()) return;
            } catch (e) {
                // Older LB without the fix (caller-sensitive restriction), a JRE
                // runtime, or self-attach refused. Fall through to the attacher.
            }

            // (B) external attacher subprocess using a JDK's java binary.
            const jdkHome = this.jdkHome ? ("" + this.jdkHome) : ("" + System_.getProperty("java.home"));
            const javaBin = jdkHome + "/bin/java";
            const pb = new ProcessBuilder(Java.to([javaBin, "-cp", jar, "--add-modules", "jdk.attach", "NfAttacher", pid, jar], "java.lang.String[]"));
            pb.redirectErrorStream(true);
            const proc = pb.start();
            const out = "" + new JString(proc.getInputStream().readAllBytes());
            proc.waitFor();
            if (!this.ready()) {
                this.notify("§c[nf-inject] couldn't enable injection. Add the JVM arg " +
                    "§e-javaagent:" + jar + "§c (works on any JRE), run on a JDK runtime such as " +
                    "GraalVM (has jdk.attach), or set §eInject.jdkHome§c to a JDK path. See logs/latest.log.", "ERROR");
                throw new Error("nf-inject: could not obtain Instrumentation. Launch with " +
                    "-javaagent:" + jar + " (any JRE), use a JDK runtime (jdk.attach), or set " +
                    "Inject.jdkHome to a JDK so the attacher can run. Attacher said: " + out.trim());
            }
        },

        /**
         * @param {string} className
         * @param {string} method
         * @param {InjectPosition} position
         * @param {InjectHook} hook
         * @param {string} [invokeTarget]
         * @returns {InjectHandle}
         */
        inject(className, method, position, hook, invokeTarget) {
            this.ensure();
            const H = holder();
            const id = ++this._n;
            const runnable = (typeof hook === "function") ? new RunnableAdapter({ run: hook }) : hook;
            H.hooks.put(Integer_.valueOf(id), runnable);
            const internal = ("" + className).replace(/\./g, "/");
            let tOwner = null, tName = null;
            if (invokeTarget) {
                const s = ("" + invokeTarget).replace(/\//g, ".");
                const dot = s.lastIndexOf(".");
                tOwner = s.slice(0, dot).replace(/\./g, "/");
                tName = s.slice(dot + 1);
            }
            let tr;
            try {
                tr = H.injector.apply(Java.to([H.inst, internal, method, position, id, tOwner, tName], "java.lang.Object[]"));
            } catch (e) {
                H.hooks.remove(Integer_.valueOf(id));
                this.notify("§c[nf-inject] inject failed for §f" + className + "." + method + "§c (" + position + "). " +
                    "Check the class/method names match this Minecraft version. " + e, "ERROR");
                throw e;
            }
            const handle = "inj#" + id;
            this._handles[handle] = { tr, id, internal };
            return /** @type {InjectHandle} */ (handle);
        },

        /** @param {InjectHandle} handle @returns {string} */
        remove(handle) {
            const h = this._handles[handle];
            if (!h) return "no such handle: " + handle;
            const H = holder();
            H.remover.apply(Java.to([H.inst, h.tr, h.internal], "java.lang.Object[]"));
            H.hooks.remove(Integer_.valueOf(h.id));
            delete this._handles[handle];
            return "removed " + handle;
        },
        /** @returns {string} */
        removeAll() { const ks = Object.keys(this._handles); ks.forEach((k) => this.remove(/** @type {InjectHandle} */ (k))); return "removed " + ks.length; },
        list() { return Object.keys(this._handles); },

        // Declarative, module-bound injection (mixin style). Declare the hooks
        // ONCE; they're applied when the module is enabled and removed when it's
        // disabled — no manual on("enable")/on("disable") wiring. `decls` is an
        // array of tuples [className, method, position, hook, target?] or objects
        // { class, method, at, hook, target? }. Returns `mod` (chainable).
        //   Inject.module(mod, [
        //     ["net.minecraft.client.Minecraft", "tick", "RETURN", fn],
        //     { class: "net.minecraft.client.Minecraft", method: "getFps", at: "HEAD", hook: fn },
        //   ]);
        /**
         * @template {InjectModuleLike} M
         * @param {M} mod
         * @param {InjectDecl[]} decls
         * @returns {M}
         */
        module(mod, decls) {
            /** @type {InjectHandle[]} */
            let handles = [];
            const inject = /** @type {(...a: any[]) => InjectHandle} */ (this.inject.bind(this));
            mod.on("enable", () => { handles = decls.map((d) => inject(...declToArgs(d))); });
            mod.on("disable", () => { handles.forEach((h) => this.remove(h)); handles = []; });
            return mod;
        },

        // Declarative, always-on injection (mixin style). Apply the declared hooks
        // once and keep them for the whole game session — the closest thing to a
        // statically-declared mixin. `key` namespaces an idempotency sentinel so a
        // `.script reload` re-running the script doesn't stack duplicates. `decls`
        // is the same shape as module(). Returns the installed handles (or [] if
        // already installed this session).
        /** @param {string} key @param {InjectDecl[]} decls @returns {InjectHandle[]} */
        always(key, decls) {
            const sentinel = "nf.always." + VERSION + "." + key;
            if (System_.getProperty(sentinel) !== null) return [];
            const inject = /** @type {(...a: any[]) => InjectHandle} */ (this.inject.bind(this));
            const handles = decls.map((d) => inject(...declToArgs(d)));
            System_.setProperty(sentinel, "true");
            return handles;
        },
    };

    // This assignment is also the compile-time conformance check: `globalThis.Inject`
    // is typed `InjectApi` (nf-inject.d.ts), so a missing or wrong public member on
    // the object above is a type error here — the impl can't drift from the shipped .d.ts.
    globalThis.Inject = Inject;
})();

// --- LiquidBounce auto-load guard + self-relocation -------------------------
// LB auto-loads EVERY .js sitting directly in scripts/ as a standalone script,
// and rejects any that doesn't call registerScript() ("missing required
// information!"). This file is a *library* — it belongs in scripts/lib/, where
// LB does NOT auto-load it (it only auto-loads `main.*` inside a subfolder).
//
// Two cases handled here:
//   - load()ed by your script:  it sets globalThis.__nfLibConsumed before the
//     load(); we then do nothing (your script registers itself and owns paths).
//   - auto-loaded from scripts/ root (a stray copy):  we register benign info so
//     LB doesn't error, then move this file into scripts/lib/ so the next launch
//     it's no longer a stray. The move happens after our own eval, so LB's
//     in-progress load of this very file is unaffected.
(function () {
    try {
        if (typeof registerScript !== "function") return;   // not a LB script context (e.g. the REPL)
        if (globalThis.__nfLibConsumed) return;              // load()ed by a consumer script; leave everything to it
        const ver = (globalThis.Inject && globalThis.Inject.VERSION) || "0";
        registerScript({ name: "nf-inject (library)", version: ver, authors: ["lb-inject"] });
        // Relocate this stray copy from scripts/ root into scripts/lib/.
        const Files = Java.type("java.nio.file.Files");
        const Paths = Java.type("java.nio.file.Paths");
        const SCO = Java.type("java.nio.file.StandardCopyOption");
        const root = "" + Client.configSystem.rootFolder.getAbsolutePath();
        const selfName = (globalThis.__NF_IS_BUNDLE ? "nf-inject-bundled-" : "nf-inject-") + ver + ".js";
        const src = Paths.get(root, "scripts", selfName);
        if (Files.exists(src)) {
            const libDir = Paths.get(root, "scripts", "lib");
            Files.createDirectories(libDir);
            const dst = libDir.resolve(selfName);
            let moved = false;
            try { Files.move(src, dst, SCO.REPLACE_EXISTING); moved = true; }
            catch (e) { try { Files.copy(src, dst, SCO.REPLACE_EXISTING); Files.deleteIfExists(src); moved = true; } catch (e2) { /* best-effort */ } }
            if (moved && globalThis.Inject && !globalThis.Inject.quiet) {
                globalThis.Inject.notify("§a[nf-inject] Auto-moved §f" + selfName + "§a from scripts/ into scripts/lib/ " +
                    "to keep your scripts folder tidy.\n\n§7No action needed — this was done automatically and your " +
                    "scripts will keep working.", "SUCCESS");
            }
        }
    } catch (e) { /* best-effort; never break the host */ }
})();
