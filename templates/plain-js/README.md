# lb-script-template-js

> [!IMPORTANT]
> **Superseded — use [`lb-script-template`](https://github.com/obus-globus/lb-script-template).**
> The plain-JavaScript, no-build path is a first-class part of the main starter:
> drop a `.js` in `src/`, add `// @ts-check`, and load it directly — you don't
> have to run the build or write any TypeScript. The main starter just *also*
> offers a build, multi-file bundling, hot-reload + a debugger, and opt-in
> bytecode injection if you ever want them. All of this repo's examples (incl.
> `boat-phase.js`) live there.
>
> This repo is kept for reference but no longer developed.

---

A **minimal, plain-JavaScript** starting point for a [LiquidBounce](https://liquidbounce.net)
(nextgen, Minecraft 1.21+) script. **No build step, no TypeScript** — just write a
`.js` file and load it into the client. You still get full editor support
(autocomplete, hover docs, typed events) from
[`@wunk/lb-script-api-types`](https://www.npmjs.com/package/@wunk/lb-script-api-types).

---

## Quick start

```bash
git clone <this-repo> my-script && cd my-script
npm install     # pulls the types so the editor can autocomplete (no build, no tooling at runtime)
```

Open the folder in your editor and edit `src/main.js`. You'll get autocomplete
for `registerScript`, `mc`, `Client`, `Setting`, and typed
`on("<event>", e => …)` handlers right away.

Load it into LiquidBounce — the `.js` file **is** the script, no build:

```
.script load <path>/src/main.js
```

(or drop the file into your LiquidBounce `scripts/` directory and reload).

---

## How the editor help works

`jsconfig.json` points TypeScript's language service (the one your editor already
uses for JS) at the ambient script globals:

```jsonc
"types": ["@wunk/lb-script-api-types/ambient"]
```

So every `.js` under `src/` sees the LB globals with autocomplete and hover docs —
**without** compiling anything.

Add `// @ts-check` at the top of a file to opt it into full type-checking (typos
and bad property accesses get flagged as you type).

One runtime rule worth knowing: the ambient class globals (`Hand`, `Mth`,
`BlockPos`, `Vec3i`, `RotationAxis`, ...) are raw `java.lang.Class` values —
construct directly (`new Vec3i(1, 2, 3)`), but statics **including enum
constants** are only reachable via `.static` (`Hand.static.MAIN_HAND`,
`Mth.static.clamp(...)`). Direct `Hand.MAIN_HAND` is `undefined` at runtime;
types `>= 0.38.3` model this, so autocomplete steers you right. A
`Java.type("...")` handle exposes statics directly instead. And with the
`registry-lb` entry in `jsconfig.json` (enabled in this template),
`Java.type("net.ccbluex...")` is **fully typed from the string alone** —
autocomplete on the class name, typed statics on the result. Leave it off for
autocomplete-only. Run the checker for all `// @ts-check` files with:

```bash
npm run typecheck
```

---

## Layout

```
src/
  main.js            your script (starter — a tiny module)
  examples/          small plain-JS examples (hello-world, jump-counter, …)
jsconfig.json        wires the types in for the editor
package.json         the only dependency is the types package
```

## Examples

Under `src/examples/` (each is a standalone, `// @ts-check`-clean script):

```
hello-world.js   the basics — registerScript / registerModule / a Setting
jump-counter.js  module-local state across enable / playerJump / disable
nearest-mob.js   querying the world for entities
timed-pinger.js  a repeating timer
boat-phase.js    a real community script (ported) that drops into raw Minecraft
                 classes via Java.type(...) — packets, the boat Entity, key
                 state. Shows what the checker does and doesn't see, and how a
                 legacy (Yarn-mapped) script maps onto nextgen's Mojang names.
```

---

That's it. The types come from `@wunk/lb-script-api-types` on npm; `^0.38.1`
tracks the LiquidBounce 0.38 line (bump it for a newer LB build). The types are
derived from LiquidBounce and are licensed GPL-3.0-or-later.
