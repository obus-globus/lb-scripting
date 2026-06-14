# Proposal — make this the main repo (monorepo for LB scripting)

Goal: pull the scattered LiquidBounce-scripting pieces into **one repo** so changes
are atomic, the editor builds everything from in-repo sources (no vendored
snapshots / no sibling-repo dependency), and there's one CI.

This is a **plan for discussion** — it involves moving published packages and
repos that have their own history/collaborators, so it needs sign-off before
execution. Two real constraints drive the shape (below): the **types package is
huge**, and **a repo has one visibility**.

## The pieces (all under github.com/obus-globus)

| repo | what | bring in? |
|---|---|---|
| `lb-script-api-types` | `@wunk/lb-script-api-types` typings — **~96 MB / 56k .d.ts** | ⚠️ generated; don't commit the .d.ts |
| `lb-ts-generator` | regenerates the types | maybe (tools/) |
| `lb-inject` | runtime injection lib (small) | ✅ yes |
| `lb-inject-template` · `lb-script-template-js` · `lb-script-template` · `lb-web-ide/template` | the starter templates | ✅ yes |
| `lb-nodeflow` | node-graph editor (separate product) | later / keep separate |
| this repo | editor + host | the root |

## Two constraints that shape it

1. **The types are 96 MB / 56k files.** Committing them would bloat every clone
   forever. They're *generated* (by `lb-ts-generator`) and *published to npm*.
   → **Don't vendor the .d.ts.** Either keep `@wunk/lb-script-api-types` as an
   external npm dep (simplest — the editor already installs it), or bring the
   types *project* in but `.gitignore` the generated `typings/types/**` and
   regenerate on build.
2. **A GitHub repo has one visibility.** You've said templates/types will go
   public; if the host or internal tooling should stay private, they can't share
   a repo. → Keep **public-bound** things (templates, types, lb-inject, editor)
   together; keep anything that must stay private out (or make the whole thing
   public once it's ready).

## Recommended structure (npm workspaces)

Lean monorepo — brings in the things that are actually coupled (templates +
lb-inject + the two apps); keeps the giant types on npm.

```
lb-scripting/                 (rename of this repo; "main repo")
  package.json                # private root, workspaces: apps/*, templates/*, packages/*
  README.md  docs/  .github/workflows/
  packages/
    lb-inject/                # ← lb-inject (runtime lib + its .d.ts + vendored agent jars)
  templates/
    minimal-ts/               # ← lb-web-ide/template
    plain-js/                 # ← lb-script-template-js
    starter-ts/               # ← lb-script-template
    inject-ts/                # ← lb-inject-template
  apps/
    editor/                   # ← app/  (the browser IDE)
    host/                     # ← host/ (the in-game LB script)
  tools/                      # (optional, later)
    ts-generator/             # ← lb-ts-generator
    script-api-types/         # ← lb-script-api-types (typings/ gitignored, regenerated)
```

`@wunk/lb-script-api-types` stays an npm dependency pinned in the templates +
editor (today's setup), unless/until you want the generator in-repo too (tools/).

## How each piece rewires

- **templates** → depend on `@wunk/lb-script-api-types` and `lb-inject` via
  **workspace** (`"lb-inject": "workspace:*"`) instead of copies, so the inject
  template uses the in-repo lib.
- **editor/gen-templates.mjs** → already isolated to one `VENDOR` constant; point
  it at `../../templates/*` (live) instead of `app/vendor/templates` (snapshot).
  Delete the vendored snapshot.
- **editor/gen-typings.mjs** → unchanged (reads the npm `@wunk` package), or reads
  `tools/script-api-types/typings` if the types come in-repo.
- **editor** → builds the `lb-inject` bundle from `packages/lb-inject/dist`.
- **host/package.mjs** → already builds `apps/editor` → `dist/`; just a path bump.
- **CI** → one workflow, jobs: build packages/lb-inject, typecheck each template,
  build+verify editor, build host. (Today's two jobs, plus a template-typecheck
  matrix.)

## Migration (preserve history)

Use `git subtree` so each repo's commit history is retained under its new path:

```
git subtree add --prefix=packages/lb-inject   https://github.com/obus-globus/lb-inject       main
git subtree add --prefix=templates/inject-ts  https://github.com/obus-globus/lb-inject-template main
…etc
```

Then rewire deps to workspaces, repoint `gen-templates`, drop `app/vendor/`,
move `app/`→`apps/editor`, `host/`→`apps/host`, add the root `package.json`
workspaces. Archive the absorbed repos (or leave them as read-only mirrors).
`npm publish` for `lb-inject` / the types still happens from their package dirs
(CI on tag).

## Tradeoffs / open questions (need your call)

1. **Repo name / identity** — keep `lb-ide-explore`, or rename to e.g.
   `lb-scripting` / `liquidbounce-scripting`? (rename is one click on GitHub.)
2. **Visibility** — make the monorepo **public** (templates/types are meant to be
   public)? If the host must stay private, it can't be in the same repo.
3. **Types** — leave `@wunk/lb-script-api-types` on npm (recommended, avoids 96 MB
   bloat), or bring the generator in (`tools/`) and regenerate locally?
4. **nodeflow** — separate product; bring in as `apps/nodeflow` later, or leave
   it standalone?
5. **History** — `git subtree` (keep history, bigger) vs fresh copy (clean, loses
   provenance)?

## Suggested phasing

```
P1  Root npm-workspaces scaffold; move app→apps/editor, host→apps/host (no behavior change).
P2  Bring templates in (subtree) → templates/*; repoint gen-templates; delete app/vendor/.
P3  Bring lb-inject in → packages/lb-inject; templates use it via workspace.
P4  (optional) tools/ts-generator + tools/script-api-types; one CI; archive old repos.
P5  (optional) apps/nodeflow.
```

Each phase is independently shippable and keeps CI green.
