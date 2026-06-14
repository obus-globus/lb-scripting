// Multi-file example — the entry. It calls registerScript(), so the build emits
// it as a loadable dist/examples/multi-file/main.mjs. Its `./lib/format` import
// is INLINED into that one file by esbuild — nothing else to deploy.
//
// Build it like any other script (`npm run build`); load the single produced
// .mjs. Relative imports need no file extension — the bundler resolves them.

import { fmtPos, ORIGIN } from "./lib/format";

const script = registerScript({ name: "MultiFileDemo", version: "0.1.0", authors: ["you"] });

script.registerModule({
    name: "MultiFileDemo",
    category: "Misc",
    description: "Demonstrates splitting a script across files (bundled into one .mjs).",
}, (mod) => {
    mod.on("enable", () => {
        Client.displayChatMessage(`§a[MultiFileDemo] enabled — helper from ${ORIGIN}`);
    });

    mod.on("playerJump", () => {
        const p = mc.player;
        if (p === null) return;
        const pos = p.position();
        Client.displayChatMessage(`§e[MultiFileDemo] jumped at ${fmtPos(pos.x, pos.y, pos.z)}`);
    });
});
