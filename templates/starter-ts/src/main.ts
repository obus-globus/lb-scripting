/// <reference types="@wunk/lb-script-api-types/ambient" />
//
// Starter script for the liquidbounce-script-starter template.
//
// What this does:
//   - Registers a module called "JumpLogger" under the Misc category.
//   - Every time the player jumps, logs their position and velocity Y to chat.
//
// It's intentionally tiny and safe: no combat, no packet manipulation, no
// rotation spoofing. Enable it in-game with `.t JumpLogger` after you've
// built and loaded the script.
//
// Patterns demonstrated:
//   - `registerScript(…)` + `script.registerModule(…)` — the two entry
//     points every LB script uses.
//   - Ambient globals (`registerScript`, `Client`, `Setting`) come from
//     the reference at the top of this file.
//   - Settings: a single boolean toggle, shown as an enable/disable panel
//     under the module's UI in the clickgui.
//   - Event narrowing: `mod.on("playerJump", (ev) => …)` is typed
//     end-to-end via the ScriptModule augmentation — `ev` is
//     `PlayerJumpEvent` with its `motion` / `yaw` fields directly
//     available to autocomplete. No casts needed. (Older versions of
//     this template required a `TypedMod` cast; that's gone now.)
//

const script = registerScript({
    name: "JumpLogger",
    version: "0.1.0",
    authors: ["you"],
});

const VERBOSE = Setting.boolean({
    name: "verbose",
    default: false,
});

script.registerModule({
    name: "JumpLogger",
    category: "Misc",
    description: "Logs the player's position each time they jump.",
}, (mod) => {
    mod.on("enable", () => {
        Client.displayChatMessage("§a[JumpLogger] enabled");
    });

    mod.on("playerJump", () => {
        const p = mc.player;
        if (p === null) return;
        const pos = p.position();
        const msg = `§e[JumpLogger] jumped at x=${pos.x.toFixed(2)} y=${pos.y.toFixed(2)} z=${pos.z.toFixed(2)}`;
        Client.displayChatMessage(msg);
        if (VERBOSE.get()) {
            Client.displayChatMessage(`§7  yaw=${p.getVisualRotationYInDegrees().toFixed(1)}`);
        }
    });

    mod.on("disable", () => {
        Client.displayChatMessage("§c[JumpLogger] disabled");
    });
});
