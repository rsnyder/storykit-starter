# Central editor — architecture addendum

Status: **Implemented 2026-07-08** (this document is the plan of record for
the change; `docs/editor-spec.md` remains the editor's functional spec).

## Decision

One editor instance serves all StoryKit repos, deployed at
**https://rsnyder.github.io/storykit-editor/** from the deploy-only repo
`rsnyder/storykit-editor`. Site repos no longer carry `editor/`.

A user saves one fine-grained PAT (Contents read/write on the repos they
author in) and can open/bind/commit documents in **any repo they have write
access to** — binding was always per-document (`doc.github = {owner, repo,
branch}`), so the store, sync machine, conflict flow, badges, `openFromGitHub`
and the `?open=` bookmarklet are repo-agnostic already.

## Source of truth stays here

`editor/` + `assets/js/skrender.js` continue to be **developed, tested and
golden-gated in rsnyder/storykit-starter** — nothing about the verification
battery moves. The central repo is a publish target only: its own GitHub
Actions workflow checks out `rsnyder/storykit-starter@main`, assembles the
artifact, and deploys it to Pages. Re-publishing is `gh workflow run deploy
-R rsnyder/storykit-editor` (also on a daily cron as a safety net).

Published artifact layout (repo root = Pages root):

    index.html, *.js, styles.css      ← editor/*
    assets/js/skrender.js             ← unchanged path segment

`editor/preview.js` resolves skrender by trying `../assets/js/skrender.js`
(per-site layout: page at `<site>/editor/`) then `./assets/js/skrender.js`
(central layout: page at repo root). No other path assumptions exist — the
import map and intra-editor references are all page-relative.

## Asset-origin policy (the substantive change)

A bound document's context still comes entirely from the **bound repo**:
`_config.yml` (url/baseurl/lang/theme settings), layouts, includes, data
files, and media (raw.githubusercontent for uncommitted content, the deployed
site + Cloudinary proxy for committed assets). What changes is *framework*
assets:

- **Framework runtime assets are rewritten to the canonical origin**
  (`https://rsnyder.github.io/storykit-starter`): viewer component pages
  (`/assets/components/*.html`), the host runtime (`/assets/js/storykit.js`,
  `storykit-component.js`), and `assets/css/storykit.css`.
- Rationale: the bound site may be undeployed (fresh repo) or framework-stale
  (sync-pin lag); the canonical is always current and always deployed.
  Cross-origin component embedding is a supported, e2e-pinned topology as of
  2026-07-08 (referrer-derived trust in `storykit-component.js`;
  `registerComponentOrigins()` in `storykit.js`).
- Mechanism: `skrender.renderPost` accepts an optional
  `context.frameworkAssetOrigin`; when set, a post-render pass rewrites
  framework-asset URLs that point at the bound site to that origin. Default
  is **unset** (per-site preview tools and goldens are byte-identical with
  and without the feature compiled in).
- Unbound documents already preview against the canonical starter (existing
  `context.js` fallback) — in a central editor that is simply the correct
  default rather than a quirk.

## UI deltas

- Document-list rows show an `owner/repo` chip for bound documents (one list
  now spans repos).
- Sync panel is unchanged — per-document binding fields already accept any
  owner/repo.

## Cutover

1. Site repos: `editor/*` leaves `FILES_TO_SYNC` (per-repo copies would
   otherwise go permanently stale). `assets/js/skrender.js` and
   `preview/index.html` **stay** in the manifest — the per-site preview tool
   still uses them.
2. `rsnyder/storykit`: editor files replaced by a single redirect stub at
   `/editor/index.html` pointing to the central editor (bookmarks keep
   working).
3. `_admin/index.md` Tools section links to the central URL.
4. Browser-local documents don't migrate across origins (IndexedDB is
   per-origin); drafts worth keeping should be committed or exported before
   switching. Bound documents are trivially re-opened from GitHub in the
   central editor (`Open…`, drag, or bookmarklet).

## Explicitly out of scope (v1)

- Per-repo "use this site's own components" override (framework assets are
  always canonical in previews; the deployed site itself is unaffected).
- A repo browser/picker beyond the existing binding fields + `Open…` entry
  points.
- Automatic draft migration between editor origins.
