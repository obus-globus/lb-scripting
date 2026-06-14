// lb-inject "always-on" example (TypeScript port of inject-always-on.js).
//
// Installs its hooks at load time and keeps them active for the whole session.
// Registers NO module — there's nothing to toggle. Build with `npm run build`
// and load dist/examples/always-on.mjs into LiquidBounce.

import { Inject } from "lb-inject";

// A script must still call registerScript(...) even with no module.
registerScript({ name: "InjectAlwaysOn", version: "1.0.0", authors: ["Obus"] });

const System_ = Java.type("java.lang.System");

// Idempotency guard: `.script reload` re-runs scripts, which would stack
// duplicate injections. A bootstrap System property (visible across script
// contexts), namespaced by library version, installs at most once per session.
const SENTINEL = "nf.alwayson.installed." + Inject.VERSION;
if (System_.getProperty(SENTINEL) === null) {
  try {
    let ticks = 0;
    // Minecraft.tick fires continuously (even at the main menu) → genuinely
    // always-on. Heartbeat roughly once a minute.
    Inject.inject("net.minecraft.client.Minecraft", "tick", "RETURN", () => {
      if (++ticks % 1200 === 0) {
        Client.displayChatMessage(`§b[InjectAlwaysOn] tick hook alive — ${ticks} ticks`);
      }
    });
    System_.setProperty(SENTINEL, "true");
    Client.displayChatMessage("§a[InjectAlwaysOn] hook installed (active for the whole session)");
  } catch (e) {
    Client.displayChatMessage("§c[InjectAlwaysOn] failed to install: " + e);
  }
} else {
  Client.displayChatMessage("§e[InjectAlwaysOn] already installed this session — skipping re-inject");
}
