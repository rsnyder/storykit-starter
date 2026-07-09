/**
 * editor/app.js — StoryKit Editor application shell
 *
 * Owns the shared app surface per docs/editor-plan.md §1.2:
 *   - `bus`      : the app-wide EventTarget (event names frozen below)
 *   - `appState` : { currentDocId, mode, binding, prefs }
 *   - preference persistence in localStorage ('storykit-editor-prefs')
 *   - theme + mode toggles, sidebar collapse
 *   - the single-instance CM6 assertion (risk R-3)
 *
 * WP-2.6 (M2 integration) turns the scaffold into a working product:
 *   - the editing surface is now editor.js's `createEditor()` (the WP-2.1
 *     inline "bare editor" path is deleted), with the StoryKit language
 *     extension (`storykit({ catalog })`) and autocomplete wired in through
 *     `extraExtensions`;
 *   - the document lifecycle (store → doclist → autosave → last-open restore)
 *     runs end to end, so an author's drafts survive browser restarts;
 *   - the status bar is driven by the `editor:wordcount` / `editor:cursor`
 *     bus events createEditor emits (createEditor never touches the DOM);
 *   - durable storage is requested on boot (FR-DOC.8), with a non-blocking
 *     notice when the browser declines.
 *
 * WP-4.3 (M4 integration) wires drag/drop tag insertion and Wikidata entity
 * linking in:
 *   - `dnd.dndExtension({ onNotice })` is spliced into `buildExtraExtensions()`
 *     — `onNotice` routes dnd.js's degrade/fallback notices onto the shared
 *     `toast` bus event (its `{ message, level: 'warning' }` payload shape
 *     already matches doclist.js/app.js's existing toast consumers, so no
 *     translation is needed);
 *   - `wikidata.createEntityResolver()` is created ONCE at module-evaluation
 *     time (below, well before `init()` runs) and its `resolver` is registered
 *     into lang-storykit's synchronous QID-decoration hook via
 *     `storykit.setEntityResolver(resolver)` — this must happen before any
 *     editor mounts, which module-level placement guarantees; `prime(view)`
 *     is then called once per (re)created CM6 view from `mountEditor()`
 *     itself (covering both the `openDoc` and `rethemeEditor` paths for
 *     free), per the "one call per view is enough" contract in wikidata.js's
 *     header;
 *   - `wikidata.qidHoverExtension()` is spliced into `buildExtraExtensions()`
 *     for the `[text](Qnnnn)` hover cards (FR-WD.3);
 *   - `linkEntityCommand` is bound to Mod-Shift-k (⌘⇧K) via a `keymap.of([...])`
 *     entry in `buildExtraExtensions()` (FR-WD.1) — no conflict with
 *     commands.js's insertLink binding (WP-6.1 moved that to Mod-Shift-l).
 *     WP-4.3 also added a small "Link entity" icon button to the top bar;
 *     WP-6.1 removed it once the toolbar's own "Link entity" button
 *     superseded it (avoid duplicate affordances).
 *
 * WP-3.4 (M3 integration) wires the preview pane in:
 *   - `preview.createPreviewPane({ mount: #preview-mount })` is created once
 *     at boot (test seams omitted — this is the real app);
 *   - entering Preview, or entering Split, calls `pane.render(...)`
 *     immediately (spec FR-PRE.1/3); `doc:changed` while already in Split
 *     calls the ~1s-debounced `pane.schedule(...)` instead;
 *   - `binding` is `appState.binding` (always `null` until WP-5.1 lands
 *     GitHub sync); `path` is the open document's `path`, falling back to a
 *     synthetic `_posts/<yyyy-mm-dd-slug>.md` (reusing doclist.js's
 *     `buildFilename`) when the document has none yet (e.g. an imported or
 *     not-yet-named draft) — preview.js/context.js need SOME path to resolve
 *     relative links and to pick a layout, and unbound docs still preview
 *     against the starter's own defaults (FR-PRE.4) regardless of the exact
 *     filename;
 *   - `preview:goto-line` (dispatched by preview.js's diagnostics panel) is
 *     heard here and moves the CM6 selection to that line, scrolls it into
 *     view, and focuses the editor.
 *   - context.diagnostics ARE already merged into renderPost()'s diagnostics
 *     by preview.js itself (see that file's `render()`) — no reconciliation
 *     was needed here; both WP-3.2 and WP-3.3 already implemented the
 *     contract delta documented in context.js's header.
 *
 * This file is edited only by WP-2.1 and the integration WPs (2.6, 3.4, 4.3).
 * Feature WPs code against `bus` / `appState` and their own module files.
 *
 * Buildless: every import below resolves through the pinned import map in
 * editor/index.html (esm.sh, `?external=*` dedupe — see index.html header and
 * tools/check_editor_pins.py).
 */

// ── CodeMirror 6 (single-instance assertion + extraExtensions helpers) ──────
import { EditorState, StateField, Prec, Compartment } from '@codemirror/state';
import { keymap, lineNumbers, highlightActiveLine, EditorView } from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, historyField,
} from '@codemirror/commands';
import {
  syntaxHighlighting, defaultHighlightStyle, bracketMatching,
} from '@codemirror/language';
import {
  closeBrackets, autocompletion, completionKeymap,
} from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { lintKeymap, lintGutter } from '@codemirror/lint';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';

// ── Editor module surface ───────────────────────────────────────────────────
// Namespace imports keep the frozen contracts loading cleanly (and give
// integration a single object to reach the module namespaces through); the
// modules WP-2.6 wires for real are also reached by name off these namespaces.
import * as store from './store.js';
import * as editor from './editor.js';
import * as commands from './commands.js';
import * as langStorykit from './lang-storykit.js';
import * as doclist from './doclist.js';
import * as preview from './preview.js';
import * as scrollsync from './scrollsync.js';
import * as statusbar from './statusbar.js';
import * as github from './github.js';
import * as context from './context.js';
import * as wikidata from './wikidata.js';
import * as dnd from './dnd.js';
import * as sync from './sync.js';
import * as conflict from './conflict.js';
import { catalog } from './viewer-catalog.js';
import * as palette from './palette.js';
import * as toolbar from './toolbar.js';

// Keep tree-shakers / linters from flagging the skeleton imports as unused, and
// give integration WPs a single object to reach the module namespaces through.
export const modules = {
  store, editor, commands, langStorykit, doclist, preview, statusbar,
  github, context, wikidata, dnd, sync, conflict, palette, toolbar,
};

// ─────────────────────────────────────────────────────────────────────────────
// Event bus. Frozen event names (docs/editor-plan.md §1.2):
//   doc:changed · doc:saved · mode:changed · sync:status · lint:count · toast
// Editor-local (non-frozen, emitted by editor.js): editor:wordcount ·
//   editor:cursor.
// ─────────────────────────────────────────────────────────────────────────────
export const bus = new EventTarget();

/** Convenience emitter. @param {string} type @param {*} [detail] */
export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Preferences (localStorage) — small values only, per spec FR-DOC.1 / §6.4.
// ─────────────────────────────────────────────────────────────────────────────
const PREFS_KEY = 'storykit-editor-prefs';

/** @typedef {'system'|'light'|'dark'} ThemePref */
/** @typedef {'edit'|'split'|'preview'} EditorMode */

