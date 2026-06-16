/// <reference types="@wunk/lb-script-api-types/ambient" />
//
// timed-pinger.ts — while enabled, sends a configurable chat message every N
// seconds using `AsyncUtil.ticks(...)` + `async`/`await`.
//
// What this starter showcases:
//   • An `async` event handler (the `enable` handler returns a promise).
//   • `await AsyncUtil.ticks(n)` to pause without blocking the game loop —
//     the "do something every N ticks" idiom in scripts.
//   • A closure "generation" counter set in `disable` to break the async
//     loop cleanly, so a stale loop from a previous enable doesn't keep
//     firing after the user toggles the module off.
//   • `Setting.text` + `Setting.int` (with a `range`) for live config.
//
// Prereqs: be in a world (or on a server) where chat is visible.
//
// SAFETY: this WILL send chat messages on a timer. Don't ship to a server
// that bans chat macros, and don't set the interval too low.

const script = registerScript({
    name: "TimedPingerTS",
    version: "0.1.0",
    authors: ["you"],
});

const MESSAGE = Setting.text({
    name: "message",
    default: "ping",
});

const INTERVAL_SECONDS = Setting.int({
    name: "intervalSeconds",
    default: 30,
    range: [5, 3600],
});

script.registerModule({
    name: "TimedPingerTS",
    category: "Misc",
    description: "Sends a chat message every N seconds while enabled.",
}, (mod) => {
    // Each enable creates a new generation; disable bumps it so any
    // still-suspended `await` loop notices it's stale and exits.
    let generation = 0;

    mod.on("enable", async () => {
        const myGen = ++generation;
        Client.displayChatMessage("§a[TimedPinger] started");

        while (generation === myGen) {
            // Minecraft runs at 20 ticks per second, so N seconds = N*20 ticks.
            await AsyncUtil.ticks(INTERVAL_SECONDS.get() * 20);
            // After the await resumes the user may have disabled (or
            // toggled-off-then-on) the module while we were sleeping — recheck
            // BEFORE sending, else a stale loop fires one extra message.
            if (generation !== myGen) break;
            NetworkUtil.sendChatMessage(MESSAGE.get());
        }
    });

    mod.on("disable", () => {
        generation++;
        Client.displayChatMessage("§c[TimedPinger] stopped");
    });
});
