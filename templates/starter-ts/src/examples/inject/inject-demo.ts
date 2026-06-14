// lb-inject + TypeScript — a self-contained LiquidBounce userscript.
//
// This is the TypeScript port of lb-inject's `inject-example.js`. It registers
// a module "InjectDemo" that, while enabled, patches three points of
// net.minecraft.client.Minecraft with mixin-style runtime bytecode hooks, and
// removes them (restoring the original bytecode) on disable.
//
// What TypeScript buys you here vs. the plain-JS version:
//   • `Inject` is fully typed (see types/lb-inject.d.ts) — positions
//     autocomplete, and the compiler enforces lb-inject's real call contract:
//     `HEAD`/`RETURN` take 4 args; `*_INVOKE`/`*_FIELD` REQUIRE the 5th target.
//   • handles are branded, so `Inject.remove(...)` won't accept a stray string.
//   • the script-API globals (`registerScript`, `mc`, `Client`, typed
//     `mod.on(...)`) come from @wunk/lb-script-api-types.
//
// Build:  npm run build   ->  dist/main.mjs   (load that into LiquidBounce)
// Needs instrumentation, auto-detected by lb-inject (see README): a `-javaagent`
// at launch (any JRE) or a JDK runtime like GraalVM (self-attaches).

// Bring in the lb-inject API. This one import is all the wiring you need: the
// build recognises it, strips it, and prepends the loader (or, with
// `npm run build:bundle`, the whole library) so `Inject` is ready at runtime.
import { Inject } from "lb-inject";

const script = registerScript({ name: "InjectDemo", version: "1.0.0", authors: ["Obus"] });

script.registerModule(
  { name: "InjectDemo", category: "Misc", description: "Runtime bytecode injection via lb-inject, in TypeScript" },
  (mod) => {
    // Handles returned by Inject.inject(...) — typed as InjectHandle[].
    let handles: ReturnType<typeof Inject.inject>[] = [];
    let fpsCalls = 0;

    mod.on("enable", () => {
      handles = [];
      fpsCalls = 0;

      // 1) HEAD of Minecraft.getFps — runs on every FPS-getter call (render
      //    thread, so a JS hook is safe).
      handles.push(Inject.inject(
        "net.minecraft.client.Minecraft", "getFps", "HEAD",
        () => { fpsCalls++; },
      ));

      // 2) RETURN of Minecraft.tick — once per client tick, before it returns.
      handles.push(Inject.inject(
        "net.minecraft.client.Minecraft", "tick", "RETURN",
        () => {
          if (fpsCalls > 0 && fpsCalls % 600 === 0) {
            Client.displayChatMessage(`§b[InjectDemo] getFps called ${fpsCalls} times`);
          }
        },
      ));

      // 3) BEFORE a specific call site inside a method (Mixin @At INVOKE). The
      //    5th arg is the target "owner.member". The compiler REQUIRES it here
      //    because the position is BEFORE_INVOKE — omit it and it won't build.
      handles.push(Inject.inject(
        "net.minecraft.client.Minecraft", "tick", "BEFORE_INVOKE",
        () => { /* runs right before the getFps() call site */ },
        "net.minecraft.client.Minecraft.getFps",
      ));

      Client.displayChatMessage(`§a[InjectDemo] injected ${handles.length} hooks: ${Inject.list().join(", ")}`);
    });

    mod.on("disable", () => {
      const removed = handles.length;
      handles.forEach((h) => Inject.remove(h));
      handles = [];
      Client.displayChatMessage(`§c[InjectDemo] removed ${removed} hooks (getFps was called ${fpsCalls}x)`);
    });
  },
);
