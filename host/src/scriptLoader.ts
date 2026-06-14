/// <reference types="@wunk/lb-script-api-types/ambient" />
//
// Write a freshly-built .mjs to the LiquidBounce scripts directory and load it
// into the running client via ScriptManager — the in-game equivalent of
// `.script load`, but surgical (unloads a prior version of the same name first).
//
// All Java reflection is guarded so a changed/absent LB (or the GraalJS sim)
// degrades to a clear error instead of throwing. Must be called on the MC thread
// (the server hops there via mc.execute before invoking this).

declare const Java: { type(name: string): unknown };

type Jany = { [k: string]: unknown } & ((...a: unknown[]) => unknown);
const T = (n: string): Jany | null => { try { return Java.type(n) as unknown as Jany; } catch { return null; } };

export interface LoadResult { ok: boolean; name?: string; error?: string; debugPort?: number }
export interface LoadOpts { debug?: boolean; port?: number }

interface PolyScript { scriptName?: string; enable?: () => void; disable?: () => void }
interface SM {
  root: unknown;
  scripts: PolyScript[];
  loadScript(file: unknown, language: string, debugOptions: unknown): PolyScript;
  unloadScript(s: PolyScript): void;
}

/** ScriptManager.INSTANCE, or null if unavailable. */
function scriptManager(): SM | null {
  const C = T("net.ccbluex.liquidbounce.script.ScriptManager");
  const inst = C && (C as unknown as { INSTANCE?: SM }).INSTANCE;
  return inst ?? null;
}

/** ScriptDebugOptions: disabled by default, or an enabled GraalJS INSPECT
 *  (chrome devtools) listener on `port` when debug is requested. */
function debugOptions(debug?: { port?: number }): unknown {
  const SDO = T("net.ccbluex.liquidbounce.script.ScriptDebugOptions");
  const DP = T("net.ccbluex.liquidbounce.script.DebugProtocol");
  if (!SDO || !DP) return null;
  const INSPECT = (DP as unknown as { INSPECT?: unknown }).INSPECT;
  const DAP = (DP as unknown as { DAP?: unknown }).DAP;
  const Ctor = SDO as unknown as new (a: boolean, b: unknown, c: boolean, d: boolean, e: number) => unknown;
  if (debug) return new Ctor(true, INSPECT ?? DAP, false, false, debug.port ?? 9229);
  return new Ctor(false, INSPECT ?? DAP, false, false, 0);
}

/** sanitize a user-supplied script name into a safe single-segment filename. */
export function safeName(name: string): string {
  const base = (name || "script").replace(/\.mjs$/i, "").replace(/[^a-z0-9._-]/gi, "_").slice(0, 64);
  return (base || "script") + ".mjs";
}

/** Write <name>.mjs into the scripts dir and (re)load it. Returns a result. */
export function loadBuiltScript(name: string, mjs: string, opts?: LoadOpts): LoadResult {
  try {
    const sm = scriptManager();
    if (!sm) return { ok: false, error: "ScriptManager unavailable" };
    const Paths = T("java.nio.file.Paths");
    const Files = T("java.nio.file.Files");
    const FileT = T("java.io.File");
    if (!Paths || !Files || !FileT) return { ok: false, error: "java.nio unavailable" };

    const fname = safeName(name);
    const rootPath = String((sm.root as { getAbsolutePath(): unknown }).getAbsolutePath());
    const target = (Paths.get as (a: string, b: string) => unknown)(rootPath, fname);

    // unload any already-loaded script of the same name (avoid duplicate modules)
    try {
      for (const s of sm.scripts || []) {
        if (s && s.scriptName && safeName(s.scriptName) === fname) { try { sm.unloadScript(s); } catch { /* */ } }
      }
    } catch { /* */ }

    // write the file (UTF-8)
    const bytes = (new (T("java.lang.String") as unknown as new (s: string) => { getBytes(cs: string): unknown })(mjs)).getBytes("UTF-8");
    (Files.write as (p: unknown, b: unknown, o?: unknown) => unknown)(target, bytes);

    // load + enable it (optionally with a GraalJS inspector listener)
    const port = opts?.port ?? 9229;
    const file = new (FileT as unknown as new (p: string) => unknown)(rootPath + "/" + fname);
    const ps = sm.loadScript(file, "javascript", debugOptions(opts?.debug ? { port } : undefined));
    try { ps && ps.enable && ps.enable(); } catch { /* */ }
    return { ok: true, name: fname, debugPort: opts?.debug ? port : undefined };
  } catch (e) {
    return { ok: false, error: String((e as { message?: string })?.message ?? e) };
  }
}

