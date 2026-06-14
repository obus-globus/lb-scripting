/// <reference types="@wunk/lb-script-api-types/ambient" />
//
// nearest-mob.ts — every N ticks, prints the nearest entity to the player and
// its distance.
//
// What this starter showcases:
//   • `Setting.float` with a `range:` for a continuous slider, and
//     `Setting.int` for the tick interval (throttling).
//   • Iterating world entities via `mc.level.entitiesForRendering()` and
//     filtering manually.
//   • A neat TS trick to type the loop's "best so far" without naming the
//     entity class: take the element type of the (typed) entity list, so
//     `nearest` is `Entity | null` and its methods are checked.
//   • Squared-distance comparison inside the loop (only one `Math.sqrt` at
//     the end) and a tick-counter throttle so we don't spam chat.
//
// Prereqs: be in a world with mobs nearby.

const script = registerScript({
    name: "NearestMobTS",
    version: "0.1.0",
    authors: ["you"],
});

const RANGE = Setting.float({
    name: "range",
    default: 16.0,
    range: [4.0, 64.0],
});

const INTERVAL_TICKS = Setting.int({
    name: "intervalTicks",
    default: 20, // once per second at 20 TPS
    range: [5, 200],
});

script.registerModule({
    name: "NearestMobTS",
    category: "Misc",
    description: "Prints the nearest entity and its distance periodically.",
}, (mod) => {
    let ticks = 0;

    mod.on("playerTick", () => {
        if (!mc.player) return;
        ticks++;
        if (ticks % INTERVAL_TICKS.get() !== 0) return;

        const me = mc.player;
        const myPos = me.position();
        const myId = me.getId();
        const range = RANGE.get();

        // Materialise the iterable so we can name its element type below.
        const entities = [...mc.level.entitiesForRendering()];
        // `nearest` is the element type (an Entity) or null — fully typed.
        let nearest: (typeof entities)[number] | null = null;
        let bestDistSq = range * range;

        for (const e of entities) {
            if (e.getId() === myId) continue;
            const p = e.position();
            const dx = myPos.x - p.x;
            const dy = myPos.y - p.y;
            const dz = myPos.z - p.z;
            const dSq = dx * dx + dy * dy + dz * dz;
            if (dSq < bestDistSq) {
                bestDistSq = dSq;
                nearest = e;
            }
        }

        if (nearest) {
            const dist = Math.sqrt(bestDistSq);
            const name = nearest.getName().getString();
            Client.displayChatMessage(
                `§b[NearestMob] ${name} @ ${dist.toFixed(2)} blocks`
            );
        }
    });
});
