/// <reference types="@wunk/lb-script-api-types/ambient" />
// Representative LB script: ambient globals + an importable JVM-path module.
// Body is the known-good template main.ts, plus a typed import to exercise
// module resolution against the package.
import { Vec3 } from "@wunk/lb-script-api-types/types/net/minecraft/world/phys/Vec3";

const script = registerScript({
  name: "SpikeProbe",
  version: "0.1.0",
  authors: ["obus"],
});

const VERBOSE = Setting.boolean({ name: "verbose", default: false });

script.registerModule(
  {
    name: "SpikeProbe",
    category: "Misc",
    description: "Probe script for the Monaco typings spike.",
  },
  (mod) => {
    mod.on("playerJump", () => {
      const p = mc.player;
      if (p === null) return;
      const pos: Vec3 = p.position(); // importable module type must line up
      Client.displayChatMessage(`x=${pos.x.toFixed(2)}`);
      if (VERBOSE.get()) {
        Client.displayChatMessage(`yaw=${p.getVisualRotationYInDegrees().toFixed(1)}`);
      }
    });
  },
);
