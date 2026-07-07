# StoryKit Editor — Execution Plan

Companion to [`editor-spec.md`](editor-spec.md) (the authoritative requirements document; FR-* references below point there). This document is the working reference for the implementation: frozen module contracts, work-package (WP) definitions, dependency lanes, and verification gates. Implementation agents MUST read the spec sections referenced by their WP plus §1–§2 of this document before writing code.

## 0. Ground rules

1. **The spec is settled.** Do not redesign the product. Ambiguities are resolved by the spec first, this plan second; anything still ambiguous is logged in the WP handoff notes, not decided unilaterally.
2. **Contracts are frozen.** The module names and export signatures in §1 are the integration surface. Feature WPs code against them exactly. If a contract proves wrong, the WP documents the problem in its handoff notes and works around it locally; only integration WPs (2.6, 3.4, 4.3) change contracts.
3. **File ownership.** Each feature WP touches only its own module file(s) + its test file(s). Shared files — `editor/index.html`, `editor/app.js`, `editor/styles.css` — are owned by WP-2.1 (scaffold) and integration WPs only.
4. **Buildless discipline.** No bundler, no npm. Dependencies are pinned exact versions in the `editor/index.html` import map (esm.sh), registered in `docs/dependencies.md`, and guarded by `tools/check_editor_pins.py`. The dev machine has no Node.js; all tests run in-browser (unit) or via Python Playwright (e2e).
5. **Hermetic tests.** No test may depend on live network. GitHub API, jsDelivr/Chirpy CDN, Wikidata, and YouTube endpoints are intercepted with Playwright `page.route()` and served from the local working tree or committed fixtures.
6. **Environment.** Local Jekyll: `bundle exec jekyll build` / `serve` (Ruby 3.4.9). Playwright: Python venv (`python3 -m venv venv && pip install playwright`); Chromium builds are cached under `~/Library/Caches/ms-playwright` on the dev machine. Port 4000 may be occupied by the main working tree's dev server — test scripts must accept a `--port` / pick a free port.

## 1. Frozen interface contracts

### 1.1 `assets/js/skrender.js` — shared renderer (M1)

```js
export async function renderPost({ content, path, context })
//   → { html: string, diagnostics: Diagnostic[] }
// content: full markdown source including front matter
// path:    repo-relative path, e.g. "_posts/2026-01-10-monument-valley.md"
// context: {
//   config:      object,                        // parsed _config.yml
//   locales:     object|null,                   // parsed _data/locales/<lang>.yml
//   layouts:     Map<string,{frontMatter,body}>,// OPTIONAL pre-seed; misses fall through to resolveFile
//   includes:    Map<string,string>,            // OPTIONAL pre-seed; misses fall through to resolveFile
//   resolveFile: async (repoRelPath) => string|null, // THE injection seam — called lazily MID-RENDER
//   assetOrigin: string,                        // deployed origin for URL rewriting (?dev override lives in caller)
//   baseurl:     string,
//   origin:      object|null,                   // parsed _data/origin/default.yml (WP-1.2 delta; omit → origin-driven <link> tags absent)
//   rawContentBase: string,                     // base URL for rewriting relative content links (WP-1.2 delta; '' for unbound drafts)
// }
// Diagnostic: { level:'error'|'warn'|'info',
//               stage:'frontmatter'|'liquid'|'markdown'|'layout'|'fetch',
//               message: string, line?: number }

export function parseFrontMatter(text)              // → { frontMatter, body, fmEndLine }
export function createResolveFileCache(resolveFile) // memoizing wrapper (per-session hit/miss cache)
```

Owns pipeline steps 4–5 and 7–10 of the current `preview/index.html` `render()` (:1064): Liquid engine build, multiline-tag collapse, kramdown IAL handling, markdown render, layout-chain application (walking layouts via `resolveFile('_layouts/<name>.html')` when not pre-seeded), URL rewriting, footnote-CSS/Font-Awesome/banner injection. **No fetches except through `context.resolveFile`; no DOM access** — the caller writes `html` into its iframe and surfaces `diagnostics`.

