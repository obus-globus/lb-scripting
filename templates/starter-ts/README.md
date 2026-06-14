# lb-script-template

A ready-to-go starting point for writing a [LiquidBounce](https://liquidbounce.net)
(nextgen, Minecraft 1.21+) script, with **full TypeScript types** for the GraalJS
script API: autocomplete, hover docs, typed event handlers, and type-checked
settings.

It scales from a one-file `.js` you load directly all the way up to a
multi-file TypeScript project with hot-reload, a debugger, and (opt-in) runtime
**bytecode injection** — paying for each capability only when you use it.

What you get:

- **Plain JavaScript** — zero build, just write a `.js` and load it.
- **TypeScript** — compiled to one self-contained `.mjs` per script by a
  one-command [esbuild](https://esbuild.github.io) build.
- **Multi-file scripts** — split across as many files as you like; local
  `import`s are bundled into a single deployable file.
- **Hot-reload + debugger** (`npm run dev`) — edit, auto-reload in the live
  client, set breakpoints in your original TypeScript.
- **Bytecode injection** (opt-in) — mixin-style runtime hooks via
  [lb-inject](https://github.com/obus-globus/lb-inject), fully typed. A script
  that doesn't ask for it pulls in none of it.

---

## Quick start

```bash
git clone <this-repo> my-script && cd my-script
npm install            # @wunk/lb-script-api-types types + esbuild + TypeScript
npm run build          # bundles src/ entries -> dist/*.mjs
```

Then open the folder in your editor (VS Code, etc.) and edit `src/main.ts` —
you'll get autocomplete for `registerScript`, `mc`, `Client`, `Setting`, and
typed `on("<event>", e => …)` handlers immediately.

Load the built file into LiquidBounce:

```
.script load <path>/dist/main.mjs
```

(or drop it into your LiquidBounce `scripts/` directory and reload).

---

## Two ways to write a script

### 1. Plain JavaScript — zero build

Drop a `.js` file in `src/`, add `// @ts-check` at the top if you want the
editor to type-check it, and load it directly into LiquidBounce. No transpile
needed. See [`src/examples/hello-world.js`](src/examples/hello-world.js) for the
basics, and [`src/examples/boat-phase.js`](src/examples/boat-phase.js) for a
real-world community script (raw `Java.type(...)` packet sending, fully
`@ts-check`ed).

```js
// @ts-check
const script = registerScript({ name: "Hi", version: "0.1.0", authors: ["you"] });
script.registerModule({ name: "Hi", category: "Misc" }, (mod) => {
  mod.on("enable", () => Client.displayChatMessage("§ahello"));
  mod.on("playerJump", (e) => Client.displayChatMessage(`jump y=${e.motion.y}`));
});
```

The ambient globals and the per-event `on()` types come from the
`@wunk/lb-script-api-types` package — wired up by the `"types"` field in
`tsconfig.json`, so every file under `src/` sees them.

### 2. TypeScript — build to JS

Write `.ts` under `src/`, then `npm run build` (or `npm run watch`). Each
**entry** (any file that calls `registerScript`) is bundled by esbuild into one
self-contained `dist/**/*.mjs` (ES2022, inline source maps so DevTools shows
your original TypeScript). The build also rewrites **JVM type imports** into
GraalJS `Java.type(...)` calls:

```ts
import { Mth } from "@wunk/lb-script-api-types/types/net/minecraft/util/Mth";
// ... after build: const Mth = Java.type("net.minecraft.util.Mth");
```

So you get a real, typed handle on any JVM class while staying type-checked.
See [`src/examples/explicit-imports.ts`](src/examples/explicit-imports.ts).
(`import type { … }` is erased by TypeScript; only **value** imports become
`Java.type` calls.)

---

## Multi-file scripts

Split a script across as many files as you want and `import` between them — the
build bundles each entry into one self-contained `.mjs`, inlining your local
imports. No runtime module resolution, still **one file to deploy**.

- An **entry** is any file that calls `registerScript(...)` — it becomes a
  loadable `dist/…/*.mjs`.
- Any other file is a **shared module**: inlined into the entries that import
  it, and *never* emitted on its own.

```ts
// src/lib/format.ts — shared module (no registerScript)
export function fmtPos(x: number, y: number, z: number): string {
  return `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`;
}

// src/main.ts — entry
import { fmtPos } from "./lib/format";          // inlined into dist/main.mjs at build
registerScript({ name: "Hi", version: "0.1.0", authors: ["you"] });
```

Relative imports need no file extension — the bundler resolves them. See the
worked example in [`src/examples/multi-file/`](src/examples/multi-file/).

---

## Dev: hot-reload + debugger (`npm run dev`)

Edit `.ts` → it rebuilds, **auto-reloads in the live client**, and (optionally)
exposes the **GraalJS debugger** so you can set breakpoints in your original
TypeScript. Self-contained — it uses LiquidBounce's own `ScriptManager` +
`ScriptDebugOptions`; no extra services, no REPL.

**One-time setup**
1. Load the companion once: copy `host-scripts/dev-reload.js` into your
   `<LiquidBounce>/scripts/` and `.script reload` (it prints `[dev-reload]
   watching …`). It watches a trigger file and reloads *your* script — leave it
   loaded.
2. Tell the build where the client loads scripts — copy
   `lbdev.config.example.json` to **`lbdev.config.json`** (gitignored; it holds
   your local path) and set `scriptsDir`:
   ```json
   { "scriptsDir": "/home/you/.minecraft/LiquidBounce/scripts", "entry": "main.mjs", "debug": "inspect:9229" }
   ```
   Then run it from your project folder (which can live anywhere — it doesn't
   have to be inside the scripts folder):
   ```bash
   npm run dev
   ```

Now every save rebuilds `main.mjs`, copies it next to the client, and bumps the
trigger; `dev-reload.js` swaps the script on the game thread (unloads the old,
loads the new). You'll see `[dev-reload] reloaded main.mjs` in chat.

Env vars `LB_SCRIPTS_DIR` / `LB_ENTRY` / `LB_DEBUG` override the config for a
one-off run (precedence: env > `lbdev.config.json` > default).

**Debugger.** `debug` (default `inspect:9229`) makes `dev-reload` load your
script with the GraalJS inspector on that port — the client logs
`Debugger listening on ws://127.0.0.1:9229/main.mjs`. The build emits inline
source maps, so breakpoints land in your `.ts`. Attach with either:
- **VS Code** — the bundled `.vscode/launch.json` ("Attach to LiquidBounce
  script (GraalJS inspect)"); or
- **Chrome** — open the `devtools://…?ws=127.0.0.1:9229/main.mjs` URL the client prints.

Breakpoints, stepping, and local-variable inspection work in code that runs on
the game thread — i.e. your **event handlers** (`mod.on("playerTick", …)` etc.),
which is where script logic lives. (Code running on a background thread you
spawned yourself isn't paused by the inspector.)

Set `debug` to `off` to skip the debugger, `dap:<port>` for the Debug Adapter
Protocol, or `entry` to a different `<file>.mjs` (these also have `LB_DEBUG` /
`LB_ENTRY` env equivalents).

**Multiple scripts / dev envs at once.** Several projects can hot-reload in the
*same* client simultaneously — each `npm run dev` writes its own
`.dev-reload/<entry>.json`, and `dev-reload.js` reloads each independently.
Just give each a distinct `entry` and a distinct debugger `port`:
```json
// project A — lbdev.config.json          // project B — lbdev.config.json
{ "scriptsDir": "…/scripts",              { "scriptsDir": "…/scripts",
  "entry": "kill-aura.mjs",                 "entry": "esp.mjs",
  "debug": "inspect:9229" }                 "debug": "inspect:9230" }
```
Both reload in the one client; attach a separate debugger to each port.

> Caveat: a reload re-registers your modules, so their **toggle state resets**
> (you re-enable after editing). Newly *added* modules show up on the next reload.

---

## Advanced (opt-in): bytecode injection

For the advanced case — patching already-loaded JVM methods at runtime with
mixin-style hooks (`HEAD` / `RETURN` / `INVOKE` / `FIELD`) — this template ships
typed access to **[lb-inject](https://github.com/obus-globus/lb-inject)**. It's
**entirely opt-in**: a script pulls it in only by importing it, so a normal
script carries none of the machinery.

```ts
import { Inject } from "lb-inject";   // ← this one import opts you in

// HEAD / RETURN — patch a whole method (4 args):
const h = Inject.inject("net.minecraft.client.Minecraft", "getFps", "HEAD",
  () => Client.displayChatMessage("getFps!"));

// INVOKE / FIELD — patch a call/field SITE inside a method (5th arg required;
// the compiler enforces it):
Inject.inject("net.minecraft.client.Minecraft", "tick", "BEFORE_INVOKE",
  () => {}, "net.minecraft.client.Minecraft.getFps");

Inject.remove(h);  Inject.list();  Inject.removeAll();
```

The typed `Inject` ([`types/lb-inject.d.ts`](types/lb-inject.d.ts)) enforces the
call contract the JS library can only check at runtime: `position` is a closed
union (no `"HAED"` typos); `*_INVOKE`/`*_FIELD` *require* the 5th `target` while
`HEAD`/`RETURN` *forbid* it; handles are branded so `remove()` won't take a
stray string. There's also a declarative, module-bound form
(`Inject.module(mod, [...])` — applied on enable, removed on disable) and a
typed-target facade that checks method names against the real JVM class.

**Examples** live in [`src/examples/inject/`](src/examples/inject/):
`inject-demo` (toggleable module), `always-on`, `mixin-style` (declarative),
`typed-targets` (method names checked vs the JVM type). The roadmap for deeper
type integration is in [`docs/inject-ideas.md`](docs/inject-ideas.md).

**Deploying an inject script — two options:**

- **Default** (`npm run build`): the entry gets a tiny loader that `load()`s the
  shared library at runtime. Deploy **two files** — your `dist/main.mjs` and
  `vendor/lib/nf-inject-bundled-1.1.0.js` into `<LiquidBounce>/scripts/lib/`.
  Several inject scripts can share the one library copy.
- **Single file** (`npm run build:bundle`): the library is inlined into the
  entry — deploy just `dist/main.mjs`.
  > The library's agent jars still self-extract to `scripts/lib/nf-inject-<ver>/`
  > on first run — bytecode injection needs a real `Instrumentation`, and a JVM
  > agent can't run from inside a JS string. "Bundled" means *one file to
  > deploy*, not *zero files on disk*.

Either way, injection needs instrumentation — a `-javaagent:…/nf-inject-agent.jar`
at launch (any JRE) or a JDK runtime like GraalVM (self-attaches). See the
[lb-inject README](https://github.com/obus-globus/lb-inject).

**Don't need it?** Delete `src/examples/inject/`, `vendor/`,
`types/lb-inject.d.ts`, and `docs/inject-ideas.md` — nothing else references
them.

---

## Layout

```
src/                 your scripts (.ts and/or .js)
  main.ts            the starter — a tiny "JumpLogger" module
  examples/          small, focused examples (clicker, pinger, imports, …)
    multi-file/      a script split across files (bundled into one .mjs)
    inject/          opt-in bytecode-injection examples (lb-inject)
scripts/
  build.mjs          the build (esbuild bundle + JVM-import + lb-inject plugins + --dev deploy)
  setup-references.mjs  clone LB + decompile MC into references/ (npm run setup:references)
host-scripts/
  dev-reload.js      load this in the client once for `npm run dev` hot-reload
types/
  lb-inject.d.ts     typed `Inject` module (only needed if you use injection)
vendor/lib/          the runnable lb-inject library (only needed if you use injection)
lbdev.config.example.json  copy to lbdev.config.json (gitignored) for `npm run dev`
.vscode/            launch.json (debugger) + recommended extensions/settings
.editorconfig        editor-agnostic formatting rules
tsconfig.json        wires the types in; strict mode; allowJs
dist/                build output (gitignored)
references/          optional decompiled LB+MC sources (gitignored)
```

Scripts: `npm run build` · `npm run build:bundle` (inline the inject library) ·
`npm run watch` · `npm run dev` (watch + hot-reload + debug) · `npm run typecheck`
(`tsc --noEmit`) · `npm run setup:references` (decompiled MC/LB sources) ·
`npm run clean`.

---

## Source navigation: decompiled MC + LB (`npm run setup:references`)

The types tell you a class's *shape*; sometimes you need its *behavior*. This
optional task clones LiquidBounce and uses its own Gradle build to **decompile
Minecraft**, so "go to definition" on a `Java.type("…")` handle can land in real
source.

```bash
npm run setup:references            # clone LB + decompile MC into references/
LB_REF=<branch|tag|sha> npm run setup:references   # pin a specific LB ref
npm run setup:references -- --no-decompile          # clone only (skip the slow part)
```

It clones into `references/liquidbounce` (gitignored) and runs Loom's
`genSources`. Open that folder in your IDE and let it import the Gradle project.

> **Heavy + opt-in.** A fresh run downloads hundreds of MB and the decompile
> takes several minutes — it is *not* part of `npm install`. Needs `git` and a
> JDK matching LiquidBounce's toolchain (currently **JDK 25**; set `JAVA_HOME` if
> the JDK on your PATH isn't it). Pick an `LB_REF` matching your installed types
> line. `references/` is local-only — never commit decompiled Minecraft.

## About the types

The script-API types come from **[`@wunk/lb-script-api-types`](https://www.npmjs.com/package/@wunk/lb-script-api-types)**
on npm — a regular `devDependency`. The version tracks the LiquidBounce release
line: `^0.38.0` resolves to the newest types for LB 0.38.x, and the dist-tag
`@wunk/lb-script-api-types@lb-0.38` points at the same. Bump it when you move to
a newer LB build.

### Class bindings: statics live behind `.static`

The ambient class-value globals (`Hand`, `Mth`, `BlockPos`, `Vec3i`,
`RotationAxis`, ...) are raw `java.lang.Class` values at runtime. They
construct directly — `new Vec3i(1, 2, 3)` — but their **statics, including
enum constants, are only reachable via `.static`**:

```ts
InteractionUtil.useItem(Hand.static.MAIN_HAND);   // ✓
Mth.static.clamp(x, 0, 20);                       // ✓
Hand.MAIN_HAND;                                   // ✗ compiles on old types, undefined at runtime
```

This is the verified live behaviour (GraalJS nashorn-compat), and types
`>= 0.38.3` model it — direct static access is now a compile error. A
`Java.type(...)` handle (or a build-rewritten explicit import, see
`src/examples/explicit-imports.ts`) is a *host symbol* instead and exposes
statics directly: `Java.type("net.minecraft.util.Mth").clamp(...)`. Pick
whichever style you prefer; the types are accurate for both.

The types are derived from LiquidBounce and are licensed GPL-3.0-or-later.
