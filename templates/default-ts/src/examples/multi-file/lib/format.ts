// A shared module: it does NOT call registerScript(), so the build treats it as
// a library — it's inlined into whichever entry imports it and never emitted as
// its own dist file. Split a script across as many of these as you like.

/** Format a Vec3-ish position as a short "x, y, z" string. */
export function fmtPos(x: number, y: number, z: number): string {
    return `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`;
}

/** A tiny tag so you can see this came from the shared module after bundling. */
export const ORIGIN = "format.ts";