Critical constraint (verified in exploration): Liquid includes resolve **lazily during template expansion** (`include` tag → `renderInclude` → fetch, `preview/index.html:743–784`), and includes nest (`embed/_iframe.html`). `resolveFile` must therefore be async and callable mid-render; the `layouts`/`includes` maps are optional cache layers only.

**As-built notes (WP-1.2, authoritative for WP-3.2/2.6):** layout-chain walking lives inside skrender via `resolveFile('_layouts/<name>.html')` (max depth 8, `compress` skipped); `resolveFile` returns `null` on miss (never throws); the host page must load the classic-script globals `window.liquidjs`, `window.markdownit` (+ optional footnote/sub/sup plugins), `window.jsyaml` before importing the module; `parseFrontMatter` returns `{frontMatter, body, fmEndLine}`; a final `info`-level `layout` diagnostic carries the applied layout-chain summary.

### 1.2 Editor modules

```js
// editor/store.js  (WP-2.2) — IndexedDB via idb; DB name "storykit-editor", version 1
export async function initStore()
export const docs      = { list(), get(id), create({title,path,content}), update(id,patch), remove(id), duplicate(id) }
export const revisions = { snapshot(docId,content,reason), list(docId), get(revId), prune(docId) } // cap 20, ≥10 min spacing
export const repoCache = { get(key), put(key,{etag,content,fetchedAt}), makeKey({owner,repo,ref,path}) }
export const entityCache = { get(qid), put(qid,entity) }  // 30-day TTL enforced on get
export function createAutosaver(docId,{debounceMs=1500})  // → { push(content), flush() }; flush wired to visibilitychange/pagehide
export async function requestPersistence()                // navigator.storage.persist() → boolean
// Document record fields per spec FR-DOC.2 (ULID ids).

// editor/editor.js  (WP-2.3)
export function createEditor({ parent, initialContent, extraExtensions=[] })
//   → { view, getContent(), setContent(str), focus(), destroy() }
// emits bus event 'doc:changed' (debounced 250 ms) with {content}

// editor/lang-storykit.js  (WP-2.4)
export function storykit({ catalog, getIncludeList, getDocViewerIds })  // → Extension[]
// highlight + autocomplete + lint + QID decoration; label resolver injected later by wikidata.js

// editor/viewer-catalog.js  (WP-0.2) — pure data
export const catalog            // { "embed/image.html": { doc, attrs: { src:{type,required,doc}, ... } }, … ×6 }
export const bundledIncludeList // Object.keys(catalog)
export const fallbackTemplate   // string copy of _posts/.template.md

// editor/url-grammars.js  (WP-0.3) — pure, data-driven grammar table
export function parseDropPayload({ uriList, text, html })
//   → { kind:'commons'|'youtube'|'maps'|'maps-short'|'link'|'unknown', tag?, chipLabel?, message? }

// editor/github.js  (WP-3.1) — direct fetch, no Octokit; token key 'jekyllPreviewPAT' (shared with preview tool)
export function getToken() / setToken(t) / forgetToken()
export async function getFile({owner,repo,ref,path,etag})       // → {content,sha,etag} | 'not-modified' | null
export async function putFile({owner,repo,branch,path,content,message,sha}) // → {sha}
export async function getRepo({owner,repo})
export async function listBranches({owner,repo}) / getBranchHead({owner,repo,branch})
export async function createBranch({owner,repo,name,fromSha})
export class GitHubError extends Error {}  // { status, kind:'auth'|'conflict'|'rate-limit'|'not-found'|'network' }

// editor/context.js  (WP-3.2)
export async function buildContext({ binding /* {owner,repo,branch} | null */ })
//   → context in the skrender shape; resolveFile chain: repoCache (ETag revalidate) →
//     GitHub (bound) | deployed starter defaults (unbound) → miss-cache

// editor/preview.js  (WP-3.3)
export function createPreviewPane({ mount })  // → { render({content,path,binding}), destroy() }
// scroll restored across srcdoc replacement by nearest-heading anchor

// editor/wikidata.js  (WP-4.2)
export async function searchEntities(q,{signal})  // wbsearchentities, origin=*
export async function getEntities(qids)           // batched wbgetentities, entityCache-backed
export function linkEntityCommand(view)           // ⌘⇧K command
export function qidHoverExtension()               // hover cards on [text](Q…) links

// editor/dnd.js  (WP-4.1)
export function dndExtension({ onNotice })  // CM6 drop/paste handlers over url-grammars

// editor/sync.js (WP-5.1), editor/conflict.js (WP-5.2):
export async function resolveConflict({ local, remote })  // → 'mine' | 'remote'   [conflict.js]
// INVARIANT: revisions.snapshot() MUST complete before any resolution executes.

// editor/app.js (scaffold; edited only by WP-2.1 and integration WPs)
export const bus = new EventTarget()  // events: doc:changed, doc:saved, mode:changed, sync:status, lint:count, toast
export const appState = { currentDocId, mode, binding, prefs }
```

