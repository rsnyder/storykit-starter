# External dependencies

Every third-party runtime dependency, its pinned version, where it is
referenced, and whether the reference carries an SRI `integrity` hash.
When bumping a version: update every listed reference, recompute SRI where
applicable (hashes below were computed from the npm tarball, which is
byte-identical to what jsDelivr/unpkg serve), and keep
`tools/check_consistency.py` green.

SRI applies only to `<script src>` / `<link>` tags. ES-module `import`
URLs cannot carry SRI — for those the exact version pin is the control.
Shoelace loads an internal lazy module graph, so it is pinned but not SRI'd.

## Site (host pages)

| Dependency | Version | Referenced in | SRI |
|---|---|---|---|
| Shoelace | 2.18.0 | `_layouts/post.html` (theme css + autoloader), `assets/js/storykit.js` (component imports), `assets/css/storykit.css` (@import theme), `assets/components/{image-compare,vis-network}.html` | no (module graph) |
| scrollama | 3.2.0 | `assets/js/storykit.js` (import, cdnjs) | no (import) |
| js-md5 | 0.8.3 | `assets/js/storykit.js`, `assets/components/image.html` (import) | no (import) |
| Bootstrap (preview page only) | 5.3.8 | `preview/index.html` | no |
| Font Awesome | 6.5.x | `_includes/sidebar.html` etc. (via Chirpy), `assets/components/map.html` (6.5.0), `preview/index.html` (6.5.2) | no |

## Components (iframe viewers)

| Dependency | Version | Referenced in | SRI |
|---|---|---|---|
| OpenSeadragon | 5.0.1 | `assets/components/image.html` (script + `prefixUrl` images) | yes |
| Leaflet | 1.9.4 | `assets/components/map.html` (js + css) | yes |
| Leaflet.SmoothWheelZoom | vendored | `assets/js/vendor/Leaflet.SmoothWheelZoom.js` (was hotlinked from a personal github.io origin) | n/a (local) |
| Leaflet marker images | vendored (from Leaflet v0.7.7) | `assets/img/leaflet/marker-icon{,-2x}.png`, `marker-shadow.png` | n/a (local) |
| leaflet-gesture-handling | 1.2.2 | `assets/components/map.html` (js + css) | yes |
| @allmaps/leaflet | 1.0.0-beta.44 | `assets/components/map.html` | yes |
| exif-js | 2.3.0 | `assets/components/map.html` | yes |
| marked | 18.0.5 | `assets/components/{image,map,youtube,vis-network}.html` (import) | no (import) |
| vis (vis-network) | 4.21.0 | `assets/components/vis-network.html` (cdnjs) | yes (pre-existing) |
| papaparse | 5.4.1 | `assets/components/vis-network.html` | yes |
| YouTube IFrame API | (unversioned by design) | `assets/components/youtube.html` | no — Google requires loading the live API |

> **@allmaps/leaflet is pinned to 1.0.0-beta.44 deliberately**: it is the
> newest release that still ships `dist/bundled/allmaps-leaflet-1.9.umd.js`.
> Releases beta.45+ dropped the bundled build, which had silently broken the
> previously unversioned URL. When upgrading, check the package layout first.

## Preview tool (`preview/index.html`)

| Dependency | Version |
|---|---|
| LiquidJS | 10.27.1 |
| markdown-it | 14.3.0 |
| markdown-it-footnote | 3.0.3 |
| markdown-it-sub / -sup | 1.0.0 / 1.0.0 |
| js-yaml | 4.3.0 |
| jekyll-theme-chirpy (via jsDelivr gh) | `CHIRPY_VERSION` — must match `Gemfile.lock`; enforced by `tools/check_consistency.py` |

## Editor (import map)

Pins for the buildless StoryKit editor (`editor/index.html`), loaded from
esm.sh via the page's import map. Every package is requested with `?external=*`
so cross-package dependencies become bare specifiers the map resolves to a
single URL — this guarantees exactly one instance of `@codemirror/state` and
`@lezer/common` at runtime (risk R-3). Enforced by `tools/check_editor_pins.py`
(exact pins, registration here, single-instance) and a runtime assertion in
`editor/app.js`. When bumping any version, update the pin in both places and
re-run the checker + `tools/run_browser_tests.py`. `@marijn/find-cluster-break`,
`style-mod`, `w3c-keyname` and `crelt` are transitive leaves of the CM6 graph
that must be mapped for the graph to be closed.