/** Unload a loaded script by (file) name. Returns whether one was unloaded. */
export function unloadByName(name: string): boolean {
  try {
    const sm = scriptManager(); if (!sm) return false;
    const want = safeName(name);
    let hit = false;
    for (const s of sm.scripts || []) {
      if (s && s.scriptName && safeName(s.scriptName) === want) { try { sm.unloadScript(s); hit = true; } catch { /* */ } }
    }
    return hit;
  } catch { return false; }
}

/** List installed scripts in the scripts dir (so the editor can open them). */
export function listScripts(): string[] {
  try {
    const sm = scriptManager();
    if (!sm) return [];
    const Files = T("java.nio.file.Files");
    const Paths = T("java.nio.file.Paths");
    if (!Files || !Paths) return [];
    const rootPath = String((sm.root as { getAbsolutePath(): unknown }).getAbsolutePath());
    const dir = (Paths.get as (a: string) => unknown)(rootPath);
    const out: string[] = [];
    for (const p of (Files.newDirectoryStream as (d: unknown, g: string) => Iterable<unknown>)(dir, "*.{js,mjs}")) {
      out.push(String((p as { getFileName(): unknown }).getFileName()));
    }
    return out;
  } catch { return []; }
}

/** Evaluate a REPL snippet in the script's global context (has mc/Client/etc.).
 *  Indirect eval runs in global scope. Captures synchronous print(...) and
 *  console.* output alongside the last-expression value. Must run on MC thread. */
export function replEval(code: string): { ok: boolean; result?: string; output?: string; error?: string } {
  const logs: string[] = [];
  const fmt = (args: unknown[]): string => args.map((a) => { if (typeof a === "string") return a; try { const s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch { return String(a); } }).join(" ");
  const g = globalThis as unknown as { print?: unknown; console?: unknown };
  const origPrint = g.print, origConsole = g.console;
  try {
    try { g.print = (...args: unknown[]): void => { logs.push(fmt(args)); }; } catch { /* print may be read-only */ }
    try {
      const mk: Record<string, (...a: unknown[]) => void> = {};
      for (const k of ["log", "info", "warn", "error", "debug"]) mk[k] = (...a: unknown[]): void => { logs.push((k === "log" ? "" : "[" + k + "] ") + fmt(a)); };
      g.console = mk;
    } catch { /* */ }
    const indirect = eval; // indirect eval → global scope (ambient LB globals visible)
    const r = (indirect as (s: string) => unknown)(code);
    let out: string;
    if (r === undefined) out = "undefined";
    else { try { out = JSON.stringify(r); } catch { out = String(r); } if (out === undefined) out = String(r); }
    return { ok: true, result: out, output: logs.join("\n") };
  } catch (e) {
    return { ok: false, error: String((e as { message?: string })?.message ?? e), output: logs.join("\n") };
  } finally {
    try { g.print = origPrint; } catch { /* */ }
    try { g.console = origConsole; } catch { /* */ }
  }
}

/** The scripts dir absolute path (for the editor / debugging). */
export function scriptsRoot(): string | null {
  try { const sm = scriptManager(); return sm ? String((sm.root as { getAbsolutePath(): unknown }).getAbsolutePath()) : null; } catch { return null; }
}

/** Read an installed script's text by filename (so the editor can open it). */
export function readScript(name: string): string | null {
  try {
    const root = scriptsRoot(); if (!root) return null;
    const fname = (name || "").replace(/[^a-z0-9._-]/gi, "_");
    if (!fname) return null;
    const Files = T("java.nio.file.Files"); const Paths = T("java.nio.file.Paths");
    if (!Files || !Paths) return null;
    const p = (Paths.get as (a: string, b: string) => unknown)(root, fname);
    if (!(Files.exists as (x: unknown) => boolean)(p)) return null;
    return String((Files.readString as (x: unknown) => unknown)(p));
  } catch { return null; }
}