## 2. Verification infrastructure

- **Browser unit tests:** `tests/unit/index.html` (import-map page) + `tests/unit/runner.js` (describe/it/assert → `window.__testResults` + DOM) + `tools/run_browser_tests.py` (Playwright runner, exit code). Built in WP-0.1.
- **Render regression (the M1 gate):** `tools/render_regression.py` drives `preview/index.html` hermetically — `page.route()` intercepts `api.github.com/repos/*/contents/*` (served base64-JSON from the local tree) and `cdn.jsdelivr.net/gh/cotes2020/*` (committed fixtures in `tests/render/fixtures/cdn/`) — and captures the iframe's **pre-JS `srcdoc` string** per corpus entry. `--capture` writes `tests/render/golden/<slug>.html`; `--check` byte-compares with a unified diff on failure. Corpus manifest `tests/render/corpus.json`: the 12 embed-bearing files (`_posts/2026-01-10-monument-valley.md` + the 11 `_admin` guides containing `{% include embed/`). Determinism (two identical consecutive captures) is an acceptance criterion.
- **E2E:** `tests/e2e/conftest.py` (server + interception helpers) + per-milestone `test_m*.py` Playwright suites, all network-mocked (`tests/e2e/github_mock.py` provides stateful GitHub contents/refs semantics for M5).
- **CI:** `.github/workflows/editor-checks.yml` — Jekyll build → serve `_site` → regression `--check` → browser unit tests → `check_viewer_catalog.py` + `check_editor_pins.py`. Runs alongside the existing `check_consistency.py` / `sync_code.py --check`.

## 3. Work packages

Allocation: **[O] = Opus** (complex / high-risk / architecturally sensitive), **[S] = Sonnet** (well-specified / mechanical). Each WP ends with handoff notes (what was built, deviations, contract friction) for the integrator.

### Lane 0 — Foundations (no dependency on the preview refactor)

- **WP-0.1 [S] Browser unit-test harness.** Files: `tests/unit/index.html`, `tests/unit/runner.js`, `tools/run_browser_tests.py`. Accept: seeded passing + deliberately failing samples produce exit 0/1; page usable manually.
- **WP-0.2 [S] Viewer attribute catalog.** Curate `editor/viewer-catalog.js` from `_includes/embed/*.html` (ground truth: `include.<attr>` usages) + `_admin/*-viewer.md` doc lines; include action-link grammar data and `fallbackTemplate`. Add `tools/check_viewer_catalog.py` (greps `include.<attr>` vs catalog; fails on drift). Accept: all 6 embeds + `_iframe.html` passthrough attrs covered; drift check red/green correct.
- **WP-0.3 [S] URL grammar module.** `editor/url-grammars.js` per FR-DND.2/3/4/6 (Commons file-page/`Special:FilePath`/`upload.wikimedia.org` thumb URLs → canonical `wc:` filename; YouTube watch/youtu.be/shorts/embed + `t=` → `start` seconds; Maps `/@lat,lng,zoomz`, `?q=`, `/place/<name>/@…` → center/zoom/caption, zoom 1-decimal, omit when absent; `maps.app.goo.gl` → degrade message; unknown → plain link). Tests: `tests/unit/url-grammars.test.js`, ≥25 cases incl. negatives. Deps: 0.1.

