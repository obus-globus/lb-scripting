# lb-inject

Runtime **bytecode injection** (mixin-style head/return/invoke/field hooks) for
**LiquidBounce** GraalJS scripts with **no JDK required at runtime**.

A script calls `Inject.inject(class, method, position, hook)` and the library
rewrites the already-loaded method to call your hook. The heavy lifting (ASM +
the agent) lives in one precompiled, generic jar that's shipped with the
library; the script side is plain JS.

```js
// In your userscript - see examples/ for the ensureLib(...) loader preamble.
load(ensureLib("1.0.0"));                              // defines globalThis.Inject
var h = Inject.inject("net.minecraft.client.Minecraft", "getFps", "HEAD",
          function () { Client.displayChatMessage("getFps!"); });
Inject.remove(h);   Inject.list();   Inject.removeAll();
```

## Download

Grab the prebuilt files from the [**Releases**](https://github.com/obus-globus/lb-inject/releases)
page (latest: [v1.0.0](https://github.com/obus-globus/lb-inject/releases/latest)):

- **`nf-inject-bundled-<ver>.js`** - recommended; single file with both jars
  embedded, self-extracts on load. Drop it in your LiquidBounce `scripts/` (it
  relocates itself into `scripts/lib/`).
- **`nf-inject-<ver>.js`** + **`nf-inject-agent.jar`** + **`nf-holder.jar`** - the
  plain library and its jars, for the `-javaagent` route (the holder jar must sit
  next to the agent jar).

Or build from source with `./build.sh` (+ `./make-bundle.sh`) - see [Build](#build).

## Files

| file | what |
|---|---|
| `nf-inject.js` | the script library source (`Inject` API). `build`/`make-bundle.sh` emit versioned copies into `dist/`. |
| `nf-inject.d.ts` | TypeScript types for the `Inject` global. `make-bundle.sh` emits a versioned `dist/nf-inject-<ver>.d.ts`. See [TypeScript](#typescript). |
| `dist/nf-inject-<ver>.js` | versioned plain library - deploy this (the version is in the name so multiple versions can coexist). |
| `dist/nf-inject-bundled-<ver>.js` | versioned single-file build with both jars embedded (self-extracts on load). |
| `dist/nf-inject-agent.jar` | generic precompiled agent (premain + agentmain + a parameterized ASM injector + the attacher). ASM is **not** bundled - Fabric already provides it (bundling triggers Fabric's "duplicate ASM classes" check). |
| `dist/nf-holder.jar` | bootstrap state holder, loaded via the agent jar's `Boot-Class-Path`. **Must sit next to `nf-inject-agent.jar`** at runtime. |
| `examples/` | worked userscripts (module-toggle + always-on) and their README. |
| `src/NfInject.java`, `src/NfHolder.java`, `src/NfAttacher.java` | sources for the jars. |
| `build.sh` | compiles → `dist/nf-inject-agent.jar` + `dist/nf-holder.jar` (JDK 21). |
| `make-bundle.sh` | emits the versioned `dist/nf-inject-bundled-<ver>.js` + `dist/nf-inject-<ver>.js`. |

## Layout & versioning

Libraries live in **`scripts/lib/`**, named with their version
(`nf-inject-1.0.0.js` / `nf-inject-bundled-1.0.0.js`). Putting them in a
subfolder means LiquidBounce does **not** auto-load them as standalone scripts
(it only auto-loads `main.*` inside a subfolder), and the version in the name
lets several versions coexist so an old script keeps working when you add a new
one. Your script pins the version it wants via `ensureLib("1.0.0")` (see
`examples/`), which exposes itself as `Inject.VERSION`.

If you drop a library file directly in `scripts/` instead, it still works: on
first load it **relocates itself into `scripts/lib/`**. The bundle's jars
self-extract into `scripts/lib/nf-inject-<ver>/` (holder kept next to the agent
so the manifest's relative `Boot-Class-Path` resolves) - not a random temp dir.

> LiquidBounce logs a one-line `WARN: Unable to find main inside the directory
> lib.` each launch, because it scans every subfolder for a `main.*`. It's
> harmless. To silence it you may drop a no-op `main.js` (calling
> `registerScript(...)`) into `scripts/lib/` yourself - we don't ship one.

## Positions

`HEAD`, `RETURN`, `BEFORE_INVOKE`, `AFTER_INVOKE`, `BEFORE_FIELD`, `AFTER_FIELD`
(map to Mixin `@At` `HEAD`/`RETURN`/`INVOKE`/`FIELD`). The `*_INVOKE`/`*_FIELD`
positions take a 5th arg - the target `"owner.member"`, e.g.
`Inject.inject(cls, "tick", "BEFORE_INVOKE", hook, "net.minecraft.client.Minecraft.getFps")`.

Not supported (need a richer hook ABI than a no-arg `Runnable` - args / return /
cancel): Mixin `@Redirect`, `@Overwrite`, `@ModifyArg(s)`, `@ModifyVariable`,
`@ModifyConstant`, `@ModifyReturnValue`, cancellable `@Inject`, and `TAIL`.

## Hooks

`hook` is a **JS function** or a **`java.lang.Runnable`**, run at the injection
point. A JS function runs on whatever thread the patched method runs on, so it's
safe for points on the client/render thread (ticks, render, `getFps`, …). For
points that fire on other threads, pass a precompiled `java.lang.Runnable`.

## Declarative (mixin-style) usage

`Inject.inject`/`remove` are imperative. If you'd rather **declare** hooks like a
mixin — once, not hand-wired into `enable`/`disable` — there are two helpers
*(since 1.1.0)*. Each declaration is a tuple `[className, method, position, hook,
target?]` or an object `{ class, method, at, hook, target? }`.

**Bound to a module** — applied on enable, removed on disable, automatically:

```js
script.registerModule({ name: "TickSpy", category: "Misc" }, (mod) => {
    Inject.module(mod, [
        ["net.minecraft.client.Minecraft", "tick",   "RETURN", () => {/* … */}],
        { class: "net.minecraft.client.Minecraft", method: "getFps", at: "HEAD", hook: () => {/* … */} },
    ]);
});
```

**Always-on** — applied once and kept for the whole session (the closest thing to
a statically-declared mixin). The `key` namespaces an idempotency sentinel so a
`.script reload` doesn't stack duplicates:

```js
registerScript({ name: "Heartbeat", version: "1.0.0", authors: ["you"] });
Inject.always("heartbeat", [
    ["net.minecraft.client.Minecraft", "tick", "RETURN", () => {/* every tick, all session */}],
]);
```

> Not a load-time mixin: these `retransform` an already-loaded class, so a method
> that only runs **once at startup before your script loads** isn't caught (a real
> mixin would). For anything called repeatedly there's no difference. And the hook
> ABI is a no-arg `Runnable` — HEAD/RETURN/INVOKE/FIELD, not `@ModifyArg`/`@Redirect`.

## TypeScript

`dist/nf-inject-<ver>.d.ts` (source: [`nf-inject.d.ts`](nf-inject.d.ts)) types the
`Inject` global. Drop it into your project and you get autocomplete, docs, and the
call-contract checks (closed `position` union; `target` required for
`*_INVOKE`/`*_FIELD`; branded handles; typed `module`/`always` decls):

```jsonc
// tsconfig.json — include the ambient types (it declares the global `Inject`)
{ "include": ["src/**/*", "path/to/nf-inject-<ver>.d.ts"] }
```

```ts
// no import — `Inject` is an ambient global, typed by the .d.ts
const h = Inject.inject("net.minecraft.client.Minecraft", "getFps", "HEAD", () => {});
```

> Using a bundler with an import convention instead (e.g.
> [`lb-inject-template`](https://github.com/obus-globus/lb-inject-template))? That
> project declares `"lb-inject"` as a *module* so you `import { Inject } from
> "lb-inject"`; the type contents are the same.

The library source itself is `// @ts-check`-ed against this `.d.ts` (`npm run
typecheck`): the `globalThis.Inject = Inject` assignment makes a missing or wrong
public member a type error, so the implementation and the shipped types can't
drift. (`nf-inject.js` stays the runnable/shippable source — no TS build step;
`graaljs-env.d.ts` provides loose stubs for the GraalJS/LB host globals.)

## How `Instrumentation` is obtained (auto-detected)

Bytecode injection needs a `java.lang.instrument.Instrumentation`. `Inject.ensure()`
(called automatically on first `inject`) picks the right method. There are
**three ways to use it:**

1. **JDK runtime** (the running `java.home` has the `jdk.attach` module, e.g.
   **GraalVM** in LiquidLauncher) → no flags, no extra paths. `ensure()` attaches
   the agent to the running VM. Since **1.1.0** it first tries an **in-process
   self-attach** (no subprocess), which works on LiquidBounce with the GraalVM
   caller-sensitive fix ([`b759cac57`](https://github.com/CCBlueX/LiquidBounce/pull/8437)+);
   on older clients it transparently falls back to (the same as) the external
   attacher below.
2. **JRE runtime + a JDK on the side** — set **`Inject.jdkHome`** to a JDK folder
   (one containing `bin/java`). The library runs that JDK's `java` as the external
   attacher to attach to the LiquidBounce process by pid and `loadAgent`. The
   *attacher* supplies `jdk.attach`; the **target VM does not need it**, so this
   lets you inject even when LiquidBounce itself runs on a plain JRE. *(New in 1.1.0.)*
3. **`-javaagent:nf-inject-agent.jar`** at launch → the agent's `premain` publishes
   everything before any script runs. **Works on any JRE - no JDK, no attach.**
   Add it via the launcher's custom JVM args.

If none apply, `ensure()` throws with guidance.

> Of LiquidLauncher's Java options, **Temurin/Zulu JREs lack `jdk.attach`** (and
> `jdk.compiler`), so on those use route **2** (`Inject.jdkHome`) or **3**
> (`-javaagent`); **GraalVM** (a JDK) supports route **1** directly.

The injected bytecode calls into the bootstrap-loaded `NfHolder.fire(<id>)` - so
the patched class (loaded by Fabric's Knot loader) resolves nothing but a
bootstrap class. ASM is not bundled (Fabric provides it); the agent only
compiles against it.

## Build

```bash
./build.sh            # -> dist/nf-inject-agent.jar + dist/nf-holder.jar (needs JDK 21 at JAVA_HOME)
./make-bundle.sh      # -> dist/nf-inject-bundled-<ver>.js + dist/nf-inject-<ver>.js (run after build.sh)
```

The jars are generic - build once and reuse for any script/injection. The
version comes from the `VERSION` constant in `nf-inject.js`; `make-bundle.sh`
stamps it into the output filenames.

## Single-file bundle

`make-bundle.sh` produces `dist/nf-inject-bundled-<ver>.js`: both jars embedded
as base64. You ship **one** file - drop it in `scripts/` (it relocates itself
into `scripts/lib/`) and `load()` it from your script (use `ensureLib(...)`,
see `examples/`). On load it self-extracts the jars into
`scripts/lib/nf-inject-<ver>/` (holder next to the agent so the manifest's
relative `Boot-Class-Path` resolves) and points `Inject.agentJar` there.

This only helps the **runtime-attach path** (JDK runtime, e.g. GraalVM): the
attach API loads the agent from a filesystem path at the moment you inject, so
self-extracting just-in-time works. The **`-javaagent` path can't use the
bundle** - that flag is read by the JVM at launch (before any script runs) and
needs the jar on disk then, so those users still ship `nf-inject-agent.jar` +
`nf-holder.jar`. (There's no in-memory route: `loadAgent` takes a file, and
defining classes in memory would itself require the `Instrumentation` the jar
provides.)

## Notes / caveats

- Precompiled bytecode of the agent is version-agnostic, but the **classes you
  target** (MC/LB) are Mojang-mapped and version-specific (currently MC `26.1.2`)
  - use the correct names for the version you run against.
- `remove`/`removeAll` restore the original bytecode (`removeTransformer` +
  retransform), then drop the hook.
- Keeping the library in `scripts/lib/` means LiquidBounce never auto-loads it
  (it only auto-loads `main.*` inside a subfolder). A **stray** copy left in
  `scripts/` root *is* auto-loaded - to avoid a "missing required information"
  error it registers benign info (a harmless empty `nf-inject (library)` script)
  and then relocates itself into `scripts/lib/` for next launch.
- In your own script, set `globalThis.__nfLibConsumed = true` and `load()` the
  library **before** your `registerScript(...)` (the `ensureLib(...)` preamble in
  `examples/` does both).
- Modules only activate **in-game** - toggling a module that injects (like the
  example) does nothing at the main menu; join a world first.
- The library surfaces events three ways: a chat message, a LiquidBounce toast,
  and - because neither is visible at the title screen - a **modal Swing message
  box** the user must click OK on (it briefly freezes the game thread; that's
  intentional, so a startup/error message can't be missed). It fires when the
  library relocates a stray copy into `scripts/lib/`, when injection can't be
  enabled (with the exact `-javaagent:<jar>` arg to add, or "use a JDK like
  GraalVM"), and when an `inject(...)` fails (e.g. a class/method name that
  doesn't match your MC version). The message box uses `javax.swing` from the
  JDK (no extra deps, nothing added to the jars); it's skipped on a headless
  runtime. Set `Inject.quiet = true` to suppress the informational box/toast
  (error notifications still show). `Inject.notify(msg, severity)`
  (`severity ∈ "INFO" | "SUCCESS" | "ERROR"`) is reusable from your script.
