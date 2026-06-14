// Ambient stubs for the GraalJS + LiquidBounce host-interop globals the library
// uses. Deliberately loose — they exist so `@ts-check` doesn't flag the host
// bridge; they are NOT a real model of the JVM or the LiquidBounce API. Used for
// type-checking nf-inject.js only; not shipped.

/** GraalVM polyglot Java interop. */
declare const Java: {
  /** Resolve a JVM class by fully-qualified name (throws if not found). */
  type(className: string): any;
  /** Create a subclass/adapter of the given Java types. */
  extend(...types: any[]): any;
  /** Convert a Java array/iterable to a JS array. */
  from(javaObject: any): any[];
  /** Convert a JS array to a Java array of the named type. */
  to(jsArray: any, javaType: string): any;
};

/** GraalJS: synchronously load + execute another script (file path or source). */
declare function load(source: string | { name: string; script: string }): unknown;

/** LiquidBounce script binding (only the members the library touches). */
declare const Client: {
  configSystem: { rootFolder: { getAbsolutePath(): string } };
  displayChatMessage(message: string): void;
};

/** LiquidBounce script binding — registers a script (used by the auto-load guard). */
declare function registerScript(info: { name: string; version: string; authors: string[] }): any;

/** GraalJS console (subset). */
declare const console: {
  log(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
};

// Bootstrap/bundle sentinels the library reads/writes on globalThis.
declare var __nfLibConsumed: boolean | undefined;
declare var __NF_IS_BUNDLE: boolean | undefined;
declare var __NF_TOAST_CLASS_B64: string | undefined;
declare var __NF_BUNDLED_AGENT_JAR: string | undefined;