### Lane A — M1 Renderer extraction (sequential) → **M1 GATE (pause for review)**

- **WP-1.1 [O] Regression harness + baseline.** Files: `tools/render_regression.py`, `tests/render/corpus.json`, `tests/render/golden/*` (12), `tests/render/fixtures/cdn/*` (one-time `--record-fixtures` mode allowed for the initial capture). Accept: determinism proven; mutation → readable diff; zero live network (route audit asserts).
- **WP-1.2 [O] Extract `skrender.js`; migrate preview shell.** Move the pure functions (`parseFrontMatter` :277, `buildLiquidEngine` :548 with the `o,r,ref`+`fetchFile` closure replaced by `context.resolveFile`, `collapseMultilineTags` :821, `parseIAL` :853, `injectAttrsIntoTag` :869, `applyKramdownAttributes` :892, `rewriteRelativeUrlsInString` :965, markdown-it setup :197, render steps 4–5/7–10) into `assets/js/skrender.js` per §1.1. `preview/index.html` becomes a thin shell: payload parsing, GitHub fetching, caches, context build, `renderPost` call, `srcdoc` write, status badges. Load via `<script type="module">` (convention: `_layouts/post.html:362`). Accept: `--check` byte-identical ×12; `?dev`, no-token, and rate-limited paths smoke-tested; `tools/check_consistency.py` green.
- **WP-1.3 [S] CI wiring.** `.github/workflows/editor-checks.yml` + `tools/check_editor_pins.py` stub. Accept: green on branch push; red on deliberate golden mutation (then reverted).

### Lane B — M2 Core editor → **M2 GATE (pause for review)**

- **WP-2.1 [O] Scaffold + contract freeze.** `editor/index.html` (complete pinned import map for M2–M5; CM6 via esm.sh with `?deps=` dedupe; **runtime assertion of a single `@codemirror/state` instance**), `editor/styles.css` (3-region layout §7, light/dark tokens, Chirpy font stack, 8 px grid), `editor/app.js` (bus/appState/prefs), JSDoc'd stub files for every §1.2 module. Runs parallel to WP-1.2. Accept: bare CM6 editing works from CDN with zero console errors in both themes; all stubs importable; pins registered in `docs/dependencies.md` + checked by `check_editor_pins.py`.
- **WP-2.2 [S] Store.** `editor/store.js` + `tests/unit/store.test.js` per §1.2 and FR-DOC.2/3/4/8. Deps: 2.1, 0.1.
- **WP-2.3 [S] Base editor.** `editor/editor.js` + `editor/commands.js`: lang-markdown (GFM) with YAML front-matter sub-language, history/search/close-brackets/drop-cursor/active-line, FR-EDIT.6 shortcuts, word-count + cursor position on bus. Deps: 2.1.
- **WP-2.4 [O] StoryKit language extension.** `editor/lang-storykit.js` + tests: FR-EDIT.2 highlighting (distinct tokens for tag delimiters / include path / attr names / attr values, `{% raw %}`, kramdown IAL), FR-EDIT.3 autocomplete (catalog + `getIncludeList`; `name=""` cursor-between-quotes), FR-EDIT.4 lint as viewport-scoped incremental diagnostics (unknown include, unknown attr, curly quotes in tags, action-link id with no matching viewer id, vis-network missing `<id>-csv` block), FR-EDIT.5 QID decoration hook, FR-EDIT.7 front-matter YAML diagnostics. Perf: decoration update < 16 ms on a 50 KB doc (asserted in test via `performance.now`). Deps: 2.1, 0.2.
- **WP-2.5 [S] Document list.** `editor/doclist.js`: FR-DOC.5 panel + actions, FR-DOC.6 new-from-template (`fallbackTemplate` when unbound) + `yyyy-mm-dd-slug.md` generation, FR-DOC.7 import/export. Deps: 2.1 (store stubs; parallel to 2.2).
- **WP-2.6 [O] M2 integration.** Replace stubs; reconcile contract drift (incl. WP-1.2 handoff deltas); autosave→store→doclist status loop; last-open restore. `tests/e2e/conftest.py` + `test_m2_persistence.py` (create → type → kill context → reopen → intact; autosave window ≤ 2 s; 50 KB smoke). Deps: 2.2–2.5 merged.

