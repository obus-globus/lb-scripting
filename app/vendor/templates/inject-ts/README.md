# lb-inject-template

> [!IMPORTANT]
> **Superseded — use [`lb-script-template`](https://github.com/obus-globus/lb-script-template).**
> Bytecode injection is now folded into the main starter as an **opt-in** layer:
> the same typed `Inject` API, vendored library, and examples live there, on top
> of the same esbuild multi-file build — plus hot-reload + a debugger this repo
> never had. A script pulls injection in only by `import { Inject } from "lb-inject"`,
> so normal scripts carry none of it.
>
> Start there: clone `lb-script-template`, then see its **"Advanced (opt-in):
> bytecode injection"** section and `src/examples/inject/`. This repo is kept for
> reference but no longer developed.

---

A **TypeScript** starter for [LiquidBounce](https://liquidbounce.net) (nextgen,
MC 1.21+) scripts that use **[lb-inject](https://github.com/obus-globus/lb-inject)**
— runtime, mixin-style **bytecode injection** (`HEAD` / `RETURN` / `INVOKE` /
`FIELD` hooks) — fully typed against
[`@wunk/lb-script-api-types`](https://www.npmjs.com/package/@wunk/lb-script-api-types).

Where [`lb-script-template`](https://github.com/obus-globus/lb-script-template)
covers the *normal* script API, this one is for the advanced case: patching
already-loaded JVM methods at runtime, with the compiler checking your hooks.

---

## What you get from TypeScript here

The lb-inject library is plain JS — its whole surface is one runtime global,
`Inject`. This template ships a typed declaration for it
([`types/lb-inject.d.ts`](types/lb-inject.d.ts)) so you get:

- **Autocomplete + docs** on `Inject.inject / remove / list / removeAll / …`.
- **Position safety** — `position` is a closed union; no `"HAED"` typos.
- **Call-contract enforcement** — the `*_INVOKE` / `*_FIELD` positions *require*
  the 5th `target` argument; `HEAD` / `RETURN` *forbid* it. This is the one rule
  the JS library can only check at runtime — here it's a compile error.
- **Branded handles** — `Inject.remove(...)` won't accept a stray string.
- **Typed injection targets** — [`src/examples/typed-targets.ts`](src/examples/typed-targets.ts)
  builds a thin facade that checks the *method name* against the real JVM class
  type, so `injectHead<Minecraft>("…", "getFps", …)` autocompletes and a typo is
  a red squiggle, not a runtime surprise.

---

## Quick start

```bash
git clone <this-repo> my-inject-script && cd my-inject-script
npm install          # @wunk/lb-script-api-types + typescript
npm run build        # bundle src/ entries -> dist/*.mjs (esbuild)
```

Then deploy — **two options**:

### Option A — script + library side-by-side (default)

Your built script `load()`s the library at runtime. Deploy **two files**:

```
scripts/
  main.mjs                          # from dist/        (your built script)
  lib/
    nf-inject-bundled-1.1.0.js      # from vendor/lib/  (the injection library)
```

```
.script load <path>/scripts/main.mjs
```

A script opts in with `import { Inject } from "lb-inject"`; the build replaces
that import with a tiny loader that finds and `load()`s the library from `lib/`
— **your `src/` never contains any loading code.** Update the library
independently (drop in a newer `nf-inject-*.js`), and several scripts can share
the one copy in `lib/`.

### Option B — single self-contained file

```bash
npm run build:bundle    # the library is inlined INTO each dist/*.mjs
```

`dist/main.mjs` now has the library bundled in — deploy just that **one file**:

```
scripts/
  main.mjs        # from dist/  — that's it
```

> **Caveat — the agent jars still land on disk.** Bytecode injection needs a
> real `Instrumentation`, and a JVM agent **cannot** run from inside a JS
> string. So even the self-contained file self-extracts its two embedded jars to
> `scripts/lib/nf-inject-1.1.0/` on first run. "Bundled" means *one file to
> deploy*, not *zero files on disk*.

Same `src/`, one flag: `import { Inject } from "lb-inject"` resolves to a loader
(default) or to the whole library (`--bundle`), and esbuild bundles that in
along with your own modules. `Inject` is defined before your code runs — you
write none of the wiring, and each entry is a single `dist/*.mjs` either way.

### Either way: instrumentation

Auto-detected by the library: a `-javaagent:…/nf-inject-agent.jar` at launch
(works on **any JRE**) or a JDK runtime like **GraalVM** (self-attaches at
runtime, no flag). If neither is available, `Inject.inject(...)` throws with
guidance. See the [lb-inject README](https://github.com/obus-globus/lb-inject).

---

## Writing a hook

One import wires the library in — no loading boilerplate. The build recognises
`import … from "lb-inject"`, strips it, and prepends the loader (or, with
`--bundle`, the whole library), so `Inject` is ready at runtime.

```ts
import { Inject } from "lb-inject";

// HEAD / RETURN — patch a whole method (4 args):
const h = Inject.inject("net.minecraft.client.Minecraft", "getFps", "HEAD",
  () => Client.displayChatMessage("getFps!"));

// INVOKE / FIELD — patch a call/field SITE inside a method (5th arg required;
// the compiler enforces it):
Inject.inject("net.minecraft.client.Minecraft", "tick", "BEFORE_INVOKE",
  () => {}, "net.minecraft.client.Minecraft.getFps");

Inject.remove(h);  Inject.list();  Inject.removeAll();
```

A hook is a JS `() => void` (runs on the patched method's thread — safe for
client/render-thread points) or a precompiled `java.lang.Runnable` (for points
that fire on other threads).

### Declarative (mixin-style)

`inject`/`remove` are imperative. To **declare** hooks like a mixin instead of
hand-wiring `enable`/`disable`, use `Inject.module(mod, [...])` — applied on
enable, removed on disable, automatically:

```ts
Inject.module(mod, [
  ["net.minecraft.client.Minecraft", "tick", "RETURN", () => {/* … */}],
  { class: "net.minecraft.client.Minecraft", method: "getFps", at: "HEAD", hook: () => {/* … */} },
]);
```

…or `Inject.always("key", [...])` for session-persistent hooks (no module). The
decl types enforce the same `target`-for-`*_INVOKE`/`*_FIELD` rule. See
[`src/examples/mixin-style.ts`](src/examples/mixin-style.ts).

---

## Layout

```
src/
  main.ts                  starter — a toggleable "InjectDemo" module
  examples/
    always-on.ts           hooks installed at load, active all session
    mixin-style.ts         declarative Inject.module(mod, [...]) — declare, don't toggle
    typed-targets.ts       typed facade: method names checked vs the JVM type
  (split a script across as many files as you like — see "Multi-file" below)
types/
  lb-inject.d.ts           the typed `Inject` module (the library, in TS)
scripts/
  build.mjs                esbuild bundle: src/ entry -> one dist/*.mjs
vendor/lib/
  nf-inject-bundled-1.1.0.js   the runnable injection library (deploy this)
```

Scripts: `npm run build` · `npm run build:bundle` (single-file) · `npm run watch`
· `npm run typecheck` · `npm run clean`.

## Multi-file scripts

Split a script across as many files as you want and `import` between them — the
build (esbuild) **bundles each entry into one self-contained `.mjs`**, inlining
your local imports. No runtime module resolution, still one file to deploy.

- An **entry** is any file that calls `registerScript(...)` — it becomes a
  loadable `dist/…​.mjs`.
- Any other file is a **shared module**: it's inlined into the entries that
  import it and is *never* emitted on its own.

```ts
// src/lib/util.ts  — shared module (no registerScript)
export function greet(name: string): string { return `hi ${name}`; }

// src/main.ts  — entry
import { Inject } from "lb-inject";
import { greet } from "./lib/util";        // inlined into dist/main.mjs at build
registerScript({ name: "Hi", version: "0.1.0", authors: ["you"] });
```

Imports from `@wunk/lb-script-api-types/types/<fqcn>` and from `lb-inject` work
the same in any file, entry or shared.

The `import { X } from "@wunk/lb-script-api-types/types/<fqcn>"` value imports
become `const X = Java.type("<fqcn>")` at build (an esbuild plugin resolves the
JVM type); `import type { … }` is erased.

---

## What else could typing unlock?

The `typed-targets.ts` facade is just the first step. See **[IDEAS.md](IDEAS.md)**
for a roadmap of deeper type-tree integration — typed INVOKE/FIELD targets,
field-name checking, binding the runtime class object to its type (no
string/type drift), `using`-based auto-removal, hook bodies typed with the
patched method's real parameters, and a build-time target-existence linter.

The types are derived from LiquidBounce and licensed GPL-3.0-or-later.
