# lb-inject examples

Worked examples for the `Inject` API. See the [top-level README](../README.md)
for the full API reference and how instrumentation is obtained.

Two flavours:

- `inject-example.js` - hooks live inside a **module**; injected on enable,
  removed on disable (toggle it like any LiquidBounce module).
- `inject-always-on.js` - **no module**; hooks are installed at script load and
  stay active for the whole session.

Both load the library via an `ensureLib("1.0.0")` preamble (finds the versioned
library in `scripts/lib/`, or a stray copy in `scripts/`) and share the same
run/setup steps below.

## `inject-example.js`

A self-contained LiquidBounce userscript. It registers a module **InjectDemo**
that, while enabled, patches three points of `net.minecraft.client.Minecraft`
with mixin-style hooks, and removes them (restoring the original bytecode) when
disabled:

- `getFps` at `HEAD` - counts every call (render thread, so a JS hook is safe).
- `tick` at `RETURN` - periodic chat message.
- `tick` at `BEFORE_INVOKE` of `getFps` - fires right before that call site
  (the 5th `inject` arg is the target `"owner.member"`).

### Run it

1. Build the jars (or grab them from `dist/`):

   ```bash
   ./build.sh          # -> dist/nf-inject-agent.jar + dist/nf-holder.jar
   ```

2. Deploy the library into your LiquidBounce `scripts/` folder. The example
   calls `ensureLib("1.0.0")`, which looks in `scripts/lib/` first, then falls
   back to a stray copy in `scripts/` (which the library relocates into
   `scripts/lib/` on first load). Pick one library flavour:

   **Single-file bundle** (recommended; jars embedded, self-extracts; runtime-
   attach path only - see the top-level README):
   ```
   scripts/
     inject-example.js                 # this example
     lib/
       nf-inject-bundled-1.0.0.js      # from dist/ (extracts jars into lib/nf-inject-1.0.0/)
   ```

   **Plain library** (you supply the jars):
   ```
   scripts/
     inject-example.js                 # this example
     lib/
       nf-inject-1.0.0.js              # from dist/
       nf-inject-1.0.0/
         nf-inject-agent.jar           # from dist/
         nf-holder.jar                 # from dist/ (MUST sit next to the agent jar)
   ```

   You can also just drop the library file in `scripts/` (not `lib/`) - it moves
   itself into `scripts/lib/` on first load. (LB logs a harmless one-line
   `WARN: Unable to find main inside the directory lib.` - see the top-level
   README to silence it.)

3. Make sure instrumentation is available (the library auto-detects which):
   - launch LiquidBounce with `-javaagent:nf-inject-agent.jar` (works on **any
     JRE** - add it via the launcher's custom JVM args), **or**
   - run on a **JDK** runtime (has `jdk.attach`, e.g. GraalVM in LiquidLauncher)
     so the library can self-attach at runtime.

   If neither is present, `Inject.inject(...)` throws with guidance and the
   error is logged to `logs/latest.log` as a failed script load.

4. Start the client, open the ClickGUI, and toggle the **InjectDemo** module.
   You'll see a chat line listing the injected hooks on enable, and a removal
   line on disable. (Modules only activate **in-game** - join a world first.)

### Adapt it

Change the class/method/position to hook whatever you need. Targets are
**Mojang-mapped** and version-specific (currently MC `26.1.2`) - use the names
for the version you run against (see the mappings link in the top-level README).
Positions: `HEAD`, `RETURN`, `BEFORE_INVOKE`, `AFTER_INVOKE`, `BEFORE_FIELD`,
`AFTER_FIELD`.

## `inject-always-on.js`

Same setup as above (drop it in `scripts/` alongside the library), but it
registers **no module**: it installs a single `tick`-`RETURN` hook at script
load and keeps it for the whole session (no toggle). It chats `hook installed`
on load and a heartbeat roughly once a minute. `Minecraft.tick` runs even at the
main menu, so it's genuinely always-on.

Notes:
- A script with no module must still call `registerScript(...)` (LB requires it).
- It guards against double-injection on `.script reload` with a one-shot
  sentinel (`nf.alwayson.installed` system property), since each reload would
  otherwise stack another hook.
- There's no disable path; the hook lives until the game exits.
