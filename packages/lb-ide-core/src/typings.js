// @lb-ide/core — @wunk typings: own the closure, adapt per mode.
//
// The two editor modes feed the SAME 6035-file @wunk transitive closure to their
// (different) TypeScript hosts in DIFFERENT shapes — and the adapters are NOT
// symmetric:
//   - lean (Monaco): RUNTIME — `toExtraLibs()` → `monaco...typescriptDefaults.setExtraLibs([{content,filePath}])`.
//   - heavy (vscode-web tsserver over an FS provider): BUILD-TIME — a single
//     ambient-`declare module`-per-path barrel `.d.ts` (zero per-file FS probing →
//     5.5 s cold start) produced by `scripts/gen-barrel.mjs`, shipped as a workspace
//     file. There is no in-browser `toBarrel()` runtime function — the barrel is a
//     build artifact, so the heavy adapter lives in the build step, not here.
//
// Core owns `getClosure()` (the shared source) + the lean runtime adapter; each
// mode applies its own format.

/** Load the @wunk transitive closure as a { path → .d.ts content } map. */
export async function getClosure(url = "typings-bundle.json", fetchImpl = fetch) {
  return await fetchImpl(url).then((r) => r.json());
}

/**
 * Lean adapter: closure (+ extra `{content, filePath}` libs, e.g. @types/lb-inject,
 * @types/lb-repl) → the array Monaco's `typescriptDefaults.setExtraLibs(...)` wants.
 */
export function toExtraLibs(closure, extras = []) {
  const libs = Object.entries(closure).map(([p, content]) => ({ content, filePath: "file:///" + p }));
  return extras.length ? libs.concat(extras) : libs;
}
