// @lb-ide/core — template-source import: validate + STRIP untrusted files.
//
// A fetched "template source" is a `{ categories: [...] }` document (same shape the
// editor's bundled templates.json uses). Templates are code the user later builds +
// runs, so on import we STRIP files that change build/editor behavior without being
// visible in the obvious entry file — the foundation of the trust model before any
// custom (untrusted) source is ever exposed:
//   - `lbbuild.config.json` (auto-parsed at build; banner/footer emit RAW JS),
//   - anything under a `.vscode/` segment (editor config: tasks/settings),
//   - dotfiles (`.npmrc`, `.gitignore`, …).
// Pure, no globals — shared by lean now and heavy later.

/** True if a project-relative path must be stripped from an imported template.
 *  Normalizes each segment (lowercase; split on / AND \; strip trailing dots/spaces)
 *  so the denylist can't be evaded by case or path tricks (LBBUILD.CONFIG.JSON,
 *  .VSCODE, "lbbuild.config.json.", backslash separators) and doesn't silently drift
 *  from the build's key matching — the foundation before any untrusted source ships. */
export function isUnsafeTemplatePath(p) {
  const segs = String(p).split(/[\\/]/).map((s) => s.toLowerCase().replace(/[.\s]+$/, ""));
  const base = segs[segs.length - 1];
  if (base === "lbbuild.config.json") return true;     // build-config injection (banner/footer/define)
  if (base.startsWith(".")) return true;               // dotfiles (.npmrc, .gitignore, …)
  if (segs.includes(".vscode")) return true;            // editor config (tasks.json/settings.json)
  return false;
}

/** Return a copy of a {path: content} map with unsafe files removed. */
export function stripUntrustedFiles(files) {
  const out = {};
  for (const [p, c] of Object.entries(files || {})) if (!isUnsafeTemplatePath(p)) out[p] = c;
  return out;
}

/** Strip every file map in a fetched category (base.files, aux, each example's files). */
export function sanitizeFetchedCategory(cat) {
  const c = { ...cat };
  if (c.base && c.base.files) c.base = { ...c.base, files: stripUntrustedFiles(c.base.files) };
  if (c.aux && typeof c.aux === "object" && !Array.isArray(c.aux)) c.aux = stripUntrustedFiles(c.aux);
  else c.aux = {};
  c.examples = Array.isArray(c.examples) ? c.examples.map((e) => ({ ...e, files: stripUntrustedFiles(e.files || {}) })) : [];
  return c;
}

/**
 * Parse a fetched template-source document into sanitized category entries.
 * Validates shape, strips untrusted files, tags origin="fetched" + sourceId.
 * Skips malformed categories (missing id/base.files). Caps count + total size.
 * @returns {Array<object>} sanitized template/category docs
 */
export function parseTemplateSource(doc, { sourceId = "source", maxTemplates = 200, maxBytes = 8 * 1024 * 1024 } = {}) {
  const cats = doc && Array.isArray(doc.categories) ? doc.categories : [];
  const out = [];
  let bytes = 0;
  for (const raw of cats) {
    if (out.length >= maxTemplates) break;
    if (!raw || typeof raw.id !== "string" || !raw.base || typeof raw.base.files !== "object") continue;
    const c = sanitizeFetchedCategory(raw);
    // size budget across all fetched content (defense against a huge published doc)
    for (const f of [c.base.files, c.aux, ...(c.examples || []).map((e) => e.files || {})]) {
      for (const v of Object.values(f)) bytes += typeof v === "string" ? v.length : 0;
    }
    if (bytes > maxBytes) break;
    out.push({ ...c, origin: "fetched", sourceId });
  }
  return out;
}