const DEFAULT_PREFS = Object.freeze({
  theme: /** @type {ThemePref} */ ('system'),
  mode: /** @type {EditorMode} */ ('edit'),
  sidebarCollapsed: false,
  lastDocId: /** @type {string|null} */ (null),
});

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(appState.prefs));
  } catch {
    /* storage may be unavailable (private mode); non-fatal */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Application state (docs/editor-plan.md §1.2).
// ─────────────────────────────────────────────────────────────────────────────
export const appState = {
  /** @type {string|null} */ currentDocId: null,
  /** @type {EditorMode}   */ mode: 'edit',
  /** @type {{ owner: string, repo: string, branch: string, path: string }|null} */ binding: null,
  /** @type {typeof DEFAULT_PREFS} */ prefs: loadPrefs(),
};
appState.mode = appState.prefs.mode;

// ─────────────────────────────────────────────────────────────────────────────
// Theme.
// ─────────────────────────────────────────────────────────────────────────────
/** @param {ThemePref} theme */
export function applyTheme(theme) {
  appState.prefs.theme = theme;
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  savePrefs();
  syncThemeControl();
  rethemeEditor();
}

/**
 * Rebuild the editor so CM syntax colors follow the active theme. createEditor
 * reads the theme at construction time (editor.js resolvedTheme()), so a theme
 * change means destroy + recreate, preserving the current buffer content. The
 * active document's autosaver is unaffected — it listens on the shared bus'
 * `doc:changed`, which any editor instance emits.
 */
function rethemeEditor() {
  if (!editorHandle) return;
  const content = editorHandle.getContent();
  mountEditor(content);
}

/** Cycle system → light → dark → system. */
export function cycleTheme() {
  const order = /** @type {ThemePref[]} */ (['system', 'light', 'dark']);
  const next = order[(order.indexOf(appState.prefs.theme) + 1) % order.length];
  applyTheme(next);
}

function syncThemeControl() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const label = appState.prefs.theme;
  btn.setAttribute('data-theme-pref', label);
  btn.setAttribute('aria-label', `Theme: ${label} (click to change)`);
  btn.title = `Theme: ${label} — click to change`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode (Edit / Split / Preview).
// ─────────────────────────────────────────────────────────────────────────────
/** @param {EditorMode} mode */
export function setMode(mode) {
  if (!['edit', 'split', 'preview'].includes(mode)) return;
  appState.mode = mode;
  appState.prefs.mode = mode;
  document.body.dataset.mode = mode;
  for (const btn of document.querySelectorAll('[data-mode-btn]')) {
    const on = btn.getAttribute('data-mode-btn') === mode;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-active', on);
  }
  savePrefs();
  emit('mode:changed', { mode });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar collapse (desktop) / overlay drawer (≤820px — WP-6.2 §5.5 "toolbar
// [and sidebar] collapses"). Two independent DOM states share one toggle
// button and one keyboard affordance:
//   - wide viewports: `body.sidebar-collapsed` — persisted in prefs, pushes
//     the editor pane wider (styles.css's unconditional `.sidebar` flex rule).
//   - narrow viewports (≤820px, matches styles.css's own breakpoint):
//     `body.sidebar-open` — an ephemeral (NOT persisted — it's a transient
//     drawer, not a durable layout choice) overlay with a click-to-dismiss
//     scrim (`#sidebar-scrim`, created lazily) and Esc-to-close.
// ─────────────────────────────────────────────────────────────────────────────
const NARROW_QUERY = '(max-width: 820px)';

function isNarrowViewport() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(NARROW_QUERY).matches;
}

function ensureSidebarScrim() {
  let scrim = document.getElementById('sidebar-scrim');
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.id = 'sidebar-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    scrim.addEventListener('click', closeSidebarOverlay);
    document.body.appendChild(scrim);
  }
  return scrim;
}

function closeSidebarOverlay() {
  document.body.classList.remove('sidebar-open');
  const btn = document.getElementById('sidebar-toggle');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

export function setSidebarCollapsed(collapsed) {
  appState.prefs.sidebarCollapsed = !!collapsed;
  document.body.classList.toggle('sidebar-collapsed', !!collapsed);
  const btn = document.getElementById('sidebar-toggle');
  if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
  savePrefs();
}

export function toggleSidebar() {
  if (isNarrowViewport()) {
    ensureSidebarScrim();
    const opening = !document.body.classList.contains('sidebar-open');
    document.body.classList.toggle('sidebar-open', opening);
    const btn = document.getElementById('sidebar-toggle');
    if (btn) btn.setAttribute('aria-expanded', String(opening));
    return;
  }
  setSidebarCollapsed(!appState.prefs.sidebarCollapsed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk R-3: single-instance assertion.
//
// esm.sh can silently resolve duplicate copies of @codemirror/state, which
// breaks every CM6 extension (foreign StateField/Facet objects fail the
// "Unrecognized extension value" guard inside EditorState.create). We assert
// single-instance two ways:
//   (1) IDENTITY  — historyField (a StateField built by @codemirror/commands)
//                   must be `instanceof StateField` (our @codemirror/state).
//   (2) FUNCTIONAL — EditorState.create() with extensions drawn from state,
//                   view, commands, language, autocomplete, search, lint and
//                   lang-markdown must not throw; a second state exercises
//                   lang-yaml. Any duplicated @codemirror/state anywhere in
//                   that graph makes create() throw.
// Returns { ok, error } rather than throwing so the bootstrap can render a
// visible fatal banner.
// ─────────────────────────────────────────────────────────────────────────────
export function assertSingleInstance() {
  try {
    if (typeof EditorState.create !== 'function') {
      throw new Error('EditorState.create is not a function — @codemirror/state failed to load');
    }
    // (1) cross-package StateField identity
    if (!(historyField instanceof StateField)) {
      throw new Error(
        'historyField is not an instance of StateField — @codemirror/commands and ' +
        '@codemirror/state resolved to different @codemirror/state instances (import-map dedupe failed)'
      );
    }
    // (2) functional composition across the whole extension graph
    const probe = EditorState.create({
      doc: '# probe\n',
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightSelectionMatches(),
        lintGutter(),
        syntaxHighlighting(defaultHighlightStyle),
        markdown({ base: markdownLanguage }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, ...lintKeymap]),
      ],
    });
    if (!probe || typeof probe.doc?.toString !== 'function') {
      throw new Error('EditorState.create returned an unusable state');
    }
    // lang-yaml lives on a separate top-level language facet; exercise it too.
    EditorState.create({ doc: 'a: 1\n', extensions: [yaml()] });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing surface (editor.js's createEditor) + StoryKit language wiring.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {ReturnType<typeof editor.createEditor>|null} */
let editorHandle = null;
/** @type {ReturnType<typeof store.createAutosaver>|null} */
let currentAutosaver = null;

// ─────────────────────────────────────────────────────────────────────────────
// Wikidata entity resolver (WP-4.3). Created once at module-evaluation time —
// well before init()/mountEditor() ever run — and registered into
// lang-storykit's synchronous QID-decoration hook. `primeEntityResolver(view)`
// is called from mountEditor() below for every (re)created CM6 view; queued
// qids from later decoration passes auto-flush via microtask against that
// same remembered view (see wikidata.js's createEntityResolver header note).
// ─────────────────────────────────────────────────────────────────────────────
const { resolver: entityResolver, prime: primeEntityResolver } = wikidata.createEntityResolver();
langStorykit.storykit.setEntityResolver(entityResolver);

/**
 * The extensions createEditor splices in LAST — StoryKit highlight/complete/
 * lint plus the autocomplete plugin lang-storykit's completion source needs,
 * plus the WP-4.1/4.2 drag-drop and Wikidata extensions.
 *
 * lang-storykit registers its completion source via EditorState.languageData
 * (so it composes with lang-markdown's own completions), which requires the
 * HOST to provide the @codemirror/autocomplete plugin (WP-2.4 handoff). Base
 * editor.js does NOT include autocompletion() — per the WP-2.6 brief we add it
 * here (the extraExtensions route) rather than editing editor.js. completionKeymap
 * makes the popup navigable/acceptable.
 *
 * `dnd.dndExtension({ onNotice })` deliberately omits its own drop cursor —
 * editor.js's base extension set already includes CM6's dropCursor()
 * unconditionally (see dnd.js's module header).
 *
 * The Mod-Shift-k binding is wrapped in `Prec.highest` — @codemirror/commands'
 * `defaultKeymap` (spliced into editor.js's BASE keymap, ahead of
 * extraExtensions in the extension list) already binds bare `Shift-Mod-k` to
 * `deleteLine`. Without an explicit higher precedence that base binding wins
 * the CM6 keymap facet's provider-order tie-break and `linkEntityCommand`
 * never fires (verified empirically: the unprefixed binding silently deleted
 * the current line instead of opening the popup).
 *
 * getIncludeList / getDocViewerIds are intentionally left undefined — repo
 * binding that would populate them arrives in M3 (context.js).
 *
 * WP-6.1 additionally splices in `toolbar.viewerSnippetExtension()` — the
 * small StateField + Prec.high Tab-jump keymap that lets a freshly-inserted
 * Insert-viewer snippet's SUBSEQUENT required-attribute placeholders (only
 * embed/image-compare.html has more than one) be reached with Tab, one
 * placeholder at a time, instead of indenting — see toolbar.js's header for
 * the full design note.
 */
// Native browser spell check (user-requested, "option 1"): the OS dictionary
// squiggles typos and offers right-click suggestions. Not region-aware (it
// will flag tag attributes and front-matter values) — the palette toggle is
// the escape hatch. A Compartment so toggling reconfigures the live view.
const spellcheckCompartment = new Compartment();

/** Chrome (and friends) only spell-check text the user has TYPED — a buffer
 *  set programmatically (opening/switching documents) shows no squiggles
 *  until each line is edited. Toggling the attribute on the focused element
 *  is the standard workaround: it forces a re-evaluation of the visible
 *  buffer. Called after openDoc's focus and when the toggle turns on. */
function kickSpellcheck() {
  if (appState.prefs.spellcheck === false || !editorHandle) return;
  const dom = editorHandle.view.contentDOM;
  requestAnimationFrame(() => {
    dom.setAttribute('spellcheck', 'false');
    requestAnimationFrame(() => dom.setAttribute('spellcheck', 'true'));
  });
}

function spellcheckAttrs() {
  const on = appState.prefs.spellcheck !== false;
  return EditorView.contentAttributes.of({
    spellcheck: on ? 'true' : 'false',
    autocorrect: 'off',
    autocapitalize: 'off',
  });
}

function buildExtraExtensions() {
  return [
    spellcheckCompartment.of(spellcheckAttrs()),
    autocompletion(),
    keymap.of(completionKeymap),
    langStorykit.storykit({
      catalog,
      onLintCount: (count) => bus.dispatchEvent(new CustomEvent('lint:count', { detail: { count } })),
    }),
    dnd.dndExtension({ onNotice: (n) => emit('toast', n) }),
    wikidata.qidHoverExtension(),
    Prec.highest(keymap.of([{ key: 'Mod-Shift-k', run: wikidata.linkEntityCommand, preventDefault: true }])),
    toolbar.viewerSnippetExtension(),
  ];
}

function getEditorMount() {
  return document.getElementById('editor-mount');
}

/**
 * (Re)mount the editor into #editor-mount with `content`. Destroys any current
 * instance first (safe for the theme destroy+recreate and for switching docs).
 * @param {string} content
 */
function mountEditor(content) {
  const mount = getEditorMount();
  if (!mount) return null;
  if (editorHandle) {
    editorHandle.destroy();
    editorHandle = null;
  }
  mount.classList.remove('is-empty');
  mount.replaceChildren();
  editorHandle = editor.createEditor({
    parent: mount,
    initialContent: content ?? '',
    extraExtensions: buildExtraExtensions(),
  });
  // WP-4.3: one prime() call per (re)created view is enough — later queued
  // qids auto-flush against this same view via microtask (wikidata.js).
  if (editorHandle) primeEntityResolver(editorHandle.view);
  // Split-view scroll sync: follow the editor's scroll (guarded inside).
  if (editorHandle) {
    editorHandle.view.scrollDOM.addEventListener('scroll', onEditorScrollForSync, { passive: true });
  }
  return editorHandle;
}

/** Ensure the sidebar (home of the "+ New" inline form) is visible, then open
 * it — used by every "create a document" entry point that ISN'T already
 * inside the sidebar itself (the editor's empty-state CTA, the command
 * palette's "New post" entry — see buildCommandRegistry() below). */
function openNewDocFlow() {
  if (isNarrowViewport()) {
    ensureSidebarScrim();
    document.body.classList.add('sidebar-open');
    document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', 'true');
  } else if (appState.prefs.sidebarCollapsed) {
    setSidebarCollapsed(false);
  }
  docListHandle?.openNewPostForm();
}

/** Tear the editor down and show the "no document open" placeholder. */
function showEditorEmptyState() {
  if (editorHandle) {
    editorHandle.destroy();
    editorHandle = null;
  }
  currentDocRecord = null;
  const mount = getEditorMount();
  if (mount) {
    mount.classList.add('is-empty');
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';

    const icon = document.createElement('span');
    icon.className = 'empty-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" '
      + 'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M7 3h7l4 4v14a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/>'
      + '<path d="M14 3v4h4"/><path d="M9 12h6M9 16h4"/></svg>';

    const title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = 'No document open';
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = 'Create a new post, or open a draft from the sidebar. '
      + 'Everything is stored locally in your browser.';
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'btn btn-primary';
    cta.textContent = '+ New document';
    cta.addEventListener('click', openNewDocFlow);

    // Most new users' FIRST task is opening an existing post, not writing a
    // fresh one — surface that path on the landing screen (review item #5).
    const openCta = document.createElement('button');
    openCta.type = 'button';
    openCta.className = 'btn';
    openCta.id = 'empty-open-remote';
    openCta.textContent = 'Open from GitHub…';
    openCta.addEventListener('click', () => {
      const ref = window.prompt(
        'Open from GitHub — paste a file URL (github.com/…/blob/…) or a repo path like _posts/2026-01-01-post.md:');
      if (ref && ref.trim()) openRemoteRef(ref.trim());
    });
    const ctaRow = document.createElement('div');
    ctaRow.className = 'empty-cta-row';
    ctaRow.append(cta, openCta);

    const helpLine = document.createElement('p');
    helpLine.className = 'empty-hint';
    helpLine.innerHTML = 'New here? The <a href="./help.html" target="_blank" rel="noopener">help page</a> '
      + 'covers GitHub setup, the bookmarklet, and drag-and-drop media.';

    wrap.append(icon, title, hint, ctaRow, helpLine);
    mount.replaceChildren(wrap);
  }
  appState.binding = null;
  updateDocChrome(null);
  reflectSyncStatus(null);
  // If Preview/Split is already showing, reflect the now-empty editor there
  // too instead of leaving a stale render or the loading overlay hanging.
  refreshPreviewForCurrentMode();
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview pane (WP-3.4). Created once at boot; fed the live buffer + the open
// document's path/binding on mode entry and (debounced) on every doc:changed
// while already in Split mode.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {ReturnType<typeof preview.createPreviewPane>|null} */
let previewHandle = null;

/**
 * The path fed to preview.render()/schedule(): the open document's `path`
 * when it has one, else a synthetic `_posts/<yyyy-mm-dd-slug>.md` derived
 * from its title (doclist.js's own New Post naming rule, reused here so an
 * unbound/imported draft with no path yet still gets a plausible one — the
 * unbound context (FR-PRE.4) doesn't need this path to exist anywhere, only
 * to look like a post so the layout/URL-rewrite logic behaves normally).
 * @param {object|null} record
 * @returns {string}
 */
function previewPathFor(record) {
  if (record && record.path) return record.path;
  const title = (record && record.title) || 'untitled';
  const seed = (record && (record.updatedAt || record.createdAt)) || new Date();
  const date = new Date(seed);
  return `_posts/${doclist.buildFilename(Number.isNaN(date.getTime()) ? new Date() : date, title)}`;
}

/** @param {string} content @returns {{content:string, path:string, binding:object|null}} */
function previewArgsFor(content) {
  return { content, path: previewPathFor(currentDocRecord), binding: appState.binding };
}

/** Render immediately (Preview entry, Split entry, opening a doc while in either). */
function renderPreviewNow(content) {
  if (!previewHandle || !currentDocRecord) return;
  previewHandle.render(previewArgsFor(content));
}

/** ~1s-debounced re-render for Split-mode live edits (FR-PRE.3). */
function schedulePreviewUpdate(content) {
  if (!previewHandle || !currentDocRecord) return;
  previewHandle.schedule(previewArgsFor(content));
}

/** Re-render (immediately) if the current mode shows the preview pane at all. */
function refreshPreviewForCurrentMode() {
  if (appState.mode !== 'preview' && appState.mode !== 'split') return;
  if (!editorHandle || !currentDocRecord) {
    // Nothing to render yet — a friendly "no document" message beats a
    // blank/loading-forever iframe (WP-6.2 §5.4 empty-states-with-guidance;
    // preview.js's `showEmpty` is a no-op once a real render has landed).
    previewHandle?.showEmpty?.('No document open — create or open one from the sidebar to see a live preview.');
    return;
  }
  renderPreviewNow(editorHandle.getContent());
}

// ── Split-view scroll sync (editor/scrollsync.js; default on, palette
//    toggle). Anchor-interpolated: exact at headings/viewers, proportional
//    between them; silently inactive when mapping isn't possible. ──────────
const scrollSyncState = {
  map: null, lock: null, lockTimer: 0, detach: null,
  raf: { editor: 0, preview: 0 }, pending: { editor: null, preview: null },
};

function scrollSyncEnabled() {
  return appState.prefs.scrollSync !== false && appState.mode === 'split';
}

function scrollSyncLock(side) {
  scrollSyncState.lock = side;
  clearTimeout(scrollSyncState.lockTimer);
  // Must outlive the driven pane's own scroll event (fires a frame after the
  // programmatic scrollTo) or the panes correct each other in tiny steps.
  scrollSyncState.lockTimer = setTimeout(() => { scrollSyncState.lock = null; }, 220);
}

/** One coalesced update per animation frame per side, with a small deadband —
 *  re-applying near-identical positions on every scroll event is what reads
 *  as jitter. */
function scrollSyncSchedule(side, computeAndApply) {
  scrollSyncState.pending[side] = computeAndApply;
  if (scrollSyncState.raf[side]) return;
  scrollSyncState.raf[side] = requestAnimationFrame(() => {
    scrollSyncState.raf[side] = 0;
    const fn = scrollSyncState.pending[side];
    scrollSyncState.pending[side] = null;
    if (fn) fn();
  });
}

/** Rebuild the anchor map + (re)attach the preview-side scroll listener —
 *  the srcdoc document is replaced on every render. */
function rebuildScrollSync() {
  scrollSyncState.map = null;
  if (scrollSyncState.detach) { scrollSyncState.detach(); scrollSyncState.detach = null; }
  if (!previewHandle || !editorHandle) return;
  const iframe = previewHandle.getFrame && previewHandle.getFrame();
  const iwin = iframe && iframe.contentWindow;
  const idoc = iframe && iframe.contentDocument;
  if (!iwin || !idoc || !idoc.body) return;

  // Match by TEXT within the post-content area: the preview's markdown-it
  // pipeline does NOT assign heading ids (kramdown auto_ids is Jekyll-side),
  // and chrome headings (dialogs, sidebar) must not become anchors.
  const content = idoc.querySelector('.post-content') || idoc.body;
  const srcAnchors = scrollsync.extractSourceAnchors(editorHandle.getContent());
  const pvAnchors = [];
  for (const el of content.querySelectorAll('h1,h2,h3,h4,h5,h6,iframe[id]')) {
    const top = el.getBoundingClientRect().top + iwin.scrollY;
    if (el.tagName === 'IFRAME') { pvAnchors.push({ key: `v:${el.id}`, top }); continue; }
    const norm = scrollsync.normalizeHeadingText(el.textContent);
    if (!norm) continue;
    const n = (rebuildScrollSync._seen.get(norm) || 0) + 1;
    rebuildScrollSync._seen.set(norm, n);
    pvAnchors.push({ key: `h:${n}:${norm}`, top });
  }
  rebuildScrollSync._seen.clear();

  const totalLines = editorHandle.view.state.doc.lines;
  const totalHeight = Math.max(0, idoc.documentElement.scrollHeight - iwin.innerHeight);
  scrollSyncState.map = scrollsync.buildScrollMap(srcAnchors, pvAnchors, totalLines, totalHeight);

  const onPreviewScroll = () => {
    if (!scrollSyncEnabled() || !scrollSyncState.map || scrollSyncState.lock === 'editor') return;
    scrollSyncLock('preview');
    scrollSyncSchedule('preview', () => {
      const view = editorHandle && editorHandle.view;
      if (!view || scrollSyncState.lock === 'editor') return;
      const lf = scrollsync.previewToSource(scrollSyncState.map, iwin.scrollY);
      // FRACTIONAL target: line floor's block top + fraction into the block —
      // rounding to whole lines made the editor move in visible steps.
      const lines = view.state.doc.lines;
      const ln = Math.max(1, Math.min(Math.floor(lf), lines));
      const frac = Math.max(0, Math.min(lf - ln, 1));
      const block = view.lineBlockAt(view.state.doc.line(ln).from);
      const target = Math.max(0, block.top + frac * block.height);
      if (Math.abs(view.scrollDOM.scrollTop - target) > 2) {
        view.scrollDOM.scrollTo({ top: target });
      }
    });
  };
  iwin.addEventListener('scroll', onPreviewScroll, { passive: true });
  scrollSyncState.detach = () => { try { iwin.removeEventListener('scroll', onPreviewScroll); } catch { /* gone */ } };
}
rebuildScrollSync._seen = new Map();

function onEditorScrollForSync() {
  if (!scrollSyncEnabled() || !scrollSyncState.map || scrollSyncState.lock === 'preview') return;
  scrollSyncLock('editor');
  scrollSyncSchedule('editor', () => {
    const view = editorHandle && editorHandle.view;
    const iframe = previewHandle && previewHandle.getFrame && previewHandle.getFrame();
    const iwin = iframe && iframe.contentWindow;
    if (!view || !iwin || scrollSyncState.lock === 'preview') return;
    const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    const line = view.state.doc.lineAt(block.from).number
      + (block.height > 0 ? (view.scrollDOM.scrollTop - block.top) / block.height : 0);
    const target = scrollsync.sourceToPreview(scrollSyncState.map, line);
    if (Math.abs(iwin.scrollY - target) > 2) iwin.scrollTo({ top: target });
  });
}

function wirePreview() {
  const mount = document.getElementById('preview-mount');
  if (!mount) return;
  previewHandle = preview.createPreviewPane({ mount, onRendered: rebuildScrollSync });

  // Entering Preview, or entering Split, renders immediately (FR-PRE.1/3).
  bus.addEventListener('mode:changed', (e) => {
    const mode = e.detail && e.detail.mode;
    if (mode === 'preview' || mode === 'split') refreshPreviewForCurrentMode();
  });

  // While already in Split, every debounced doc:changed schedules a re-render.
  bus.addEventListener('doc:changed', (e) => {
    if (appState.mode === 'split' && e.detail && typeof e.detail.content === 'string') {
      schedulePreviewUpdate(e.detail.content);
    }
  });

  // Deleting the OPEN document must clear the editor and preview panes —
  // otherwise both keep showing a ghost of the removed record.
  bus.addEventListener('doc:deleted', (e) => {
    const id = e.detail && e.detail.docId;
    if (id && id === appState.currentDocId) closeCurrentDoc();
  });

  // Diagnostics-panel "Line N" buttons (preview.js) move the CM6 selection.
  bus.addEventListener('preview:goto-line', (e) => {
    const line = e.detail && e.detail.line;
    if (!editorHandle || !Number.isFinite(line)) return;
    const view = editorHandle.view;
    const total = view.state.doc.lines;
    const ln = Math.max(1, Math.min(Math.trunc(line), total));
    const pos = view.state.doc.line(ln).from;
    view.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
    view.focus();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Document lifecycle: store → doclist → autosave → last-open restore.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {ReturnType<typeof doclist.createDocList>|null} */
let docListHandle = null;
/** @type {object|null} the full record for appState.currentDocId (path/title for preview) */
let currentDocRecord = null;

/**
 * Clear the editing surface after the OPEN document is deleted: dispose the
 * autosaver WITHOUT flushing (a flush would try to write the removed record
 * back), drop current-doc state/prefs, destroy + recreate the preview pane
 * (its iframe still shows the deleted document's last render), and return
 * to Edit mode's empty state.
 */
function closeCurrentDoc() {
  if (currentAutosaver) {
    currentAutosaver.dispose();
    currentAutosaver = null;
  }
  appState.currentDocId = null;
  if (appState.prefs.lastDocId) {
    appState.prefs.lastDocId = null;
    savePrefs();
  }
  if (previewHandle) {
    previewHandle.destroy();
    const mount = document.getElementById('preview-mount');
    if (mount) {
      mount.replaceChildren();
      previewHandle = preview.createPreviewPane({ mount, onRendered: rebuildScrollSync });
    } else {
      previewHandle = null;
    }
  }
  setMode('edit');
  showEditorEmptyState();
  bus.dispatchEvent(new CustomEvent('doc:opened', { detail: { docId: null } }));
}

/**
 * Switch the editing surface to `docId`: flush + dispose the outgoing
 * autosaver, load the record, recreate the editor on its content, mark it
 * current + remember it in prefs, then attach a fresh autosaver.
 * @param {string} docId
 */
export async function openDoc(docId) {
  if (currentAutosaver) {
    try { await currentAutosaver.flush(); } catch { /* best-effort */ }
    currentAutosaver.dispose();
    currentAutosaver = null;
  }

  let record = null;
  try {
    record = await store.docs.get(docId);
  } catch (err) {
    emit('toast', { message: `Couldn't open document: ${err?.message || err}`, level: 'error' });
    return;
  }
  if (!record) {
    // Stale lastDocId (e.g. deleted elsewhere) — fall back to the empty state.
    if (appState.prefs.lastDocId === docId) {
      appState.prefs.lastDocId = null;
      savePrefs();
    }
    showEditorEmptyState();
    return;
  }

  appState.currentDocId = docId;
  appState.prefs.lastDocId = docId;
  savePrefs();
  currentDocRecord = record;
  // Announce the active document — the docs pane highlights its row.
  bus.dispatchEvent(new CustomEvent('doc:opened', { detail: { docId } }));
  // Binding drives preview context resolution (FR-PRE.4) and the status bar.
  appState.binding = record.github
    ? { owner: record.github.owner, repo: record.github.repo, branch: record.github.branch, path: record.path }
    : null;

  mountEditor(record.content || '');
  updateDocChrome(record);
  reflectSyncStatus(record);

  // Opening a document from the mobile drawer is the natural "done, thanks"
  // signal — close the overlay so the editor is immediately usable (spec
  // §5.5 "light editing must work" on narrow viewports).
  if (isNarrowViewport()) closeSidebarOverlay();

  currentAutosaver = store.createAutosaver(docId, {
    // onSave emits the frozen `doc:saved` event (docs/editor-plan.md §1.2) —
    // the document list listens for it to refresh badges + sync-button state
    // after every autosave (nothing emitted it before, so "Synced" lingered
    // after local edits until an unrelated re-render).
    onSave: () => { bus.dispatchEvent(new CustomEvent('doc:saved', { detail: { docId } })); },
  });
  editorHandle?.focus();
  kickSpellcheck();

  // Switching documents while Preview/Split is already showing must reflect
  // the newly-opened buffer right away, not wait for the next edit/mode flip.
  refreshPreviewForCurrentMode();

  // Passive remote-changed probe (FR-GH.5) — never auto-replaces; just flips the
  // badge/banner if the branch moved ahead. Fire-and-forget, best-effort.
  if (record.github) {
    sync.checkRemote(docId).catch((err) => {
      console.warn('[storykit-editor] checkRemote failed', err);
    });
  }
}

/**
 * Push sync-driven replacement content into the LIVE editor for the open doc
 * (the sync.js editor bridge). Coherence contract (mirrors openDoc's autosaver
 * discipline): the outgoing autosaver is DISPOSED WITHOUT flushing — its
 * pending content is the pre-replacement local, which sync.js has already
 * snapshotted to revisions; flushing it would clobber the freshly-written
 * remote/kept content in the store. sync.js writes the store BEFORE calling
 * this, so we only re-point the view + attach a fresh autosaver. No-op unless
 * `docId` is the currently-open document.
 * @param {string} docId @param {string} content
 */
function replaceOpenBuffer(docId, content) {
  if (docId !== appState.currentDocId || !editorHandle) return;
  if (currentAutosaver) {
    currentAutosaver.dispose();
    currentAutosaver = null;
  }
  editorHandle.setContent(content);
  if (currentDocRecord) currentDocRecord.content = content;
  currentAutosaver = store.createAutosaver(docId, {
    // onSave emits the frozen `doc:saved` event (docs/editor-plan.md §1.2) —
    // the document list listens for it to refresh badges + sync-button state
    // after every autosave (nothing emitted it before, so "Synced" lingered
    // after local edits until an unrelated re-render).
    onSave: () => { bus.dispatchEvent(new CustomEvent('doc:saved', { detail: { docId } })); },
  });
  refreshPreviewForCurrentMode();
}

/** Reflect the open document in the top-bar title (status-bar path is owned by statusbar.js). */
function updateDocChrome(record) {
  const titleBtn = document.getElementById('doc-title-menu');
  if (titleBtn) {
    const span = titleBtn.querySelector('.doc-title-text');
    // Match the empty state's story ("No document open") instead of implying
    // a phantom "Untitled draft" exists.
    if (span) span.textContent = record?.title || 'No document open';
  }
  updateTopbarSyncBadge(record || null);
}

// ── Top-bar sync badge (review item #6): the active document's sync state,
//    visible while writing — not only in the sidebar/status bar. ────────────
function updateTopbarSyncBadge(record) {
  let badge = document.getElementById('topbar-sync-badge');
  if (!badge) {
    const titleBtn = document.getElementById('doc-title-menu');
    if (!titleBtn || !titleBtn.parentNode) return;
    badge = document.createElement('span');
    badge.id = 'topbar-sync-badge';
    badge.className = 'topbar-sync-badge';
    titleBtn.parentNode.insertBefore(badge, titleBtn.nextSibling);
  }
  if (!record) { badge.hidden = true; return; }
  const status = doclist.deriveSyncStatus(record);
  const LABEL = {
    local: 'Local only', synced: 'Synced', 'local-changes': 'Local changes',
    'remote-changed': 'Remote changed', conflict: 'Conflict',
  };
  badge.textContent = LABEL[status] || status;
  badge.dataset.state = status;
  badge.hidden = false;
  badge.title = status === 'local'
    ? 'This document is not connected to GitHub yet'
    : `Sync state vs GitHub: ${LABEL[status]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar (WP-5.1). statusbar.js now owns the whole status-bar DOM and
// consumes editor:wordcount / editor:cursor / lint:count / sync:status itself
// (the former inline handlers here are deleted). app.js drives the binding +
// badge on doc-switch and flips synced→local-changes on the first edit.
// ─────────────────────────────────────────────────────────────────────────────
/** @type {ReturnType<typeof statusbar.createStatusBar>|null} */
let statusBar = null;

function wireStatusBar() {
  const mount = document.getElementById('statusbar-mount');
  if (mount) {
    try {
      statusBar = statusbar.createStatusBar({ mount, bus });
    } catch (error) {
      console.error('[storykit-editor] statusbar failed to mount', error);
    }
  }

  // First local edit to a bound, currently-synced doc → "Local changes".
  bus.addEventListener('doc:changed', () => {
    if (!statusBar || !currentDocRecord || !currentDocRecord.github) return;
    if (statusBar.getState() === 'synced') statusBar.setSyncState('local-changes');
  });
}

/** Reflect a document's binding + derived badge in the status bar. */
function reflectSyncStatus(record) {
  if (!statusBar) return;
  if (record && record.github) {
    statusBar.setBinding({
      owner: record.github.owner,
      repo: record.github.repo,
      branch: record.github.branch,
      path: record.path,
    });
    statusBar.setSyncState(doclist.deriveSyncStatus(record));
  } else {
    statusBar.setBinding(record ? { path: record.path } : null);
    statusBar.setSyncState('local');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Autosave loop: every debounced doc:changed pushes into the active autosaver.
// ─────────────────────────────────────────────────────────────────────────────
function wireAutosave() {
  bus.addEventListener('doc:changed', (e) => {
    if (currentAutosaver && e.detail && typeof e.detail.content === 'string') {
      currentAutosaver.push(e.detail.content);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Toasts (doclist + app emit `toast` { message, level }).
// ─────────────────────────────────────────────────────────────────────────────
function toastRegion() {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('role', 'status');
    document.body.appendChild(region);
  }
  return region;
}

// One icon per level (spec §5.4 "toasts for async outcomes" — WP-6.2 polish).
const TOAST_ICON_PATHS = {
  success: '<path d="M4 10.5l3.5 3.5L16 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  error: '<path d="M6 6l8 8M14 6l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  warning: '<path d="M10 3.4l7.6 13.2H2.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8.4v3.4M10 14.2h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  info: '<circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v4.2M10 6.6h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

function toastIcon(level) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = TOAST_ICON_PATHS[level] || TOAST_ICON_PATHS.info;
  return svg;
}

// Dismiss policy (WP-6.2, "pick one, document it" — also noted in
// styles.css's toast section): success/warning/info auto-dismiss after a
// consistent interval; error toasts persist until the author closes them,
// since an error usually means something needs their attention. Every toast,
// any level, always gets a close (×) button for manual dismiss.
const TOAST_AUTO_DISMISS_MS = 5000;
const TOAST_LEAVE_MS = 220; // mirrors styles.css's .sk-toast transition-duration

function showToast({ message, level = 'success' } = {}) {
  if (!message) return;
  const region = toastRegion();
  const validLevel = TOAST_ICON_PATHS[level] ? level : 'info';

  const toast = document.createElement('div');
  toast.className = `sk-toast sk-toast-${validLevel} is-entering`;
  // Errors get an assertive nested alert so screen readers announce them
  // immediately, rather than waiting on the region's own `polite` queue.
  toast.setAttribute('role', validLevel === 'error' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'sk-toast-icon';
  icon.appendChild(toastIcon(validLevel));

  const text = document.createElement('span');
  text.className = 'sk-toast-message';
  text.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sk-toast-close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';

  let dismissTimer = null;
  function leave() {
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    toast.classList.remove('is-entering');
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), TOAST_LEAVE_MS);
  }
  close.addEventListener('click', leave);

  toast.append(icon, text, close);
  region.appendChild(toast);

  // Enter transition: `is-entering` (opacity/translate offset, set above
  // before insertion) needs one committed frame before it's removed, or the
  // browser coalesces both states into one and nothing animates. A no-op
  // under prefers-reduced-motion — styles.css zeroes the transition there.
  requestAnimationFrame(() => toast.classList.remove('is-entering'));

  if (validLevel !== 'error') {
    dismissTimer = setTimeout(leave, TOAST_AUTO_DISMISS_MS);
  }
}

function wireToasts() {
  bus.addEventListener('toast', (e) => showToast(e.detail || {}));
  // Keep the top-bar sync badge live: autosaves flip Synced → Local changes,
  // sync operations flip it back.
  const refreshBadge = async () => {
    if (!appState.currentDocId) { updateTopbarSyncBadge(null); return; }
    try {
      const rec = await store.docs.get(appState.currentDocId);
      if (rec) { currentDocRecord = rec; updateTopbarSyncBadge(rec); }
    } catch { /* transient */ }
  };
  bus.addEventListener('doc:saved', refreshBadge);
  bus.addEventListener('sync:status', refreshBadge);
  bus.addEventListener('audit:open', () => openAuditPanel());
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-blocking notice bar (persistence — FR-DOC.8).
// ─────────────────────────────────────────────────────────────────────────────
function showNotice(message, { dismissKey } = {}) {
  // Dismissal is REMEMBERED (prefs) when a dismissKey is given — browsers
  // rarely grant persistent storage to a non-installed site, so without
  // this the storage notice greeted every user on every visit.
  if (dismissKey && appState.prefs.dismissedNotices
      && appState.prefs.dismissedNotices.includes(dismissKey)) return;
  let notice = document.getElementById('app-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'app-notice';
    notice.className = 'app-notice';
    notice.setAttribute('role', 'status');
    const header = document.querySelector('.topbar');
    if (header && header.parentNode) header.parentNode.insertBefore(notice, header.nextSibling);
    else document.body.prepend(notice);
  }
  notice.replaceChildren();
  const span = document.createElement('span');
  span.className = 'app-notice-text';
  span.textContent = message;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'app-notice-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss notice');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => {
    notice.remove();
    if (dismissKey) {
      const list = appState.prefs.dismissedNotices || [];
      if (!list.includes(dismissKey)) list.push(dismissKey);
      appState.prefs.dismissedNotices = list;
      savePrefs();
    }
  });
  notice.append(span, dismiss);
}

async function requestPersistenceNotice() {
  let persisted = false;
  try {
    persisted = await store.requestPersistence();
  } catch {
    persisted = false;
  }
  if (!persisted) {
    showNotice(
      'Drafts live in this browser — commit to GitHub or export anything important.',
      { dismissKey: 'storage-v1' }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fatal error banner (single-instance failure, or any bootstrap throw).
// ─────────────────────────────────────────────────────────────────────────────
export function showFatalBanner(message) {
  let banner = document.getElementById('fatal-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fatal-banner';
    banner.setAttribute('role', 'alert');
    document.body.prepend(banner);
  }
  banner.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = 'Editor failed to start. ';
  const span = document.createElement('span');
  span.textContent = message;
  banner.append(strong, span);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync panel (WP-5.1 · FR-GH.1/2/3/5). A native <dialog> (focus-trapped, Esc
// to close) with four sections: token setup, repo binding, commit, and pull.
// All actions operate on the currently-open document. sync.js does the network
// + store work and surfaces outcomes as toasts; this panel just gathers input
// and reflects state.
// ─────────────────────────────────────────────────────────────────────────────

/** Token setup lives in the editor's own help page (ships with every
 *  deployment, so instructions always match the running version). */
const TOKEN_SETUP_HREF = './help.html#github-token';

/** @type {{ dialog: HTMLDialogElement, refresh: () => void }|null} */
let syncPanel = null;

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k in node) { try { node[k] = v; } catch { node.setAttribute(k, v); } }
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function buildSyncPanel() {
  const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { id: 'sync-panel', class: 'sk-dialog' }));

  const closeBtn = h('button', { type: 'button', class: 'sk-dialog-close', 'aria-label': 'Close', text: '×' });
  closeBtn.addEventListener('click', () => dialog.close());

  // ── Token section (FR-GH.1) ────────────────────────────────────────────────
  const tokenStatus = h('p', { class: 'sk-field-note', id: 'sync-token-status' });
  const tokenInput = /** @type {HTMLInputElement} */ (h('input', {
    type: 'password', class: 'sk-input', id: 'sync-token-input',
    placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: false,
  }));
  const saveTokenBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Save token' });
  const forgetTokenBtn = h('button', { type: 'button', class: 'btn btn-sm', text: 'Forget token' });
  const setupLink = h('a', {
    href: TOKEN_SETUP_HREF, class: 'sk-link', target: '_blank', rel: 'noopener',
    text: 'How to create a token →',
  });

  saveTokenBtn.addEventListener('click', () => {
    const val = tokenInput.value.trim();
    if (!val) { emit('toast', { message: 'Paste a token first.', level: 'error' }); return; }
    github.setToken(val);
    tokenInput.value = '';
    emit('toast', { message: 'Token saved. It’s shared with the preview tool.', level: 'success' });
    refreshSyncPanel();
  });
  forgetTokenBtn.addEventListener('click', () => {
    github.forgetToken();
    emit('toast', { message: 'Token forgotten. The preview tool loses it too (shared key).', level: 'warning' });
    refreshSyncPanel();
  });

  // Novice-friendly collapse: once a token is saved the input/forget rows
  // hide behind a "Change or remove token…" toggle — a returning author sees
  // one reassuring line, not a password field demanding attention.
  const changeTokenBtn = h('button', {
    type: 'button', class: 'btn btn-sm', id: 'sync-token-change', text: 'Change or remove token…',
  });
  const tokenEntryRow = h('div', { class: 'sk-field-row' }, [tokenInput, saveTokenBtn]);
  const tokenManageRow = h('div', { class: 'sk-field-row' }, [forgetTokenBtn, setupLink]);
  const tokenHelpNote = h('p', { class: 'sk-field-note', text: 'One fine-grained personal access token with Contents read/write. Stored in this browser only, under the same key the preview tool uses — forgetting it here affects both tools.' });
  let tokenEditMode = false;
  changeTokenBtn.addEventListener('click', () => { tokenEditMode = true; refreshSyncPanel(); tokenInput.focus(); });

  const tokenSection = h('section', { class: 'sk-dialog-section' }, [
    h('h3', { class: 'sk-dialog-h', text: 'Step 1 · GitHub token' }),
    tokenStatus,
    h('div', { class: 'sk-field-row', id: 'sync-token-collapsed' }, [changeTokenBtn]),
    tokenEntryRow,
    tokenManageRow,
    tokenHelpNote,
  ]);

  // ── Binding section (FR-GH.2) ──────────────────────────────────────────────
  const ownerInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'sk-input', id: 'sync-owner', placeholder: 'owner' }));
  const repoInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'sk-input', id: 'sync-repo', placeholder: 'repo' }));
  const branchInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'sk-input', id: 'sync-branch', placeholder: 'branch (created if new)' }));
  const pathInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'sk-input', id: 'sync-path', placeholder: '_posts/…' }));
  const bindBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', id: 'sync-bind-btn', text: 'Connect' });

  bindBtn.addEventListener('click', async () => {
    const docId = appState.currentDocId;
    if (!docId) { emit('toast', { message: 'Open a document first.', level: 'error' }); return; }
    const binding = {
      owner: ownerInput.value.trim(),
      repo: repoInput.value.trim(),
      branch: branchInput.value.trim(),
      path: pathInput.value.trim(),
    };
    if (!binding.owner || !binding.repo || !binding.branch || !binding.path) {
      emit('toast', { message: 'Owner, repo, branch, and path are all required.', level: 'error' });
      return;
    }
    bindBtn.disabled = true;
    try {
      const saved = await sync.bindDocument(docId, binding);
      currentDocRecord = saved;
      appState.binding = { owner: saved.github.owner, repo: saved.github.repo, branch: saved.github.branch, path: saved.path };
      refreshPreviewForCurrentMode();
      refreshSyncPanel();
    } catch { /* sync.js already toasted */ }
    finally { bindBtn.disabled = false; }
  });

  // WP-6.2: explicit unbound/bound guidance — the "Sync" section below is
  // entirely `hidden` while unbound, so without this note an author sees
  // no copy at all explaining *why* Commit/Pull aren't available yet.
  const bindingNote = h('p', { class: 'sk-field-note', id: 'sync-binding-note' });

  const bindingSection = h('section', { class: 'sk-dialog-section' }, [
    h('h3', { class: 'sk-dialog-h', text: 'Step 2 · Repository' }),
    bindingNote,
    h('div', { class: 'sk-field-grid' }, [
      h('label', { class: 'sk-label', text: 'Owner' }), ownerInput,
      h('label', { class: 'sk-label', text: 'Repo' }), repoInput,
      h('label', { class: 'sk-label', text: 'Branch' }), branchInput,
      h('label', { class: 'sk-label', text: 'Path' }), pathInput,
    ]),
    h('div', { class: 'sk-field-row' }, [bindBtn]),
  ]);

  // ── Sync section (FR-GH.3/5) ────────────────────────────────────────────────
  const syncState = h('p', { class: 'sk-field-note', id: 'sync-state-line' });
  const msgInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'sk-input', id: 'sync-msg', placeholder: 'Commit message — a short note describing this change' }));
  const commitBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', id: 'sync-commit-btn', text: 'Commit' });
  const pullBtn = h('button', { type: 'button', class: 'btn btn-sm', id: 'sync-pull-btn', text: 'Pull latest' });

  // Prominent in-dialog confirmation (a toast alone is easy to miss and the
  // post-action refresh makes the panel look "reset" — novices couldn't tell
  // the commit happened). Cleared when the dialog closes.
  const resultNote = h('p', { class: 'sk-sync-result', id: 'sync-result', role: 'status' });
  resultNote.hidden = true;
  function showResult(message) {
    resultNote.textContent = message;
    resultNote.hidden = false;
  }

  commitBtn.addEventListener('click', async () => {
    const docId = appState.currentDocId;
    if (!docId) return;
    commitBtn.disabled = true;
    try {
      const saved = await sync.commitDocument(docId, { message: msgInput.value.trim() });
      if (saved) {
        currentDocRecord = saved;
        refreshSyncPanel();
        const gh = saved.github || {};
        showResult(`✓ Committed to ${gh.owner}/${gh.repo} on ${gh.branch} at ${new Date().toLocaleTimeString()}. Your document and GitHub now match — you can close this dialog.`);
      }
    } catch { /* toasted */ }
    finally { commitBtn.disabled = false; }
  });
  pullBtn.addEventListener('click', async () => {
    const docId = appState.currentDocId;
    if (!docId) return;
    pullBtn.disabled = true;
    try {
      const saved = await sync.pullDocument(docId);
      if (saved) {
        currentDocRecord = saved;
        refreshSyncPanel();
        showResult(`✓ Pulled the latest version from GitHub into the editor (a snapshot of your previous text was saved to this document's history first).`);
      }
    } catch { /* toasted */ }
    finally { pullBtn.disabled = false; }
  });

  const syncSection = h('section', { class: 'sk-dialog-section', id: 'sync-actions-section' }, [
    h('h3', { class: 'sk-dialog-h', text: 'Step 3 · Commit & pull' }),
    syncState,
    h('div', { class: 'sk-field-row' }, [msgInput]),
    h('p', { class: 'sk-field-note', text: 'The message is saved in the repository\u2019s history next to your change \u2014 future-you will thank present-you for a descriptive one.' }),
    h('div', { class: 'sk-field-row' }, [commitBtn, pullBtn]),
    resultNote,
  ]);

  // Bookmarklet: drag to the bookmarks bar; on any GitHub file page it opens
  // this editor with that file (?open=<blob URL> → openRemoteRef at boot).
  const editorUrl = new URL(window.location.pathname, window.location.origin).href;
  const bookmarklet = h('a', {
    class: 'sk-bookmarklet', id: 'open-bookmarklet', text: 'Edit in StoryKit',
    title: 'Drag me to your bookmarks bar, then click me on any GitHub file page',
  });
  bookmarklet.setAttribute('href',
    `javascript:(function(){var u=location.href;` +
    `if(!/github\\.com\\/[^/]+\\/[^/]+\\/(blob|edit)\\//.test(u)){alert('Open a file on GitHub first');return;}` +
    `window.open(${JSON.stringify(editorUrl)}+'?open='+encodeURIComponent(u));})();`);
  bookmarklet.addEventListener('click', (e) => e.preventDefault()); // drag-only in situ
  const bookmarkletSection = h('section', { class: 'sk-dialog-section' }, [
    h('h3', { class: 'sk-dialog-h', text: 'Bookmarklet' }),
    h('p', { class: 'sk-field-note' }, [
      document.createTextNode('Drag '),
      bookmarklet,
      document.createTextNode(' to your bookmarks bar. Clicking it on any GitHub file page opens that file here. You can also drag a file link from GitHub straight into the document list.'),
    ]),
  ]);

  const doneBtn = h('button', {
    type: 'button', class: 'btn btn-primary', id: 'sync-done-btn', text: 'Done',
  });
  doneBtn.addEventListener('click', () => dialog.close());

  const body = h('div', { class: 'sk-dialog-body' }, [
    h('header', { class: 'sk-dialog-head' }, [h('h2', { class: 'sk-dialog-title', text: 'GitHub sync' }), closeBtn]),
    tokenSection, bindingSection, syncSection, bookmarkletSection,
    h('footer', { class: 'sk-dialog-foot' }, [doneBtn]),
  ]);
  dialog.append(body);
  dialog.addEventListener('close', () => { resultNote.hidden = true; tokenEditMode = false; });
  document.body.appendChild(dialog);

  const SYNC_LABEL = {
    local: 'Local only', synced: 'Synced', 'local-changes': 'Local changes',
    'remote-changed': 'Remote changed', conflict: 'Conflict',
  };

  function refresh() {
    // Token status + novice collapse: saved token → one reassuring line and
    // a "Change or remove token…" toggle; no token (or editing) → the input.
    const hasToken = !!github.getToken();
    tokenStatus.textContent = hasToken
      ? '✓ A token is saved in this browser — GitHub sync is ready.'
      : 'No token saved yet — paste one below (see the guide for the two-minute setup).';
    forgetTokenBtn.disabled = !hasToken;
    const collapsed = hasToken && !tokenEditMode;
    changeTokenBtn.parentElement.hidden = !collapsed;
    tokenEntryRow.hidden = collapsed;
    tokenManageRow.hidden = collapsed;
    tokenHelpNote.hidden = collapsed;

    // Binding fields prefilled from the open doc.
    const rec = currentDocRecord;
    const gh = rec && rec.github;
    if (gh) {
      ownerInput.value = gh.owner || '';
      repoInput.value = gh.repo || '';
      branchInput.value = gh.branch || '';
    }
    if (rec) pathInput.value = (rec.path) || pathInput.value || '';
    bindBtn.textContent = gh ? 'Update binding' : 'Connect';

    const bound = !!gh;
    bindingNote.textContent = bound
      ? `Connected to ${gh.owner}/${gh.repo} on ${gh.branch}. Committing and pulling are below.`
      : 'Not connected yet. Fill in a repository below and click Connect to enable committing and pulling changes for this document.';
    syncSection.hidden = !bound;
    commitBtn.disabled = !bound;
    pullBtn.disabled = !bound;
    if (!msgInput.value && rec && rec.path) {
      msgInput.value = `Update ${String(rec.path).split('/').pop()}`;
    }
    const state = bound ? doclist.deriveSyncStatus(rec) : 'local';
    syncState.textContent = bound
      ? `Status: ${SYNC_LABEL[state] || state}${gh.syncedAt ? ` · last synced ${new Date(gh.syncedAt).toLocaleString()}` : ''}`
      : 'Not connected to a repository.';

    const noDoc = !appState.currentDocId;
    bindBtn.disabled = noDoc;
  }

  return { dialog, refresh };
}

function refreshSyncPanel() {
  if (syncPanel) syncPanel.refresh();
}

// ─────────────────────────────────────────────────────────────────────────────
// Document audit: the preview tool the editor grew from had an Audit feature;
// this is its equivalent — computeDiagnostics() over the WHOLE buffer (the
// same rules the inline squiggles use), presented as a navigable report.
// ─────────────────────────────────────────────────────────────────────────────
let auditPanel = null;

function runAudit() {
  if (!editorHandle) return null;
  const view = editorHandle.view;
  const text = view.state.doc.toString();
  const diags = langStorykit.computeDiagnostics(text, { catalog }) || [];
  const seen = new Set();
  return diags.map((d) => {
    const line = view.state.doc.lineAt(Math.min(d.from, view.state.doc.length)).number;
    return { ...d, line };
  }).filter((d) => {
    // Dedupe identical (line, message) pairs — e.g. a front-matter YAML
    // error is attached to both the open and close fence.
    const key = `${d.line}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.line - b.line || (a.severity === 'error' ? -1 : 1));
}

async function openAuditPanel() {
  if (!appState.currentDocId || !editorHandle) return;
  if (!auditPanel) {
    const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { id: 'audit-panel', class: 'sk-dialog' }));
    const closeX = h('button', { type: 'button', class: 'sk-dialog-close', 'aria-label': 'Close', text: '×' });
    closeX.addEventListener('click', () => dialog.close());
    const summary = h('p', { id: 'audit-summary', class: 'sk-field-note', role: 'status' });
    const listHost = h('div', { id: 'audit-list' });
    const rerunBtn = h('button', { type: 'button', class: 'btn', id: 'audit-rerun', text: 'Re-run audit' });
    rerunBtn.addEventListener('click', () => populate());
    const closeBtn = h('button', { type: 'button', class: 'btn btn-primary', text: 'Close' });
    closeBtn.addEventListener('click', () => dialog.close());
    dialog.append(h('div', { class: 'sk-dialog-body' }, [
      h('header', { class: 'sk-dialog-head' }, [
        h('h2', { class: 'sk-dialog-title', text: 'Document audit' }), closeX,
      ]),
      summary,
      listHost,
      h('footer', { class: 'sk-dialog-foot' }, [rerunBtn, closeBtn]),
    ]));
    document.body.appendChild(dialog);
    auditPanel = { dialog, summary, listHost };
  }
  const { dialog, summary, listHost } = auditPanel;

  function populate() {
    const diags = runAudit() || [];
    const errors = diags.filter((d) => d.severity === 'error').length;
    const warns = diags.length - errors;
    if (!diags.length) {
      summary.textContent = '✓ No issues found — StoryKit tags, action links, and front matter all check out.';
      listHost.replaceChildren();
      return;
    }
    summary.textContent = `${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'} — click a line number to jump there.`;
    const rows = diags.map((d) => {
      const lineBtn = h('button', { type: 'button', class: 'btn btn-sm sk-audit-line', text: `Line ${d.line}` });
      lineBtn.addEventListener('click', () => {
        dialog.close();
        bus.dispatchEvent(new CustomEvent('preview:goto-line', { detail: { line: d.line } }));
      });
      return h('div', { class: `sk-audit-row sk-audit-${d.severity}` }, [
        h('span', { class: 'sk-audit-sev', text: d.severity === 'error' ? '✖' : '⚠',
                    'aria-label': d.severity }),
        lineBtn,
        h('span', { class: 'sk-audit-msg', text: d.message }),
      ]);
    });
    listHost.replaceChildren(...rows);
  }

  populate();
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
}

// ─────────────────────────────────────────────────────────────────────────────
// Revision restore (UX review item #9): the safety snapshots existed since M5
// but had no UI — an invisible safety net. This makes it visible.
// ─────────────────────────────────────────────────────────────────────────────
let restorePanel = null;

const REVISION_REASON_LABEL = {
  auto: 'Autosave checkpoint',
  'pre-pull': 'Before Pull',
  'pre-conflict': 'Before conflict resolution',
  'pre-restore': 'Before a restore',
  manual: 'Manual snapshot',
};

function snippetOf(content) {
  const body = String(content || '').replace(/^---[\s\S]*?\n---\n?/, '');
  const line = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('{%'));
  const t = line || '(empty document)';
  return t.length > 72 ? t.slice(0, 72) + '…' : t;
}

async function openRestorePanel() {
  const docId = appState.currentDocId;
  if (!docId) return;
  if (!restorePanel) {
    const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { id: 'restore-panel', class: 'sk-dialog' }));
    const closeX = h('button', { type: 'button', class: 'sk-dialog-close', 'aria-label': 'Close', text: '×' });
    closeX.addEventListener('click', () => dialog.close());
    const listHost = h('div', { id: 'restore-list' });
    const closeBtn = h('button', { type: 'button', class: 'btn btn-primary', text: 'Close' });
    closeBtn.addEventListener('click', () => dialog.close());
    dialog.append(h('div', { class: 'sk-dialog-body' }, [
      h('header', { class: 'sk-dialog-head' }, [
        h('h2', { class: 'sk-dialog-title', text: 'Restore a previous version' }), closeX,
      ]),
      h('p', { class: 'sk-field-note', text: 'Snapshots are taken automatically while you work and before anything replaces your text (Pull, conflict resolution, restores). Restoring is safe: your current text is snapshotted first.' }),
      listHost,
      h('footer', { class: 'sk-dialog-foot' }, [closeBtn]),
    ]));
    document.body.appendChild(dialog);
    restorePanel = { dialog, listHost };
  }
  const { dialog, listHost } = restorePanel;
  listHost.replaceChildren(h('p', { class: 'sk-field-note', text: 'Loading…' }));
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();

  let revs = [];
  try { revs = await store.revisions.list(docId); } catch { revs = []; }
  if (!revs.length) {
    listHost.replaceChildren(h('p', { class: 'sk-field-note',
      text: 'No snapshots yet — they accumulate automatically as you edit.' }));
    return;
  }
  const rows = revs.map((rev) => {
    const restoreBtn = h('button', { type: 'button', class: 'btn btn-sm', text: 'Restore' });
    restoreBtn.addEventListener('click', async () => {
      restoreBtn.disabled = true;
      try {
        const current = editorHandle ? editorHandle.getContent()
          : (currentDocRecord && currentDocRecord.content) || '';
        await store.revisions.snapshot(docId, current, 'pre-restore');
        const saved = await store.docs.update(docId, { content: rev.content });
        if (editorHandle) editorHandle.setContent(rev.content);
        currentDocRecord = saved || currentDocRecord;
        bus.dispatchEvent(new CustomEvent('doc:saved', { detail: { docId } }));
        emit('toast', { message: `Restored the version from ${new Date(rev.createdAt).toLocaleString()} — your previous text was snapshotted first.`, level: 'success' });
        dialog.close();
        renderPreviewForModeIfVisible();
      } catch (err) {
        emit('toast', { message: `Restore failed: ${err?.message || err}`, level: 'error' });
        restoreBtn.disabled = false;
      }
    });
    return h('div', { class: 'sk-restore-row' }, [
      h('div', { class: 'sk-restore-meta' }, [
        h('strong', { text: new Date(rev.createdAt).toLocaleString() }),
        h('span', { class: 'sk-restore-reason', text: REVISION_REASON_LABEL[rev.reason] || rev.reason }),
        h('span', { class: 'sk-restore-snippet', text: snippetOf(rev.content) }),
      ]),
      restoreBtn,
    ]);
  });
  listHost.replaceChildren(...rows);
}

/** Re-render the preview if it is on screen (post-restore refresh). */
function renderPreviewForModeIfVisible() {
  if (appState.mode === 'split' || appState.mode === 'preview') {
    if (editorHandle) renderPreviewNow(editorHandle.getContent());
  }
}

export function openSyncPanel() {
  if (!syncPanel) syncPanel = buildSyncPanel();
  syncPanel.refresh();
  if (typeof syncPanel.dialog.showModal === 'function' && !syncPanel.dialog.open) {
    syncPanel.dialog.showModal();
  }
}

function wireSyncPanel() {
  // sync.js reads the freshest live buffer + pushes replacements into the editor.
  sync.setEditorBridge({
    getLocalContent: (docId) =>
      (docId === appState.currentDocId && editorHandle) ? editorHandle.getContent() : null,
    replaceBuffer: (docId, content) => replaceOpenBuffer(docId, content),
  });

  bus.addEventListener('sync:open-panel', () => openSyncPanel());
  document.getElementById('overflow-menu')?.addEventListener('click', () => openSyncPanel());
}

// ─────────────────────────────────────────────────────────────────────────────
// Command palette + toolbar (WP-6.1 · spec §5.4/§7).
//
// Both surfaces are thin UI shells (palette.js / toolbar.js) driven by
// zero-arg callbacks defined HERE, so they always operate on the CURRENT
// `editorHandle`/`currentDocRecord` (both destroyed/recreated over the
// app's lifetime — theme change, doc switch) rather than a stale captured
// reference, mirroring the pre-existing "Link entity" top-bar button
// precedent this WP removes (see wireControls() below).
//
// ── ⌘K → command palette; ⌘K → insertLink is GONE (WP-6.1 remap) ─────────
// Spec §5.4 gives ⌘K to the palette; FR-EDIT.6 originally gave ⌘K to
// insertLink (editor/commands.js). Integrator decision (docs/editor-plan.md
// WP-6.1 brief, restated in commands.js's header): the palette wins ⌘K
// GLOBALLY — bound at the WINDOW level, capture phase, in wireControls()
// below — and insertLink moves to Mod-Shift-l (⌘⇧L) in commands.js's
// `editorKeymap`. Capture phase is load-bearing: it lets this listener see
// (and preventDefault + stopPropagation) the keystroke BEFORE it can reach
// CM6's own contentDOM keydown listener, so the editor never gets a chance
// to run whatever (if anything) is bound to bare Mod-k, and BEFORE the
// browser's own Ctrl/Cmd+K default (address-bar focus in some browsers)
// fires. Both the old (⌘K) and new (⌘⇧L) insert-link muscle memory paths
// stay reachable: ⌘⇧L directly, or "Insert link" via the palette/toolbar.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {ReturnType<typeof palette.createPalette>|null} */
let paletteHandle = null;
/** @type {ReturnType<typeof toolbar.createToolbar>|null} */
let toolbarHandle = null;

/** Minimal Blob-download export for the currently open document — the
 * palette's "Export document" entry. Deliberately NOT delegated to
 * doclist.js (its per-item export logic is private to createDocList()'s
 * closure, and doclist.js is outside this WP's file ownership) — this is a
 * small, independent reimplementation of the same idea for the open doc. */
function exportCurrentDoc() {
  const rec = currentDocRecord;
  if (!rec) return;
  try {
    const filename = rec.path
      ? String(rec.path).split('/').pop()
      : doclist.buildFilename(new Date(rec.updatedAt || rec.createdAt || Date.now()), rec.title || 'untitled');
    const blob = new Blob([rec.content || ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    emit('toast', { message: `Exported ${filename}`, level: 'success' });
  } catch (err) {
    emit('toast', { message: `Export failed: ${err?.message || err}`, level: 'error' });
  }
}

/** Clicks a sync-panel button by id after ensuring the panel is open/fresh —
 * reuses the panel's own commit/pull handlers rather than duplicating the
 * network logic (they already guard on `appState.currentDocId`/disabled
 * state). Used by the palette's "Commit" / "Pull latest" entries. */
function triggerSyncPanelAction(buttonId) {
  openSyncPanel();
  const btn = document.getElementById(buttonId);
  if (btn && !btn.disabled) btn.click();
}

/**
 * The full command registry (docs/editor-plan.md WP-6.1 brief's AT-MINIMUM
 * list): New post, mode switches, theme cycle, sidebar toggle, Bold/Italic/
 * Insert link/Heading cycle/Insert list item, the six Insert-viewer
 * commands, Link entity, Open sync panel/Commit/Pull, Export document.
 * Built ONCE at boot — entries are stable closures over the module-level
 * mutable state above; `when()` is re-evaluated live on every palette open()
 * so gating (e.g. "Commit" only once bound) always reflects the current
 * app state without rebuilding the array.
 * @returns {Array<{id:string,label:string,group:string,shortcut?:string,when?:()=>boolean,run:()=>void}>}
 */
function buildCommandRegistry() {
  const hasEditor = () => !!editorHandle;
  const hasBoundDoc = () => !!(currentDocRecord && currentDocRecord.github);

  /** @type {Array<{id:string,label:string,group:string,shortcut?:string,when?:()=>boolean,run:()=>void}>} */
  const registry = [
    { id: 'doc.new', label: 'New post', group: 'Document', when: () => !!docListHandle,
      run: openNewDocFlow },
    { id: 'doc.export', label: 'Export document', group: 'Document', when: () => !!currentDocRecord,
      run: exportCurrentDoc },

    { id: 'view.mode.edit', label: 'Edit mode', group: 'View', run: () => setMode('edit') },
    { id: 'view.mode.split', label: 'Split mode', group: 'View', run: () => setMode('split') },
    { id: 'view.mode.preview', label: 'Preview mode', group: 'View', run: () => setMode('preview') },
    { id: 'view.theme', label: 'Cycle theme', group: 'View', run: cycleTheme },
    { id: 'view.sidebar', label: 'Toggle document sidebar', group: 'View', run: toggleSidebar },

    { id: 'format.bold', label: 'Bold', group: 'Format', shortcut: '⌘B', when: hasEditor,
      run: () => commands.toggleBold(editorHandle.view) },
    { id: 'format.italic', label: 'Italic', group: 'Format', shortcut: '⌘I', when: hasEditor,
      run: () => commands.toggleItalic(editorHandle.view) },
    { id: 'format.link', label: 'Insert link', group: 'Format', shortcut: '⌘⇧L', when: hasEditor,
      run: () => commands.insertLink(editorHandle.view) },
    { id: 'format.heading', label: 'Heading level', group: 'Format', when: hasEditor,
      run: () => commands.cycleHeading(editorHandle.view) },
    { id: 'format.list', label: 'Insert list item', group: 'Format', when: hasEditor,
      run: () => toolbar.insertListItem(editorHandle.view) },

    { id: 'entity.link', label: 'Link entity', group: 'Entity', shortcut: '⌘⇧K', when: hasEditor,
      run: () => wikidata.linkEntityCommand(editorHandle.view) },

    { id: 'doc.audit', label: 'Audit document', group: 'Document',
      when: () => !!appState.currentDocId, run: () => openAuditPanel() },

    { id: 'doc.restore', label: 'Restore previous version…', group: 'Document',
      when: () => !!appState.currentDocId, run: () => openRestorePanel() },

    { id: 'help.open', label: 'Open help', group: 'Help',
      run: () => window.open('./help.html', '_blank', 'noopener') },

    { id: 'view.spellcheck', label: 'Toggle spell check', group: 'View',
      run: () => {
        appState.prefs.spellcheck = appState.prefs.spellcheck === false;
        savePrefs();
        if (editorHandle) {
          editorHandle.view.dispatch({ effects: spellcheckCompartment.reconfigure(spellcheckAttrs()) });
          editorHandle.view.focus();
          kickSpellcheck();
        }
        showToast({ message: `Spell check ${appState.prefs.spellcheck === false ? 'off' : 'on'} (uses your browser's dictionary).`, level: 'success' });
      } },

    { id: 'view.scrollsync', label: 'Toggle split-view scroll sync', group: 'View',
      run: () => {
        appState.prefs.scrollSync = appState.prefs.scrollSync === false;
        savePrefs();
        showToast({ message: `Scroll sync ${appState.prefs.scrollSync === false ? 'off' : 'on'}.`, level: 'success' });
      } },

    { id: 'sync.panel', label: 'Open sync panel', group: 'Sync', run: () => openSyncPanel() },
    { id: 'sync.commit', label: 'Commit', group: 'Sync', when: hasBoundDoc,
      run: () => triggerSyncPanelAction('sync-commit-btn') },
    { id: 'sync.pull', label: 'Pull latest', group: 'Sync', when: hasBoundDoc,
      run: () => triggerSyncPanelAction('sync-pull-btn') },
  ];

  for (const key of toolbar.VIEWER_KEYS) {
    registry.push({
      id: `insert.viewer.${key}`,
      label: `Insert ${toolbar.VIEWER_LABELS[key]} viewer`,
      group: 'Insert',
      when: hasEditor,
      run: () => toolbar.insertViewerTag(editorHandle.view, key),
    });
  }

  return registry;
}

/** Zero-arg toolbar action callbacks — see the section header note above. */
const toolbarActions = {
  bold: () => editorHandle && commands.toggleBold(editorHandle.view),
  italic: () => editorHandle && commands.toggleItalic(editorHandle.view),
  link: () => editorHandle && commands.insertLink(editorHandle.view),
  heading: () => editorHandle && commands.cycleHeading(editorHandle.view),
  list: () => editorHandle && toolbar.insertListItem(editorHandle.view),
  linkEntity: () => editorHandle && wikidata.linkEntityCommand(editorHandle.view),
  audit: () => openAuditPanel(),
  insertViewer: (key) => editorHandle && toolbar.insertViewerTag(editorHandle.view, key),
};

function wireCommandSurface() {
  paletteHandle = palette.createPalette({ mount: document.body, commands: buildCommandRegistry() });

  const toolbarMount = document.getElementById('toolbar-mount');
  if (toolbarMount) {
    toolbarHandle = toolbar.createToolbar({ mount: toolbarMount, actions: toolbarActions });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap.
// ─────────────────────────────────────────────────────────────────────────────
export async function init() {
  // Theme + mode restored before first paint of interactive state.
  applyTheme(appState.prefs.theme);
  setMode(appState.prefs.mode);
  setSidebarCollapsed(appState.prefs.sidebarCollapsed);

  // Risk R-3 gate — do not mount the editor on a broken module graph.
  const check = assertSingleInstance();
  if (!check.ok) {
    showFatalBanner(
      `CodeMirror single-instance check failed (risk R-3): ${check.error?.message || check.error}. ` +
      `The import map in editor/index.html is loading duplicate @codemirror/state copies.`
    );
    console.error('[storykit-editor] single-instance assertion failed', check.error);
    return { ok: false };
  }

  // NOTE (WP-6.2, no-CLS): the #editor-mount skeleton baked into
  // editor/index.html is deliberately NOT removed here. It stays on screen
  // until real content replaces it — either mountEditor() (opening a
  // restored/new document) or showEditorEmptyState() (nothing to restore) —
  // both of which already `mount.replaceChildren(...)` as their first move.
  // Dropping it eagerly here (the previous behaviour) left a blank mount
  // for the whole store.initStore() + doc-restore await below, which is
  // exactly the flash §5.4 asks to eliminate.

  wireControls();
  wireLifecycle();
  wireStatusBar();
  wireAutosave();
  wireToasts();
  wirePreview();
  wireSyncPanel();
  wireCommandSurface();

  // Open the local store, then wire the document list against it.
  try {
    await store.initStore();
  } catch (error) {
    showFatalBanner(`Local storage failed to open: ${error?.message || error}`);
    console.error('[storykit-editor] initStore failed', error);
    return { ok: false };
  }

  const dlMount = document.getElementById('doclist-mount');
  if (dlMount) {
    try {
      docListHandle = doclist.createDocList({
        mount: dlMount,
        store: { docs: store.docs },
        bus,
        onOpen: (docId) => { openDoc(docId); },
        // "Sync with GitHub" in each row's action cluster: open that document
        // (no-op if already open), then the sync panel.
        onSync: async (docId) => { await openDoc(docId); openSyncPanel(); },
        // "Open…" button + GitHub-link drops: open an EXISTING repo file as a
        // bound document (or focus it if it's already in the list).
        onOpenRemote: (ref) => { openRemoteRef(ref); },
      });
    } catch (error) {
      console.error('[storykit-editor] doclist failed to mount', error);
    }
  }

  // Restore the last-open document (FR-DOC.3 "over multiple sessions"); else
  // show the empty state until the author creates/opens one.
  let restored = false;
  const lastId = appState.prefs.lastDocId;
  if (lastId) {
    try {
      const record = await store.docs.get(lastId);
      if (record) {
        await openDoc(lastId);
        restored = true;
      }
    } catch (error) {
      console.warn('[storykit-editor] could not restore last document', error);
    }
  }
  if (!restored) showEditorEmptyState();

  // ── Open-from-URL (bookmarklet entry point) ────────────────────────────────
  // ?repo=<owner>/<name>&branch=<b>&open=<repo/path.md> — or a single
  // ?open=<full github.com blob URL>. Takes precedence over the restored
  // document; the params are stripped afterwards so a plain reload returns
  // to normal last-document behavior (reopening is idempotent anyway).
  try {
    const params = new URLSearchParams(window.location.search);
    const openParam = params.get('open');
    if (openParam) {
      let ref = openParam;
      const repoParam = params.get('repo');
      if (repoParam && !/^https?:/i.test(openParam)) {
        const [owner, repo] = repoParam.split('/');
        ref = `${owner}/${repo}/${params.get('branch') || 'main'}/${openParam.replace(/^\/+/, '')}`;
      }
      const opened = await openRemoteRef(ref);
      if (opened) {
        params.delete('open'); params.delete('repo'); params.delete('branch');
        const qs = params.toString();
        window.history.replaceState(null, '',
          window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
      }
    }
  } catch (error) {
    console.warn('[storykit-editor] open-from-URL failed', error);
  }

  // Request durable storage (non-blocking; FR-DOC.8).
  requestPersistenceNotice();

  return { ok: true, editor: editorHandle };
}

/**
 * Open an existing GitHub file (URL, owner/repo/branch/path shorthand, or a
 * bare repo path resolved against the current binding) as a bound document.
 * Used by the doclist "Open…" button, GitHub-link drops, and ?open= URLs.
 * @param {string} ref
 * @returns {Promise<boolean>} true when a document was opened
 */
export async function openRemoteRef(ref) {
  const parsed = sync.parseGitHubFileRef(ref, appState.binding);
  if (!parsed) {
    showToast({ message: `Couldn't understand "${String(ref).slice(0, 80)}" as a GitHub file — paste a github.com file URL or bind a repository first.`, level: 'error' });
    return false;
  }
  try {
    const { docId } = await sync.openFromGitHub(parsed);
    await openDoc(docId);
    return true;
  } catch {
    return false; // openFromGitHub already toasted the specific failure
  }
}

function wireControls() {
  for (const btn of document.querySelectorAll('[data-mode-btn]')) {
    btn.addEventListener('click', () => setMode(btn.getAttribute('data-mode-btn')));
  }
  document.getElementById('sidebar-toggle')?.addEventListener('click', toggleSidebar);
  document.getElementById('theme-toggle')?.addEventListener('click', cycleTheme);

  // WP-4.3 added a top-bar "Link entity" affordance (FR-WD.1); WP-6.1
  // REMOVED it (and its #link-entity-btn markup in index.html) once the
  // toolbar's own "Link entity" button — and the palette's "Link entity"
  // entry — covered the same action, avoiding a duplicate control (⌘⇧K
  // still works either way; only the standalone top-bar icon is gone).

  // ⌘E / Ctrl-E cycles Edit → Split → Preview (spec FR-PRE.1).
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      const order = /** @type {EditorMode[]} */ (['edit', 'split', 'preview']);
      setMode(order[(order.indexOf(appState.mode) + 1) % order.length]);
    }
  });

  // WP-6.1: ⌘K / Ctrl-K opens the command palette. WINDOW-level, CAPTURE
  // phase (the `true` 3rd arg) — see the "Command palette + toolbar"
  // section header above for why capture phase is load-bearing (it lets
  // this listener preventDefault+stopPropagation the keystroke before it
  // can reach CM6's own contentDOM keydown handling OR the browser's own
  // Ctrl/Cmd+K default). Works regardless of what currently has focus
  // (editor, sidebar, toolbar, body) — spec §5.4's "works outside editor
  // focus too".
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      paletteHandle?.open();
    }
  }, true);
}

function wireLifecycle() {
  // Re-theme the editor when the OS scheme changes while in 'system' mode.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    // Page chrome re-themes via CSS automatically; rebuild CM for its colors.
    if (appState.prefs.theme === 'system') rethemeEditor();
  });

  // Esc closes the mobile sidebar overlay (dialogs/palette own their own Esc
  // handling; this only fires when the overlay is actually open, so it never
  // competes with them).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
      closeSidebarOverlay();
    }
  });

  // A resize that crosses the narrow/wide breakpoint should never leave the
  // overlay-only `sidebar-open` state stuck on past it (e.g. rotating a
  // tablet, or a desktop window resize during a demo).
  window.matchMedia(NARROW_QUERY).addEventListener('change', (e) => {
    if (!e.matches) closeSidebarOverlay();
  });
}

// Auto-boot only on the editor page — identified by the presence of
// #editor-mount. The unit-test harness has no such element (and may set
// window.__SK_NO_AUTOBOOT), so importing app.js there is side-effect-free.
if (typeof window !== 'undefined'
    && !window.__SK_NO_AUTOBOOT
    && document.getElementById('editor-mount')) {
  init();
}
