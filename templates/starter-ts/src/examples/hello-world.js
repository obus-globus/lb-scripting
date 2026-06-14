// @ts-check
//
// ↑ The `// @ts-check` directive above is optional. It opts THIS file
//   into type checking (the editor will flag typos and bad property
//   accesses, as if it were TypeScript) without changing the runtime
//   behaviour. Delete it to fall back to silent autocomplete-only.
//
// Plain JavaScript LiquidBounce script — with full editor support.
//
// No build step needed. Drop this file into your LiquidBounce scripts
// directory or `.script load src/examples/hello-world.js` directly.
//
// How the editor help works (no TypeScript knowledge required):
//
//   1. The template's `tsconfig.json` has
//        "allowJs": true,
//        "types": ["@wunk/lb-script-api-types/ambient"]
//      so every `.js` file under `src/` automatically sees the LB
//      ambient globals (`registerScript`, `mc`, `Client`, `Setting`, …)
//      with hover docs, autocomplete, and signature help.
//
//   2. `mod.on("…", ev => …)` is event-narrowed: hover the `ev`
//      parameter and you'll see the exact event type for that string.
//      Try replacing `"enable"` below with another event name and
//      auto-complete will pick from ~120 known events.

const script = registerScript({
    name: "HelloWorldJS",
    version: "0.1.0",
    authors: ["you"],
});

// Settings appear in LB's module config screen and persist between runs.
const PREFIX = Setting.text({
    name: "prefix",
    default: "Hello",
});

script.registerModule({
    name: "HelloWorldJS",
    category: "Misc",
    description: "Greets the player on enable; logs every jump.",
}, (mod) => {
    mod.on("enable", () => {
        const name = mc.player ? mc.player.getScoreboardName() : "World";
        Client.displayChatMessage(`§a[HelloWorldJS] ${PREFIX.get()}, ${name}!`);
    });

    mod.on("disable", () => {
        Client.displayChatMessage("§c[HelloWorldJS] disabled");
    });

    // Event narrowing in action: `ev` is `PlayerJumpEvent` here, so
    // `ev.motion` and `ev.yaw` autocomplete and type-check.
    mod.on("playerJump", (ev) => {
        Client.displayChatMessage(
            `§7[HelloWorldJS] jump motion=${ev.motion.toFixed(2)} yaw=${ev.yaw.toFixed(1)}`
        );
    });
});
