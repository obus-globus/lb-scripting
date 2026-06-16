# Template Management — Plan (v1 GREENLIT)

Status: **building v1** per the decisions below. Companion to
`docs/dual-mode-state.md`. Tracks task #15 ("template-management").

## v1 decisions (GREENLIT — scorpion + Koda)

- **Multi-source architecture, single source exposed.** Build the source layer so it
  *supports* multiple/custom repos, but **do NOT expose an add-custom-repo UI** in v1.
  The **untrusted-source malicious-code warning UX is the gate** that must land before
  custom repos are ever exposed — designed for, not shipped. v1 contacts only the one
  default source.
- **Default source = a configurable constant**, placeholder URL until scorpion supplies
  the real one (our deploy's published `templates.json`, or a GitHub repo). Trivial to set.
- **Editor-fetch only** — no host-fetch in v1 → **zero SSRF surface** (§3.3 guard is
  not built in v1; it's the gate for the deferred host-fetch).
- **Strip** build-config (`lbbuild.config.json`) + `.vscode/` + dotfiles from
  fetched/user templates on import — always, even though v1's single source is trusted
  (defense-in-depth + the foundation the trust model needs before custom repos).
- **No git sources** (manifest + raw files). **Lean-only** (heavy deferred).
- **create-own** ("Save as template") + **clone-and-modify** ("Duplicate & edit") —
  both local, no fetch.
- **Provenance "review before running" notice** on imported templates now; the full
  untrusted-source warning is the deferred custom-repo gate.

Build in the ~6 reviewable steps in §5 (lean green each, sub-agent review at the
boundary). The sections below are the full design; where v1 narrows it, the decision
above wins.

## 0. Problem & goal

Today templates are **build-time-baked, read-only, lean-only**: `gen-templates.mjs`
reads the four on-disk projects in `templates/` (`default-ts`, `plain-js`,
`starter-ts`, `inject-ts`) into `apps/editor/public/templates.json` (~336 KB,
each template's files inlined as strings); lean `fetch`es it at startup and the
"+ new" menu lists them. Heavy has **no** template system (it provisions an
existing project from the bridge).

scorpion wants templates to become **user-managed**: keep the bundled built-ins as
defaults, but let users **add more** — fetch from a template repo, **save their own**,
and **duplicate-and-edit** an existing one. Stored in `lb-ide/templates/` (next to
`lb-ide/projects/`). Primarily a **lean** feature (that's where New-from-template
lives); heavy stays provision-from-bridge.

## 1. Design overview

Three template tiers, merged in the New menu (later tiers shadow earlier by id):

1. **Bundled defaults** — the current `templates.json`, shipped with the editor.
   Always present, read-only, work offline / on the plain web deploy. Source of
   truth unchanged (`gen-templates.mjs`).
2. **User templates** — created via "Save as template" / "Duplicate & edit", or
   hand-edited. Stored on the host at `lb-ide/templates/<id>.json`.
3. **Fetched templates** — pulled from a configured template **source** (repo) via
   "Fetch templates from repo", written into `lb-ide/templates/` (tier 2 storage;
   tagged with their `sourceId` so they can be refreshed/removed as a group).

Tiers 2+3 require the **bridge** (the in-client host or the Java server); on the
plain static web deploy only tier 1 exists (graceful — the manager UI shows
"connect to a client to manage templates").

**Merge rule:** New menu lists tier1 ∪ tier2/3, keyed by `id`, enumerated **at
runtime** from `templates.json` + the host (NOT a hardcoded bundled list — note the
bundled set is whatever `gen-templates.mjs` emits, currently 5 categories incl.
`lb-ide-host`, not 4). A user/fetched template with the same id as a bundled one
**shadows** it (visible "(custom)" / source badge). Deleting a shadowing user
template reveals the bundled one again.

**Intra-disk collision (design-review P2):** tier 2 (user) and tier 3 (fetched)
share `lb-ide/templates/` and the same id namespace — a naive `saveTemplate` would
let a fetched template silently clobber a user one (or vice-versa). Resolve by
**namespacing fetched templates on disk** as `<sourceId>__<id>.json` (so refresh/
remove-by-source is a group op and never touches user templates), keeping user
templates at `<id>.json`. `saveTemplate` of a user id that already exists is an
explicit overwrite (prompt/confirm); cross-tier ids merge by the shadow rule above.

### 1.1 Template document format (one per template)

A template is the SAME shape as a `categories[]` entry already in `templates.json`,
plus provenance metadata — so the New menu treats all tiers uniformly:

```jsonc
{
  "id": "my-esp",                 // [a-z0-9._-], unique within the merged set
  "name": "My ESP starter",
  "description": "…",
  "lang": "ts",                   // ts | js  (drives entry + filtering)
  "base":   { "files": { "main.ts": "…", "lib/util.ts": "…" } },
  "examples": [],                 // optional, same as bundled
  "aux": [],                      // supporting (non-source) file list
  "origin": "user" | "fetched" | "bundled",
  "sourceId": "wunk-official",    // present iff origin=fetched (groups by source)
  "createdAt": 0, "updatedAt": 0
}
```

Files are inlined as strings (text-only, like today). Stored at
`lb-ide/templates/<id>.json`. We reuse the host's **storage mechanism** (the same
sanitize-id + atomic file write as `lb-ide/projects/`), but **template and project
are distinct schemas** (a project carries `templateId/folders/openTabs/active`; a
template carries `base.files/examples/aux/origin/sourceId/lang`) — so templates get
their **own endpoints, own dir, own validation**; we do NOT round-trip a template
through the project read path. **No live link:** creating a project from a template
is **copy-on-create** (matches today's `createProject`, which just copies files and
records `templateId` as a label). There is no "update project from template"
propagation in v1 — state this so it isn't discovered mid-build.

### 1.2 Template SOURCE (a "repo") format

A **source** is a named, user-added origin templates can be fetched from. Two
candidate formats — **recommend (A)** for v1, keep (B) as a documented extension:

- **(A) Manifest + raw files over HTTP(S) [RECOMMENDED].** A source is a base URL
  serving a `templates.json` **manifest**:
  ```jsonc
  { "version": 1, "templates": [ { "id","name","description","lang",
        "files": { "main.ts": "main.ts" } /* relpath → fetch path */ } ] }
  ```
  The editor/host fetches the manifest, then each listed file (relative to the base
  URL). Works for a GitHub raw URL, a gh-pages site, our own deploy, or any static
  host. No git client needed. **This is also exactly the shape our own default repo
  takes** (we can publish `templates.json` + files to the existing deploy).
  **Parity note (design-review P2):** the manifest must also carry `examples[]` and
  `aux[]` (same as the bundled format), else fetched templates are flatter than
  bundled ones (a two-class New menu). v1: support `examples`/`aux` in the manifest;
  if we choose to ship base-only first, document that limitation explicitly.
- **(B) Git checkout** — clone a repo, read a `templates/` dir. Powerful but needs a
  git client (the in-client host has none; the browser can't clone). **Out of scope
  for v1** — note it as a possible host-side follow-up.

A configured source is just `{ id, name, baseUrl, addedAt }`. The **default source**
is our own repo (pending scorpion's confirm on the exact URL — likely the published
`templates.json` under the existing deploy, or the GitHub raw of `lb-scripting`).
Users add more by URL.

### 1.3 Fetch mechanism: editor-fetch vs host-fetch

Who performs the HTTP fetch of a source manifest + files:

- **Editor-fetch (browser):** lean `fetch`es the source URL directly. Simple, no new
  host surface. BUT: subject to **CORS** (arbitrary repos won't send permissive CORS
  → fetch blocked) and **mixed-content** (https editor → http source blocked). Good
  enough for CORS-enabled sources (GitHub raw sends `access-control-allow-origin: *`),
  not for arbitrary ones.
- **Host-fetch (in-client / Java server):** the editor asks the host to fetch the
  source; the host does the HTTP and returns the templates. **Avoids browser CORS**
  (server-to-server) and works for any reachable URL. BUT introduces an **SSRF
  surface** (the host fetches a user-supplied URL — see §3) and needs an HTTP client
  in the host (the in-client GraalJS host can use `java.net.http.HttpClient`; the Java
  server already has raw sockets but would need a small HTTPS client — JDK `HttpClient`
  is available there too).

**Recommendation:** support **both**, editor-fetch first (default for the bundled
source + CORS-enabled sources), host-fetch as an opt-in "fetch via client" path
behind the SSRF guard (§3). v1 can ship **editor-fetch only** (no new SSRF surface)
and add host-fetch as a gated follow-up — flag this as a scope decision for scorpion.

## 2. Bridge template CRUD (HTTP + WS + host)

New bridge ops, mirroring the existing `projects()`/`scripts()` pattern (read-only
list/get are unauthenticated-but-token'd; writes are token'd; **no userGesture**
needed — these touch files, not run code):

- `templates()` → list user/fetched template docs (`GET /api/templates`).
- `template(id)` → one template doc (`GET /api/template?id=`).
- `saveTemplate(doc)` → write `lb-ide/templates/<id>.json` (`POST /api/template`).
- `deleteTemplate(id)` → remove it (`POST /api/template/delete` or `DELETE`).
- **(if host-fetch)** `fetchTemplates(sourceId|url)` → host fetches the manifest +
  files, validates (§3), writes them, returns the imported set
  (`POST /api/templates/fetch`). **This is the SSRF-sensitive op.**
- Sources list/add/remove: `templateSources()` / `addTemplateSource({name,baseUrl})`
  / `removeTemplateSource(id)` stored at `lb-ide/template-sources.json`.

All three implementations: in-client host (`apps/host/src/server.ts` + a new
`templateStore.ts`), the pure-Java server (`Ops`/`FileOps` + routes + WS dispatch,
same id-sanitize as `script()`), and the bridge client (`bridge.js`, HTTP + WS — and
WS **must** get them too, the lesson from the Open-reorg review). `saveTemplate`/
`deleteTemplate` should resolve to **parsed JSON on BOTH transports** (don't repeat
`save()`'s raw-Response-on-HTTP vs parsed-on-WS asymmetry).

## 3. SECURITY (the load-bearing section)

Templates are **code the user edits, builds, and runs in their Minecraft client**.
A malicious template is a direct **RCE-on-the-user** path *if they build+run it*.
And **host-fetch of user-supplied URLs is an SSRF surface**. Trust model:

1. **No auto-run, ever — BUT "read before run" must cover more than `main.ts`.**
   Fetching/saving a template only writes text files; creating a project only
   populates the editor; running needs the existing `userGesture`-gated load. So
   nothing executes on fetch. **However (security-review P1):** "no auto-run" only
   covers the *runtime* load — it does NOT make a template safe to *build*. A
   template ships more than `main.ts`: its `aux[]` files are copied verbatim into the
   new project (`createProject`), and `rawBuildConfig()` auto-parses a smuggled
   `lbbuild.config.json` into the esbuild call — where **`banner`/`footer` are emitted
   RAW into the output `.mjs`** and `define` values are raw JS. So a malicious
   template can inject code the user never sees in `main.ts` but that lands in the
   artifact they then run, AND `entry` can silently redirect the entry point. This
   **defeats the "user reads the code before running" assumption the whole trust
   model rests on.**
   **MITIGATION (must build):** treat every non-source file in a *fetched/user*
   template as untrusted on import — (a) **strip** `lbbuild.config.json`, `.vscode/`,
   and dotfiles, OR (b) hard-validate an imported build config against an allow-list
   of safe keys, **rejecting `banner`/`footer` outright**, validating `define` values,
   and ignoring `entry` redirection. Surface "this template ships a build config / aux
   files" prominently in the import UI. The provenance badge gives false assurance
   unless this is fixed (the danger isn't in the visible `main.ts`).
2. **Explicit, user-added sources only.** No source is contacted unless the user
   added it (the bundled default aside). The New menu shows the **source/origin**
   on every non-bundled template so provenance is visible. No silent background
   fetching; fetch is an explicit action.
3. **SSRF guard on host-fetch** (only if/when host-fetch ships — **v1 recommendation:
   ship editor-fetch ONLY, so this surface is zero**; see §1.3):
   - **Prefer an ALLOW-LIST of source hosts** (GitHub raw, our deploy) for v1; the
     deny-list below is defense-in-depth, not the primary control (deny-lists are
     brittle against the encodings listed).
   - Scheme allow-list: `https://` only (localhost `http` only for explicit dev) —
     reject `file:`/`gopher:`/`ftp:`/…
   - **Pin the resolved IP and connect to THAT IP** — do not "re-check then let the
     HTTP client re-resolve" (DNS-rebinding TOCTOU). Validate the canonical IP, then
     dial the pinned address.
   - **Canonicalize before range-checking** and reject: RFC1918 (10/8, 172.16/12,
     192.168/16), 127/8, 169.254/16 (incl. 169.254.169.254 metadata), `0.0.0.0`,
     IPv4-mapped IPv6 (`::ffff:127.0.0.1`), `::1`, ULA `fc00::/7`, link-local
     `fe80::/10`, and decimal/octal/hex IP encodings. Reject all non-global IPv6.
   - Redirects: cap (≤3) and **re-validate + re-pin each hop**.
   - Bound the request: manifest ≤256 KB, each file ≤512 KB, total ≤4 MB, file count
     ≤200, timeout ≤10 s.
4. **Fetched-content validation** (host AND editor side):
   - Manifest must parse as the v1 schema; reject otherwise.
   - **Path safety**: the template **`id` is a single safe segment** — `[a-z0-9._-]`,
     **no `/`, no `.`-only** (so `id` can never escape `lb-ide/templates/` into
     `projects/`). File **relpaths** allow `/` (`[a-zA-Z0-9._/-]`, no `..`, no leading
     `/`, no backslashes) — but because `/` is allowed, this must be PAIRED with the
     content policy in (1): a relpath like `lbbuild.config.json` or `.vscode/settings.json`
     passes path-shape, so it's the import content-policy (strip/validate), not the
     path check, that neutralizes config injection.
   - **Text-only**: reject non-text/binary (the model is text files); enforce UTF-8.
   - Size caps as above, enforced per-file AND in aggregate **during parse**, before
     any write (a small manifest can list many files).
5. **The token + Origin model is unchanged** — all template `/api` calls require the
   per-session `X-IDE-Token`; the Java server's WS Origin allowlist still gates the
   hosted path. No new CORS/ACAO on the host (same-origin-only HTTP preserved).
6. **Editor-fetch caveat**: when the *browser* fetches a source, the SSRF guard
   doesn't apply (the browser already can't reach the user's localhost cross-origin,
   and same-origin/PNA protections apply) — but content validation (schema, path,
   size, text-only, AND the §3.1 config/aux policy) still runs editor-side before
   anything is saved via the token'd bridge.
7. **Never send the token to a source.** A source URL is user-controlled, so source
   fetches (editor OR host) MUST use a bare request — `fetch(sourceUrl, {credentials:
   "omit"})` with **no `X-IDE-Token`** — and must NOT reuse the bridge `call()` (which
   attaches the token to the host base). Host-fetch must not forward the token outbound.
   This keeps a malicious source from harvesting the session token.

**Net trust statement:** adding a source = "I trust this URL to suggest starter
code I will read before running." Fetching never executes; host-fetch is SSRF-guarded;
all writes are sanitized + size-bounded.

## 4. UI

**Lean (primary):**
- **New menu**: the existing template categories, now merged across tiers. Each
  non-bundled entry shows a small **origin badge** (user / source name). "Blank
  project" unchanged.
- Two new New-menu actions (or a small **Templates** manager dialog):
  - **Save as template…** — from the current project: prompts id/name, writes via
    `saveTemplate` (origin=user). (Files = current project's source files, aux carried.)
  - **Duplicate & edit** — pick any template → opens it as a NEW project (the existing
    `createProject` path) so the user modifies a copy, then optionally Save as template.
- **Template/Source manager** (a panel/dialog): list user+fetched templates (delete,
  see source), list sources (add by name+URL, remove), and **Fetch from source**
  (runs the fetch, shows imported count, validation errors surfaced inline).
- Offline/static deploy: manager shows tier-1 only + "connect to a client to manage".

**Heavy (lean-primary, minimal):** heavy has no New-from-template flow. Scope for v1:
the **Open** QuickPick (just shipped) can gain a **"New from template"** group that
lists the merged templates and, on pick, creates a project on the bridge
(`bridge.save`) + opens it at `lbfs://<id>/`. "Save as template" from heavy is a
possible follow-up. **Recommend: defer heavy template UI** beyond maybe listing —
confirm with scorpion.

## 5. Build order (once greenlit) + open questions

Reviewable steps, lean green each step, sub-agent review at the boundary:
1. **Bridge template CRUD** (HTTP+WS) + host (`templateStore.ts`) + Java
   (`Ops`/`FileOps`/routes) — list/get/save/delete + sources. No fetch yet.
2. **Lean New-menu merge** (tier1 ∪ host templates) + origin badges. Lean stays green.
3. **Save-as-template + Duplicate-and-edit** (lean). Includes the §3.1 import
   content-policy (strip/validate build-config + `.vscode/`/dotfiles).
4. **Fetch-from-source** — **editor-fetch only for v1** (SSRF surface = 0), with full
   content validation; host-fetch is a gated follow-up only if approved (then it must
   ship the §3.3 allow-list + IP-pinning guard).
5. **Template/source manager UI** (lean).
6. **(optional) heavy "New from template"** group in the Open QuickPick. If it lands,
   blocklist `.vscode/`/dotfiles on import (heavy vscode-web DOES honor those, unlike
   lean Monaco).

**Open questions for scorpion:**
- **Default source URL** — published `templates.json` under the existing deploy, or
  GitHub raw of `lb-scripting`? (drives §1.2)
- **Host-fetch in v1, or editor-fetch only?** — **recommend editor-fetch only** (zero
  SSRF surface). Host-fetch only if you need arbitrary non-CORS sources.
- **Build-config in fetched templates: strip or validate?** §3.1 mitigation (a) strip
  vs (b) allow-list-validate. Recommend **strip** for v1 (simplest, safest).
- **Git-checkout sources** — needed, or is manifest+raw (A) sufficient?
- **Heavy scope** — list-and-create in the Open QuickPick, or fully defer?
