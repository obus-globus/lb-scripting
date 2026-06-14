// Declarative, mixin-style injection.
//
// The starter (main.ts) wires hooks imperatively inside on("enable")/on("disable").
// A real mixin is just *declared*, not toggled by hand. `Inject.module(...)` gives
// you that: declare the hooks once as data, and the library applies them when the
// module enables and removes them when it disables.
//
// (For hooks that should stay active for the whole session — the closest thing to
// a statically-declared mixin — use `Inject.always("key", [...])` instead, with no
// module. See the lb-inject README.)

import { Inject } from "lb-inject";

const script = registerScript({ name: "MixinStyle", version: "1.0.0", authors: ["Obus"] });

const MC = "net.minecraft.client.Minecraft";
let ticks = 0;

script.registerModule(
  { name: "MixinStyle", category: "Misc", description: "Declarative (mixin-style) injection via Inject.module" },
  (mod) => {
    // Declared, not hand-wired. Two forms, both accepted:
    Inject.module(mod, [
      // tuple form — same arg order as Inject.inject(...)
      [MC, "tick", "RETURN", () => {
        if (++ticks % 200 === 0) Client.displayChatMessage(`§b[MixinStyle] ${ticks} ticks`);
      }],
      // object form — reads like a mixin @At
      { class: MC, method: "getFps", at: "HEAD", hook: () => { /* runs on every getFps() */ } },
      // a call-SITE hook needs `target`; the type enforces it for BEFORE_INVOKE
      { class: MC, method: "tick", at: "BEFORE_INVOKE", hook: () => {}, target: `${MC}.getFps` },
    ]);
    // No on("enable")/on("disable") here — Inject.module added them for us.
  },
);
