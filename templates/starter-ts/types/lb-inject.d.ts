// TypeScript declarations for the **lb-inject** runtime bytecode injection
// library (https://github.com/obus-globus/lb-inject).
//
// Canonical types live in the library repo (`lb-inject/nf-inject.d.ts`, shipped
// as `dist/nf-inject-<ver>.d.ts`) in *global* form (a `load()`-ed lib exposes a
// global `Inject`). THIS file is the *module* form for this template's import
// convention — same API, kept in sync with the library's d.ts. When bumping the
// vendored library version, refresh this from the matching `nf-inject-<ver>.d.ts`.
//
// lb-inject is plain JS: `load()`-ing it defines a single global, `Inject`.
// This declares an ambient module `"lb-inject"` so you bring that in with an
// explicit, idiomatic import:
//
//     import { Inject } from "lb-inject";
//
// The build (`scripts/build.mjs`) recognises that import, strips it, and
// prepends the loader (or, with `--bundle`, the whole library) so `Inject`
// exists at runtime. The import is what *opts a script in* to having the
// library wired up — a script that doesn't import it stays pure.
//
// Beyond autocomplete + docs, the types enforce the lb-inject call contract
// the JS library can only check at runtime: `position` is a closed union; the
// `*_INVOKE` / `*_FIELD` positions REQUIRE the 5th `target` arg while
// `HEAD` / `RETURN` forbid it; `hook` is a no-arg `() => void` or a
// `java.lang.Runnable`; handles are branded so you can't `remove(...)` a
// random string.

declare module "lb-inject" {
  /** Where, relative to the patched method, the hook fires. Maps to Mixin `@At`. */
  export type InjectPosition =
    | "HEAD"
    | "RETURN"
    | "BEFORE_INVOKE"
    | "AFTER_INVOKE"
    | "BEFORE_FIELD"
    | "AFTER_FIELD";

  /** Positions targeting a *call/field site inside* the method — need a 5th `target`. */
  type InjectSitePosition = "BEFORE_INVOKE" | "AFTER_INVOKE" | "BEFORE_FIELD" | "AFTER_FIELD";

  /** Positions that apply to the *method as a whole* — no `target`. */
  type InjectMethodPosition = "HEAD" | "RETURN";

  /**
   * A hook body. A JS function runs on whatever thread the patched method runs
   * on (safe for client/render-thread points like ticks, render, `getFps`). For
   * points that fire on other threads, pass a precompiled `java.lang.Runnable`
   * (anything structurally `{ run(): void }`).
   */
  export type InjectHook = (() => void) | { run(): void };

  /**
   * Opaque handle returned by `Inject.inject(...)`. It's a string at runtime, but
   * branded here so the type system stops you handing `remove()` a random string.
   */
  export type InjectHandle = string & { readonly __injectHandle: unique symbol };

  /** Minimal shape of a ScriptModule — just the `on(enable|disable)` lifecycle. */
  export interface ModuleLike {
    on(event: "enable" | "disable", handler: () => void): unknown;
  }

  /**
   * One declaration for {@link InjectApi.module} / {@link InjectApi.always}: the
   * same target as `inject()`, as a tuple (arg order matches `inject`) or a
   * mixin-style object. `HEAD`/`RETURN` take no `target`; `*_INVOKE`/`*_FIELD`
   * require it.
   */
  export type InjectDecl =
    | readonly [className: string, method: string, position: InjectMethodPosition, hook: InjectHook]
    | readonly [className: string, method: string, position: InjectSitePosition, hook: InjectHook, target: string]
    | { class: string; method: string; at: InjectMethodPosition; hook: InjectHook; target?: undefined }
    | { class: string; method: string; at: InjectSitePosition; hook: InjectHook; target: string };

  /** Severity for {@link InjectApi.notify}. `ERROR` is shown even when `quiet`. */
  export type InjectSeverity = "ERROR" | "INFO" | "SUCCESS";

  export interface InjectApi {
    /** Library version (matches the `nf-inject-<ver>` filename it was loaded from). */
    readonly VERSION: string;

    /** When true, suppress info/success toasts (errors still show). Default false. */
    quiet: boolean;

    /**
     * Override the path to `nf-inject-agent.jar`. Normally auto-resolved to
     * `<LiquidBounce>/scripts/lib/nf-inject-<VERSION>/nf-inject-agent.jar`.
     */
    agentJar?: string | null;

    /**
     * Path to a JDK home (a folder containing `bin/java`) used to run the external
     * attacher. Set this to inject even when LiquidBounce itself runs on a **JRE**
     * — the attacher process supplies `jdk.attach`; the target VM doesn't need it.
     * Leave unset to use the runtime `java.home` (which must then be a JDK).
     */
    jdkHome?: string | null;

    /**
     * Obtain `Instrumentation` (via `-javaagent` premain or runtime self-attach
     * on a JDK like GraalVM). Called automatically on the first `inject`; throws
     * with guidance if neither path is available.
     */
    ensure(): void;

    /** Show a toast / chat line. Never throws. */
    notify(msg: string, severity?: InjectSeverity): void;

    /**
     * Patch a whole method at `HEAD` or `RETURN`.
     *
     * @param className  fully-qualified, dotted JVM class name, e.g.
     *                   `"net.minecraft.client.Minecraft"`.
     * @param method     method name on that class.
     * @param position   `"HEAD"` (on entry) or `"RETURN"` (just before return).
     * @param hook       runs at the injection point.
     * @returns a handle to pass to {@link InjectApi.remove}.
     */
    inject(className: string, method: string, position: InjectMethodPosition, hook: InjectHook): InjectHandle;

    /**
     * Patch a specific call/field *site inside* a method (Mixin `@At INVOKE` /
     * `FIELD`). Requires `target` — the `"owner.member"` the hook fires around.
     *
     * @example
     * // fire right before Minecraft.tick() calls Minecraft.getFps():
     * Inject.inject("net.minecraft.client.Minecraft", "tick", "BEFORE_INVOKE",
     *   () => {}, "net.minecraft.client.Minecraft.getFps");
     */
    inject(className: string, method: string, position: InjectSitePosition, hook: InjectHook, target: string): InjectHandle;

    /** Remove one hook (restores the original bytecode). */
    remove(handle: InjectHandle): string;

    /** Remove every hook this script added. */
    removeAll(): string;

    /** Handles currently installed. */
    list(): string[];

    /**
     * Declarative, module-bound injection (mixin style). Declare the hooks once;
     * they're applied when `mod` is enabled and removed when it's disabled — no
     * manual `on("enable")`/`on("disable")` wiring. Returns `mod` (chainable).
     */
    module<M extends ModuleLike>(mod: M, decls: InjectDecl[]): M;

    /**
     * Declarative, always-on injection (mixin style). Apply the declared hooks
     * once and keep them for the whole session. `key` namespaces an idempotency
     * sentinel so a `.script reload` doesn't stack duplicates. Returns the
     * installed handles (or `[]` if already installed this session).
     */
    always(key: string, decls: InjectDecl[]): InjectHandle[];
  }

  /** The lb-inject API. Importing this is what wires the library into your build. */
  export const Inject: InjectApi;
}
