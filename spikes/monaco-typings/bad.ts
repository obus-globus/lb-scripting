/// <reference types="@wunk/lb-script-api-types/ambient" />
// Same as good.ts but with deliberate type errors — the spike asserts the TS
// language service FLAGS these (i.e. diagnostics actually fire against the
// ambient globals + imported module types).
import { Vec3 } from "@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3";

const script = registerScript({
  name: "SpikeProbeBad",
  version: "0.1.0",
  authors: ["obus"],
});

script.registerModule(
  {
    name: "SpikeProbeBad",
    category: "Misc",
  },
  (mod) => {
    mod.on("playerJump", () => {
      const p = mc.player;
      if (p === null) return;
      const pos: Vec3 = p.position();
      // ERROR 1: Vec3.x is a number; .toUpperCase() is a string method.
      pos.x.toUpperCase();
      // ERROR 2: Client.displayChatMessage expects a string, not a number.
      Client.displayChatMessage(42);
      // ERROR 3: not a real event name.
      mod.on("totallyNotAnEvent", () => {});
    });
  },
);