### Lane C — M3 Preview (needs M1 + M2 gates; 3.1 may run during Lane B) → **M3 GATE (pause)**

- **WP-3.1 [S] GitHub client.** `editor/github.js` per §1.2 + `tests/unit/github.test.js` (stubbed fetch; every endpoint; 401/403-rate-limit/404/409 mapping; token never in URLs or error messages — asserted). Deps: 2.1.
- **WP-3.2 [O] Context builder + cache.** `editor/context.js` per §1.2; unbound mode mirrors the preview shell's deployed-defaults + Chirpy-CDN logic; offline serves stale cache with a diagnostic. Deps: M1 gate, 2.2, 3.1. Accept: unit tests (hit/revalidate/miss/offline); hermetic e2e: unbound doc previews with zero GitHub requests.
- **WP-3.3 [S] Preview pane.** `editor/preview.js` + mode segmented control (+⌘E; split ≥ 1200 px; persisted), debounced re-render, nearest-heading scroll restore, inline diagnostics panel with editor line links, iframe sandbox matching `preview/index.html:185`. Deps: 2.6 (3.2 stub OK to start).
- **WP-3.4 [S] M3 integration.** Wire into app; `tests/e2e/test_m3_preview.py`: Monument Valley pasted into unbound doc → viewer markup present; **editor `srcdoc` byte-compared against the M1 golden** (`render_regression.py --target editor` mode); edit-to-preview < 2.5 s. Deps: 3.2, 3.3.

### Lane D — M4 Media & entities (parallel with Lane C after M2 gate) → **M4 GATE (pause)**

- **WP-4.1 [S] Drop/paste handlers.** `editor/dnd.js`: FR-DND.1 placement (posAtCoords, own line, surrounding blanks), §7 drag-over chip + insertion caret, FR-DND.5 post-insert selection + inline hint, FR-DND.7 paste affordance, FR-DND.6 fallbacks. Unit tests dispatch synthetic `DataTransfer`. Deps: 0.3, 2.6.
- **WP-4.2 [S] Wikidata.** `editor/wikidata.js` per §1.2 + FR-WD.1–4; registers label resolver into the WP-2.4 hook. Deps: 2.2, 2.6.
- **WP-4.3 [S] M4 integration.** Wiring + `tests/e2e/test_m4_media.py` (all URL shapes, paste affordance, mocked-Wikidata entity flow ≤ 3 interactions, offline degradation). Deps: 4.1, 4.2.

### Lane E — M5 GitHub sync (after M3 gate) → **M5 GATE (pause)**

- **WP-5.1 [O] Sync workflows + status.** `editor/sync.js` + `editor/statusbar.js`: FR-GH.1 token UI (copy states it also affects the preview tool), FR-GH.2 binding + branch create, FR-GH.3 commit + sha bookkeeping, FR-GH.5 pull + remote-changed banner, FR-GH.6 five-state machine + toasts. **Invariant: every buffer-replacing path snapshots to revisions first** (unit-tested). Deps: 3.1, 2.6.
- **WP-5.2 [S] Conflict dialog.** `editor/conflict.js` per frozen `resolveConflict` contract: three-choice dialog + side-by-side read-only diff (pinned diff lib added to import map + `dependencies.md`); snapshot-before-resolution asserted in tests. Deps: 5.1 contract (parallel OK against stub).
- **WP-5.3 [S] M5 e2e.** `tests/e2e/github_mock.py` (stateful contents GET/PUT with sha semantics, refs create, 409 on stale sha) + `test_m5_sync.py`: full round-trip + all three conflict resolutions + snapshot-exists + token-never-in-URL assertions. Deps: 5.1, 5.2.

### Lane F — M6 Polish (sequential, after all lanes) → **M6 GATE (done)**

