/// <reference types="@wunk/lb-script-api-types/ambient" />
//
// jump-counter.ts — counts how many times the player jumps in the current
// session and prints a running total in chat when the module is disabled.
//
// What this starter showcases:
//   • Module-local state: the counter lives in the closure of the
//     `registerModule` callback, so it persists between event handlers
//     without polluting any global.
//   • A `Setting.boolean` controlling per-enable behaviour.
//   • Three handlers cooperating: `enable` resets, `playerJump` increments,
//     `disable` reports — a tiny but realistic state machine.
//   • Event narrowing: hover `ev` in `playerJump` and it's `PlayerJumpEvent`,
//     with its `motion` / `yaw` fields typed end-to-end (no cast needed).
//
// Prereqs: be in a world and able to jump (so `mc.player` is non-null).
// Toggle the module on, jump a few times, toggle off.

const script = registerScript({
    name: "JumpCounterTS",
    version: "0.1.0",
    authors: ["you"],
});

const RESET_ON_ENABLE = Setting.boolean({
    name: "resetOnEnable",
    default: true,
});

script.registerModule({
    name: "JumpCounterTS",
    category: "Misc",
    description: "Counts jumps per enable; prints total on disable.",
}, (mod) => {
    let jumps = 0;

    mod.on("enable", () => {
        if (RESET_ON_ENABLE.get()) jumps = 0;
        Client.displayChatMessage(`§a[JumpCounter] watching… (current: ${jumps})`);
    });

    mod.on("playerJump", (ev) => {
        jumps++;
        // `ev` is PlayerJumpEvent — fully typed, with motion + yaw.
        Client.displayChatMessage(
            `§7[JumpCounter] jump #${jumps} (vy=${ev.motion.toFixed(2)})`
        );
    });

    mod.on("disable", () => {
        Client.displayChatMessage(`§c[JumpCounter] total: ${jumps}`);
    });
});
