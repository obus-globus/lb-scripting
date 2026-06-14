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

export interface LoadResult { ok: boolean; name?: string; error?: string }

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

/** A no-debug ScriptDebugOptions(false, <proto>, false, false, 0). The protocol
 *  is irrelevant while enabled=false; we grab any enum constant. */
function noDebugOptions(): unknown {
  const SDO = T("net.ccbluex.liquidbounce.script.ScriptDebugOptions");
  const DP = T("net.ccbluex.liquidbounce.script.DebugProtocol");
  const proto = DP && ((DP as unknown as { DAP?: unknown }).DAP ?? (DP as unknown as { INSPECT?: unknown }).INSPECT);
  if (!SDO || !proto) return null;
  return new (SDO as unknown as new (a: boolean, b: unknown, c: boolean, d: boolean, e: number) => unknown)(false, proto, false, false, 0);
}

/** sanitize a user-supplied script name into a safe single-segment filename. */
export function safeName(name: string): string {
  const base = (name || "script").replace(/\.mjs$/i, "").replace(/[^a-z0-9._-]/gi, "_").slice(0, 64);
  return (base || "script") + ".mjs";
}

/** Write <name>.mjs into the scripts dir and (re)load it. Returns a result. */
export function loadBuiltScript(name: string, mjs: string): LoadResult {
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

    // load + enable it
    const file = new (FileT as unknown as new (p: string) => unknown)(rootPath + "/" + fname);
    const ps = sm.loadScript(file, "javascript", noDebugOptions());
    try { ps && ps.enable && ps.enable(); } catch { /* */ }
    return { ok: true, name: fname };
  } catch (e) {
    return { ok: false, error: String((e as { message?: string })?.message ?? e) };
  }
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