- **WP-6.1 [S] Command palette + toolbar.** `editor/palette.js` (⌘K, focus-trapped, all commands + shortcuts), `editor/toolbar.js` (§7 minimal set incl. Insert-viewer menu from catalog). E2E keyboard-only walkthrough of spec workflows 1–4.
- **WP-6.2 [S] Visual polish.** Themes/empty states/toasts/skeletons/responsive collapse per §5.4–5.5; no CLS on async loads (Playwright trace). Deps: 6.1 (shared files — sequential).
- **WP-6.3 [O] A11y + performance audit.** axe-core AA via Playwright (`tests/e2e/test_a11y.py`); measure §5.3 budgets (first-interactive < 1.5 s warm, keystroke p95 < 16 ms on 50 KB, edit-to-preview < 2.5 s); remediate; decide vendored-bundle fallback (one-shot esbuild script in `tools/`) if the load budget fails. Deps: 6.2.

## 4. Dependency graph

```
Lane 0:  0.1[S]──0.3[S]   0.2[S]              (∥ Lane A)
Lane A:  1.1[O]──1.2[O]──1.3[S]               ══ M1 GATE · pause ══
Lane B:  2.1[O](∥1.2)──┬2.2[S]┬──2.6[O]       ══ M2 GATE · pause ══
                       ├2.3[S]┤
                       ├2.4[O]┤   (4 parallel worktrees)
                       └2.5[S]┘
Lane C:  3.1[S](∥ Lane B)──3.2[O]──┬──3.4[S]  ══ M3 GATE · pause ══
                           3.3[S]──┘
Lane D:  4.1[S]──┬──4.3[S]        (∥ Lane C)  ══ M4 GATE · pause ══
         4.2[S]──┘
Lane E:  5.1[O]──┬──5.3[S]                    ══ M5 GATE · pause ══
         5.2[S]──┘
Lane F:  6.1[S]──6.2[S]──6.3[O]               ══ M6 GATE · done ══
```

Model tally: 8 Opus (1.1, 1.2, 2.1, 2.4, 2.6, 3.2, 5.1, 6.3) · 17 Sonnet.

## 5. Integration cadence

1. Each WP works in an isolated git worktree on `wp/<id>-<slug>`; merged by the integrator only after its acceptance criteria pass locally.
2. **Hard gate after WP-1.2:** nothing importing `skrender.js` starts until the regression suite is green in CI on main. The editor page stays unlinked from docs until M6, so intermediate merges are inert on the live site.
3. Scaffold-first inside M2: WP-2.1 merges before 2.2–2.5 branch. Contract drift is reconciled only in integration WPs.
4. Every merge re-runs the M1 regression check — the preview tool can never silently regress.
5. Milestone gates pause for user review before the next lane starts.

## 6. Risk register (deltas beyond spec §10)

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Lazy mid-render include fetch makes a prefetched-includes contract impossible | Resolver-based contract (§1.1) from day one; pre-seeded maps are cache layers only |
| R-2 | Regression harness flakiness (live GitHub/CDN) would neuter the M1 gate | Hermetic interception + committed fixtures; determinism is an acceptance criterion; compare pre-JS `srcdoc`, not live DOM |
| R-3 | esm.sh can resolve duplicate `@codemirror/state` instances, silently breaking all CM6 extensions | `?deps=` pinning + runtime single-instance assertion (WP-2.1); pin-drift CI check |
| R-4 | Viewer catalog drifts from `_includes/embed/*` | `tools/check_viewer_catalog.py` greps `include.<attr>` in CI |
| R-5 | Parallel worktrees collide on shared files | File-ownership rule (§0.3); import map pre-declared in scaffold |
| R-6 | Shared `jekyllPreviewPAT` key: Forget-token affects the preview tool too | Dialog copy states the shared scope (WP-5.1) |
| R-7 | Cross-origin drags untestable in Playwright | Grammar layer exhaustively unit-tested; handler layer tested with synthetic `DataTransfer`; manual checklist per source site |
| R-8 | Moving preview logic into an external module changes its deployment shape | `assets/js/*.js` is copied unprocessed by Jekyll (precedent: `storykit.js`); regression runs against built `_site` |
