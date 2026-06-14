// @ts-check
//
// typed-java.js — getting *type safety* on raw JVM classes in plain JS.
//
// `Java.type("...")` returns `any`: no autocomplete, no checking. In a TypeScript
// project you'd `import { Vec3 } from "@wunk/.../types/.../Vec3"` and the build
// rewrites that to `Java.type(...)`. In plain JS there's no build step, so we get
// the same types with a one-line JSDoc cast against the generated `@wunk` types:
//
//     const X = /** @type {typeof import("@wunk/.../types/.../X").X} */ (
//       Java.type("fully.qualified.X")
//     );
//
// After the cast, `new X(...)`, static methods, and `instanceof X` are all typed
// and checked — try giving `new Vec3(...)` the wrong number of args.

const script = registerScript({
    name: "TypedJavaJS",
    version: "0.1.0",
    authors: ["you"],
});

// 1) Cast the Java.type handle to the TYPED constructor from the @wunk types.
//    `import("…").Vec3` is a TS "import type" expression — valid inside JSDoc.
const Vec3 = /** @type {typeof import("@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3").Vec3} */ (
    Java.type("net.minecraft.world.phys.Vec3")
);

// 2) A packet class we'll narrow to with `instanceof` further down.
const MoveVehicle = /** @type {typeof import("@wunk/lb-script-api-types/types/net/minecraft/network/protocol/game/ServerboundMoveVehiclePacket").ServerboundMoveVehiclePacket} */ (
    Java.type("net.minecraft.network.protocol.game.ServerboundMoveVehiclePacket")
);

script.registerModule({
    name: "TypedJavaJS",
    category: "Misc",
    description: "Type Java.type(...) handles via JSDoc casts + instanceof narrowing.",
}, (mod) => {
    mod.on("enable", () => {
        const p = mc.player;
        if (!p) return;
        const pos = p.position();
        // `new Vec3(...)` is fully checked now — `.x/.y/.z` autocomplete, and a
        // wrong arg count would be flagged at edit time (not just at runtime).
        const above = new Vec3(pos.x, pos.y + 1, pos.z);
        Client.displayChatMessage(`§a[TypedJava] one block above you: ${above.x}, ${above.y}, ${above.z}`);
    });

    // 3) `instanceof` with a typed Java class narrows the value: inside the
    //    branch, `packet` is `ServerboundMoveVehiclePacket`, so its methods are
    //    typed (no cast needed there).
    mod.on("packet", (event) => {
        const packet = event.packet;
        if (packet instanceof MoveVehicle) {
            // `packet` is now ServerboundMoveVehiclePacket — `position()` is typed.
            const at = packet.position();
            Client.displayChatMessage(`§7[TypedJava] vehicle move → ${at.x.toFixed(1)}, ${at.z.toFixed(1)}`);
        }
    });
});
