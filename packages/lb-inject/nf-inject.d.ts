// Type definitions for the lb-inject runtime bytecode injection library.
// https://github.com/obus-globus/lb-inject
//
// `load()`-ing nf-inject defines a single global, `Inject`. Include this file in
// your TypeScript project (it's an ambient .d.ts — no import needed) and that
// global is fully typed: autocomplete, docs, and compile-time enforcement of the
// call contract the JS library can only check at runtime.
//
//   • `position` is a closed union (no "HAED" typos),
//   • the `*_INVOKE` / `*_FIELD` positions REQUIRE the 5th `target`, while
//     `HEAD` / `RETURN` forbid it (enforced via overloads),
//   • `hook` is a no-arg `() => void` or a `java.lang.Runnable`,
//   • handles are branded so you can't `remove()` a random string.
//
// (Projects that consume lb-inject through a bundler with an import convention —
// e.g. the lb-inject-template — instead declare `"lb-inject"` as a module; this
// file is the ambient-global form for scripts that just `load()` the library.)

/** Where, relative to the patched method, the hook fires. Maps to Mixin `@At`. */
type InjectPosition =
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
 * A hook body. A JS function runs on whatever thread the patched method runs on
 * (safe for client/render-thread points like ticks, render, `getFps`). For
 * points on other threads, pass a precompiled `java.lang.Runnable` (anything
 * structurally `{ run(): void }`).
 */
type InjectHook = (() => void) | { run(): void };

/** Opaque handle from `Inject.inject(...)` — a string, branded so `remove()` won't take any string. */
type InjectHandle = string & { readonly __injectHandle: unique symbol };

/** Severity for `Inject.notify`. `ERROR` shows even when `quiet`. */
type InjectSeverity = "ERROR" | "INFO" | "SUCCESS";

/** Minimal shape of a ScriptModule — just the `on(enable|disable)` lifecycle. */
interface InjectModuleLike {
  on(event: "enable" | "disable", handler: () => void): unknown;
}

/**
 * One declaration for `Inject.module` / `Inject.always`: the same target as
 * `inject()`, as a tuple (arg order matches `inject`) or a mixin-style object.
 * `HEAD`/`RETURN` take no `target`; `*_INVOKE`/`*_FIELD` require it.
 */
type InjectDecl =
  | readonly [className: string, method: string, position: InjectMethodPosition, hook: InjectHook]
  | readonly [className: string, method: string, position: InjectSitePosition, hook: InjectHook, target: string]
  | { class: string; method: string; at: InjectMethodPosition; hook: InjectHook; target?: undefined }
  | { class: string; method: string; at: InjectSitePosition; hook: InjectHook; target: string };

interface InjectApi {
  /** Library version (matches the `nf-inject-<ver>` filename it was loaded from). */
  readonly VERSION: string;

  /** When true, suppress info/success toasts (errors still show). Default false. */
  quiet: boolean;

  /** Override the path to `nf-inject-agent.jar` (normally auto-resolved). */
  agentJar?: string | null;

  /**
   * Path to a JDK home (a folder containing `bin/java`) used to run the external
   * attacher — set it to inject even when LiquidBounce runs on a **JRE** (the
   * attacher supplies `jdk.attach`; the target VM doesn't need it).
   */
  jdkHome?: string | null;

  /** Obtain `Instrumentation` (auto-called on first `inject`); throws with guidance if unavailable. */
  ensure(): void;

  /** Show a toast / chat line. Never throws. */
  notify(msg: string, severity?: InjectSeverity): void;

  /** Patch a whole method at `HEAD` or `RETURN`. */
  inject(className: string, method: string, position: InjectMethodPosition, hook: InjectHook): InjectHandle;

  /**
   * Patch a call/field *site inside* a method (Mixin `@At INVOKE`/`FIELD`).
   * Requires `target` — the `"owner.member"` the hook fires around.
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
  module<M extends InjectModuleLike>(mod: M, decls: InjectDecl[]): M;

  /**
   * Declarative, always-on injection (mixin style). Apply the declared hooks once
   * and keep them for the whole session. `key` namespaces an idempotency sentinel
   * so a `.script reload` doesn't stack duplicates. Returns the installed handles
   * (or `[]` if already installed this session).
   */
  always(key: string, decls: InjectDecl[]): InjectHandle[];
}

/** The lb-inject API — a global defined when the library is `load()`-ed. */
declare var Inject: InjectApi;
