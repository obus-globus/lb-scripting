// @ts-check
//
// jump-counter.js — counts how many times the player jumps in the current
// session and prints a running total in chat when the module is disabled.
//
// What this example shows that hello-world.js didn't:
//   • Module-local state: the counter lives in the closure of the
//     `registerModule` callback, so it persists between event handlers
//     without polluting any global.
//   • A `Setting.boolean` controlling per-enable behaviour.
//   • Three handlers cooperating: `enable` resets, `playerJump` increments,
//     `disable` reports — a tiny but realistic state machine.
//
// Prereqs: you have to be in a world and able to jump (so `mc.player` is
// non-null). Toggle the module on, jump a few times, toggle off.

const script = registerScript({
    name: "JumpCounterJS",
    version: "0.1.0",
    authors: ["you"],
});

const RESET_ON_ENABLE = Setting.boolean({
    name: "resetOnEnable",
    default: true,
});

script.registerModule({
    name: "JumpCounterJS",
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
        // Hover `ev` in your editor: it's PlayerJumpEvent, with motion + yaw.
        Client.displayChatMessage(
            `§7[JumpCounter] jump #${jumps} (vy=${ev.motion.toFixed(2)})`
        );
    });

    mod.on("disable", () => {
        Client.displayChatMessage(`§c[JumpCounter] total: ${jumps}`);
    });
});
