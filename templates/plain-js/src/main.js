// @ts-check
//
// Your script. This is plain JavaScript — no build step. Edit it, then load it
// into LiquidBounce directly:
//
//   .script load <path-to-this-file>/src/main.js
//
// (or drop it into your LiquidBounce `scripts/` directory and reload.)
//
// The `// @ts-check` line at the top opts THIS file into editor type-checking,
// so typos and bad property accesses get flagged as you type — without changing
// how it runs. Delete that line for autocomplete-only.
//
// Where the editor help comes from: `jsconfig.json` pulls in the ambient script
// globals from `@wunk/lb-script-api-types`, so `registerScript`, `mc`, `Client`,
// `Setting`, and the typed `on("<event>", …)` handlers all autocomplete.

const script = registerScript({
    name: "MyScript",
    version: "0.1.0",
    authors: ["you"],
});

// Settings show up in the module's config screen and persist between runs.
const GREETING = Setting.text({
    name: "greeting",
    default: "Hello",
});

script.registerModule({
    name: "MyScript",
    category: "Misc",
    description: "A tiny starter module — greets on enable, logs jumps.",
}, (mod) => {
    mod.on("enable", () => {
        const name = mc.player ? mc.player.getScoreboardName() : "World";
        Client.displayChatMessage(`§a[MyScript] ${GREETING.get()}, ${name}!`);
    });

    mod.on("disable", () => {
        Client.displayChatMessage("§c[MyScript] disabled");
    });

    // `ev` is typed as PlayerJumpEvent here — `ev.motion` / `ev.yaw` autocomplete.
    mod.on("playerJump", (ev) => {
        Client.displayChatMessage(
            `§7[MyScript] jump motion=${ev.motion.toFixed(2)} yaw=${ev.yaw.toFixed(1)}`
        );
    });
});
