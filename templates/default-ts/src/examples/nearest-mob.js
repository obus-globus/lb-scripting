// @ts-check
//
// nearest-mob.js — every N ticks, prints the nearest entity to the player
// along with its distance.
//
// What this example shows:
//   • `Setting.float` with a `range:` for a continuous slider.
//   • `Setting.int` for the tick interval (throttling).
//   • Iterating world entities via `mc.level.entitiesForRendering()` and
//     filtering manually. (Aside: `Level.getEntities(except, AABB, filter)`
//     exists on the base `Level` class, but `mc.level` is typed as
//     `ClientLevel` which redeclares `getEntities` with a 0-arg form —
//     so the 3-arg overload is invisible to the type checker. Hence
//     this iterate-and-filter pattern.)
//   • Vector math against `mc.player.position()` (a Vec3 from the
//     scripting API surface). We compare squared distances inside the
//     loop and only call `Math.sqrt` once at the end — standard trick
//     to avoid 100s of square roots per scan.
//   • A simple tick-counter throttle so we don't spam chat every tick.
//
// Prereqs: be in a world with mobs nearby. The example reports any
// entity (you included if you don't filter yourself out — see the
// `e === mc.player` guard).

const script = registerScript({
    name: "NearestMobJS",
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
    name: "NearestMobJS",
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

        let nearest = null;
        let bestDistSq = range * range;

        for (const e of mc.level.entitiesForRendering()) {
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