| Dependency | Version | Purpose |
|---|---|---|
| @codemirror/state | 6.7.1 | CM6 core editor state (shared graph root — single-instance) |
| @codemirror/view | 6.43.6 | CM6 DOM view / rendering |
| @codemirror/language | 6.12.4 | Language/highlighting/indent infrastructure |
| @codemirror/commands | 6.10.4 | Editing commands, history, default keymap |
| @codemirror/search | 6.7.1 | Search/replace panel |
| @codemirror/autocomplete | 6.20.3 | Completion + bracket closing |
| @codemirror/lint | 6.9.7 | Diagnostics/gutter for tag linting (FR-EDIT.4) |
| @codemirror/lang-markdown | 6.5.0 | GFM Markdown language (FR-EDIT.1) |
| @codemirror/lang-yaml | 6.1.3 | YAML front-matter sub-language (FR-EDIT.1/7) |
| @codemirror/lang-html | 6.4.11 | Embedded-HTML support pulled in by lang-markdown |
| @codemirror/lang-css | 6.3.1 | Embedded CSS in Markdown HTML blocks (transitive) |
| @codemirror/lang-javascript | 6.2.5 | Embedded JS in Markdown HTML blocks (transitive) |
| @lezer/common | 1.5.2 | Lezer tree core (shared graph root — single-instance) |
| @lezer/highlight | 1.2.3 | Highlight tag system |
| @lezer/lr | 1.4.10 | LR parser runtime |
| @lezer/markdown | 1.6.4 | Markdown parser (lang-markdown) |
| @lezer/html | 1.3.13 | HTML parser (lang-html) |
| @lezer/css | 1.3.4 | CSS parser (lang-css) |
| @lezer/javascript | 1.5.4 | JS parser (lang-javascript) |
| @lezer/yaml | 1.0.4 | YAML parser (lang-yaml) |
| style-mod | 4.1.3 | CM6 style injection (transitive leaf) |
| w3c-keyname | 2.2.8 | CM6 key-name normalisation (transitive leaf) |
| crelt | 1.0.7 | CM6 tiny DOM helper (transitive leaf) |
| @marijn/find-cluster-break | 1.0.3 | Grapheme cluster breaks used by @codemirror/state (transitive leaf) |
| idb | 8.0.3 | IndexedDB promise wrapper for editor/store.js (FR-DOC.1) |
| js-yaml | 4.1.0 | YAML parsing for editor/context.js (`_config.yml`, `_data/locales/*`, `_data/origin/default.yml`) — WP-3.2 |
| diff | 9.0.0 | jsdiff `diffLines` for editor/conflict.js's side-by-side conflict diff (FR-GH.4) — WP-5.2; zero runtime dependencies of its own |
| nspell | 2.1.5 | Hunspell-compatible spell engine for editor/spellcheck.js (region-aware spell check) — bundled (no ?external: CJS with its own small dep graph); dictionary-en@4.0.0 aff/dic fetched at runtime and kept in the Cache API |

## Test-only (vendored, never shipped to the site)

| Dependency | Version | Referenced in | Notes |
|---|---|---|---|
| axe-core | 4.10.2 | `tests/e2e/vendor/axe.min.js` (injected by `tests/e2e/test_a11y.py`) | Committed copy — the a11y audit never fetches from a CDN at test time (hermeticity). Bump by replacing the vendored file and updating this row. |

## Live web services (runtime data, not code)

| Service | Used by | Resilience |
|---|---|---|
| query.wikidata.org (SPARQL) | entity popups, map QID lookups | per-QID sessionStorage cache (24 h TTL), request timeout, non-fatal failures |
| *.wikipedia.org REST (summaries) | entity popups | timeout, non-fatal |
| upload.wikimedia.org / Commons API | image viewer (`wc:` shorthand) | n/a (media host) |
| annotations.allmaps.org | map warped layers | non-fatal |
| youtube.com oembed + IFrame API | youtube viewer | caption falls back to blank |
