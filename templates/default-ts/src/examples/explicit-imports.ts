/// <reference types="@wunk/lb-script-api-types/ambient" />
//
// Explicit-import style demo.
//
// Instead of relying solely on the ambient globals declared in ambient.d.ts,
// you can import JVM classes directly from the types package:
//
//   import { SomeClass } from "@wunk/lb-script-api-types/types/fully/qualified/SomeClass";
//
// The build pipeline rewrites each such import into the GraalJS-compatible form:
//   const SomeClass = Java.type("fully.qualified.SomeClass");
//
// Benefits:
//   - Full autocomplete & hover docs on every JVM class and static method.
//   - FQCN is derived from the import path — no magic strings.
//   - Easy to grep: `rg 'from "@liquidbounce-helper/.*/types/'`
//
// Caveats:
//   - A small number of generated stubs use reserved keywords as parameter
//     names and won't compile. If the TS checker reports "Module has no
//     exported member", fall back to the manual bridge:
//       const Foo = Java.type("fully.qualified.Foo") as unknown as typeof FooT;
//   - Use `import type { ... }` for purely structural references so the
//     transform leaves them alone and TypeScript erases them.

import { Mth } from "@wunk/lb-script-api-types/types/net/minecraft/util/Mth";

const script = registerScript({
    name: "ExplicitImportDemo",
    version: "0.1.0",
    authors: ["you"],
});

const SENSITIVITY = Setting.float({
    name: "sensitivity",
    default: 1.5,
    range: [0.1, 5.0],
    suffix: "×",
});

script.registerModule({
    name: "ExplicitImportDemo",
    category: "Misc",
    description: "Shows explicit JVM imports. Uses Mth.clamp to cap reported speed.",
}, (mod) => {
    mod.on("enable", () => {
        Client.displayChatMessage("§a[ExplicitImportDemo] enabled — Mth loaded via Java.type");
    });

    mod.on("playerTick", () => {
        const p = mc.player;
        if (p === null) return;

        // Mth is a JVM class rewritten by the build pipeline.
        // After build: `const Mth = Java.type("net.minecraft.util.Mth")`
        const raw = SENSITIVITY.get() * 10;
        const clamped = Mth.clamp(raw, 0, 20);

        Client.displayChatMessage(`§7  raw=${raw.toFixed(2)} clamped=${clamped}`);
    });

    mod.on("disable", () => {
        Client.displayChatMessage("§c[ExplicitImportDemo] disabled");
    });
});
