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
 *     commands.js's Mod-k (`insertLink`); a small "Link entity" icon button
 *     is also added to the top bar next to the mode segmented control (spec
 *     §7 permits a plain, token-styled button ahead of M6's full toolbar).
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
import { EditorState, StateField, Prec } from '@codemirror/state';
import { keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
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
import * as statusbar from './statusbar.js';
import * as github from './github.js';
import * as context from './context.js';
import * as wikidata from './wikidata.js';
import * as dnd from './dnd.js';
import * as sync from './sync.js';
import * as conflict from './conflict.js';
import { catalog } from './viewer-catalog.js';

// Keep tree-shakers / linters from flagging the skeleton imports as unused, and
// give integration WPs a single object to reach the module namespaces through.
export const modules = {
  store, editor, commands, langStorykit, doclist, preview, statusbar,
  github, context, wikidata, dnd, sync, conflict,
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
// Sidebar collapse.
// ─────────────────────────────────────────────────────────────────────────────
export function setSidebarCollapsed(collapsed) {
  appState.prefs.sidebarCollapsed = !!collapsed;
  document.body.classList.toggle('sidebar-collapsed', !!collapsed);
  const btn = document.getElementById('sidebar-toggle');
  if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
  savePrefs();
}

export function toggleSidebar() {
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
 */
function buildExtraExtensions() {
  return [
    autocompletion(),
    keymap.of(completionKeymap),
    langStorykit.storykit({ catalog }),
    dnd.dndExtension({ onNotice: (n) => emit('toast', n) }),
    wikidata.qidHoverExtension(),
    Prec.highest(keymap.of([{ key: 'Mod-Shift-k', run: wikidata.linkEntityCommand, preventDefault: true }])),
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
  return editorHandle;
}

/** Tear the editor down and show the "no document open" placeholder. */
function showEditorEmptyState() {
  if (editorHandle) {
    editorHandle.destroy();
    editorHandle = null;
  }
  currentDocRecord = null;
  const mount = getEditorMount();
  if (!mount) return;
  mount.classList.add('is-empty');
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  const title = document.createElement('p');
  title.className = 'empty-title';
  title.textContent = 'No document open';
  const hint = document.createElement('p');
  hint.className = 'empty-hint';
  hint.textContent = 'Create a new post with “+ New”, or open a draft from the sidebar. '
    + 'Everything is stored locally in your browser.';
  wrap.append(title, hint);
  mount.replaceChildren(wrap);
  appState.binding = null;
  updateDocChrome(null);
  reflectSyncStatus(null);
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
  if (!editorHandle) return;
  if (appState.mode === 'preview' || appState.mode === 'split') {
    renderPreviewNow(editorHandle.getContent());
  }
}

function wirePreview() {
  const mount = document.getElementById('preview-mount');
  if (!mount) return;
  previewHandle = preview.createPreviewPane({ mount });

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
  // Binding drives preview context resolution (FR-PRE.4) and the status bar.
  appState.binding = record.github
    ? { owner: record.github.owner, repo: record.github.repo, branch: record.github.branch, path: record.path }
    : null;

  mountEditor(record.content || '');
  updateDocChrome(record);
  reflectSyncStatus(record);

  currentAutosaver = store.createAutosaver(docId);
  editorHandle?.focus();

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
  currentAutosaver = store.createAutosaver(docId);
  refreshPreviewForCurrentMode();
}

/** Reflect the open document in the top-bar title (status-bar path is owned by statusbar.js). */
function updateDocChrome(record) {
  const titleBtn = document.getElementById('doc-title-menu');
  if (titleBtn) {
    const span = titleBtn.querySelector('.doc-title-text');
    if (span) span.textContent = record?.title || 'Untitled draft';
  }
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

function showToast({ message, level = 'success' } = {}) {
  if (!message) return;
  const region = toastRegion();
  const toast = document.createElement('div');
  toast.className = `sk-toast sk-toast-${level}`;
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => toast.classList.add('is-leaving'), 3600);
  setTimeout(() => toast.remove(), 4000);
}

function wireToasts() {
  bus.addEventListener('toast', (e) => showToast(e.detail || {}));
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-blocking notice bar (persistence — FR-DOC.8).
// ─────────────────────────────────────────────────────────────────────────────
function showNotice(message) {
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
  dismiss.addEventListener('click', () => notice.remove());
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
      'This browser hasn’t granted persistent storage. Your drafts are saved locally, '
      + 'but the browser may evict them under storage pressure — keep important work '
      + 'exported or (in M5) synced to GitHub.'
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

/** Path to the shared token-setup guide (same PAT key as the preview tool). */
const TOKEN_SETUP_HREF = '../admin/storykit-preview-setup';

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

  const tokenSection = h('section', { class: 'sk-dialog-section' }, [
    h('h3', { class: 'sk-dialog-h', text: 'GitHub token' }),
    tokenStatus,
    h('div', { class: 'sk-field-row' }, [tokenInput, saveTokenBtn]),
    h('div', { class: 'sk-field-row' }, [forgetTokenBtn, setupLink]),
    h('p', { class: 'sk-field-note', text: 'One fine-grained personal access token with Contents read/write. Stored in this browser only, under the same key the preview tool uses — forgetting it here affects both tools.' }),
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

  const bindingSection = h('section', { class: 'sk-dialog-section' }, [
    h('h3', { class: 'sk-dialog-h', text: 'Repository binding' }),
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
  const msgInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'sk-input', id: 'sync-msg', placeholder: 'Commit message' }));
  const commitBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', id: 'sync-commit-btn', text: 'Commit' });
  const pullBtn = h('button', { type: 'button', class: 'btn btn-sm', id: 'sync-pull-btn', text: 'Pull latest' });

  commitBtn.addEventListener('click', async () => {
    const docId = appState.currentDocId;
    if (!docId) return;
    commitBtn.disabled = true;
    try {
      const saved = await sync.commitDocument(docId, { message: msgInput.value.trim() });
      if (saved) { currentDocRecord = saved; refreshSyncPanel(); }
    } catch { /* toasted */ }
    finally { commitBtn.disabled = false; }
  });
  pullBtn.addEventListener('click', async () => {
    const docId = appState.currentDocId;
    if (!docId) return;
    pullBtn.disabled = true;
    try {
      const saved = await sync.pullDocument(docId);
      if (saved) { currentDocRecord = saved; refreshSyncPanel(); }
    } catch { /* toasted */ }
    finally { pullBtn.disabled = false; }
  });

  const syncSection = h('section', { class: 'sk-dialog-section', id: 'sync-actions-section' }, [
    h('h3', { class: 'sk-dialog-h', text: 'Sync' }),
    syncState,
    h('div', { class: 'sk-field-row' }, [msgInput]),
    h('div', { class: 'sk-field-row' }, [commitBtn, pullBtn]),
  ]);

  const body = h('div', { class: 'sk-dialog-body' }, [
    h('header', { class: 'sk-dialog-head' }, [h('h2', { class: 'sk-dialog-title', text: 'GitHub sync' }), closeBtn]),
    tokenSection, bindingSection, syncSection,
  ]);
  dialog.append(body);
  document.body.appendChild(dialog);

  const SYNC_LABEL = {
    local: 'Local only', synced: 'Synced', 'local-changes': 'Local changes',
    'remote-changed': 'Remote changed', conflict: 'Conflict',
  };

  function refresh() {
    // Token status.
    const hasToken = !!github.getToken();
    tokenStatus.textContent = hasToken
      ? 'A token is saved in this browser.'
      : 'No token saved — GitHub sync needs one.';
    forgetTokenBtn.disabled = !hasToken;

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

  // Drop the load skeleton before we render anything into the mount.
  const mount = getEditorMount();
  if (mount) {
    const skeleton = mount.querySelector('.skeleton');
    if (skeleton) skeleton.remove();
  }

  wireControls();
  wireLifecycle();
  wireStatusBar();
  wireAutosave();
  wireToasts();
  wirePreview();
  wireSyncPanel();

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

  // Request durable storage (non-blocking; FR-DOC.8).
  requestPersistenceNotice();

  return { ok: true, editor: editorHandle };
}

function wireControls() {
  for (const btn of document.querySelectorAll('[data-mode-btn]')) {
    btn.addEventListener('click', () => setMode(btn.getAttribute('data-mode-btn')));
  }
  document.getElementById('sidebar-toggle')?.addEventListener('click', toggleSidebar);
  document.getElementById('theme-toggle')?.addEventListener('click', cycleTheme);

  // WP-4.3: top-bar "Link entity" affordance (FR-WD.1) — mirrors ⌘⇧K.
  document.getElementById('link-entity-btn')?.addEventListener('click', () => {
    if (editorHandle) wikidata.linkEntityCommand(editorHandle.view);
  });

  // ⌘E / Ctrl-E cycles Edit → Split → Preview (spec FR-PRE.1).
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      const order = /** @type {EditorMode[]} */ (['edit', 'split', 'preview']);
      setMode(order[(order.indexOf(appState.mode) + 1) % order.length]);
    }
  });
}

function wireLifecycle() {
  // Re-theme the editor when the OS scheme changes while in 'system' mode.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    // Page chrome re-themes via CSS automatically; rebuild CM for its colors.
    if (appState.prefs.theme === 'system') rethemeEditor();
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
