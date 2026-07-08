/**
 * editor/doclist.js — document list panel (WP-2.5)
 *
 * NOT frozen in docs/editor-plan.md §1.2 — that section marks this file
 * PROVISIONAL and leaves the final export shape to WP-2.5. This is the
 * landed contract; WP-2.6 (M2 integration) wires it into app.js as-is.
 *
 * Scope: spec FR-DOC.5 (list panel + actions), FR-DOC.6 (new-from-template),
 * FR-DOC.7 (import/export).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PUBLIC CONTRACT
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   createDocList({ mount, store, bus, onOpen })
 *     → { refresh(): Promise<void>, destroy(): void, openNewPostForm(): void }
 *
 *   mount   — HTMLElement to render into (the app wires this to
 *             `#doclist-mount`, the sidebar region editor/index.html already
 *             reserves — see that file's `<div id="doclist-mount">`).
 *             `createDocList` owns everything inside `mount`; it never
 *             touches siblings except to opportunistically wire the
 *             pre-existing `#new-doc` button in the same document (enables
 *             it and attaches a click handler that opens the inline
 *             New Post form) — WP-2.6 does not need to do this itself, but
 *             may call the returned `openNewPostForm()` directly instead
 *             (e.g. from a command-palette entry) if `#new-doc` is absent.
 *   store   — an object shaped like `editor/store.js`'s `docs` export subset:
 *             `{ list(), get(id), create({title,path,content}), update(id,patch),
 *             remove(id), duplicate(id) }`, all async. Passed as a parameter
 *             (rather than imported directly) specifically so this module is
 *             testable against a fake/in-memory store — WP-2.6 passes the
 *             real `editor/store.js` `docs` export.
 *   bus     — the app's `EventTarget` (`editor/app.js`'s `bus`). Optional —
 *             a falsy bus disables event-driven re-render but the module
 *             still works (tests may omit it).
 *   onSync  — OPTIONAL `(docId: string) => void`. When provided, each item's
 *             action cluster leads with a "Sync with GitHub" button invoking
 *             it (the host is expected to open the document, then the sync
 *             panel). Omitted → no sync button (tests, unbound hosts).
 *   onOpen  — `(docId: string) => void`, called whenever the panel wants the
 *             host app to switch to a document: clicking a list item,
 *             finishing New Post, finishing Import, or Duplicate. WP-2.6 is
 *             expected to load the doc from `store` and hand its content to
 *             `editor.js` / mark it `appState.currentDocId`. `onOpen` is
 *             fire-and-forget (no return value expected).
 *
 * Events consumed (docs/editor-plan.md §1.2 frozen bus vocabulary):
 *   `doc:saved`, `sync:status` — either triggers a full `refresh()` (autosave
 *   commits and sync-state changes both alter what the list should show:
 *   updated time, and — once WP-5.1 starts setting `doc.github` — the sync
 *   badge).
 *
 * Events emitted:
 *   `toast` — `{ message: string, level: 'success'|'error' }` on the outcome
 *   of New Post / Import / Export / Duplicate / Delete / Rename, per the
 *   frozen bus vocabulary's `toast` event (no alerts/blocking dialogs).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SYNC-STATUS HEURISTIC (v1 — see `deriveSyncStatus` below)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   doc.github == null                                        → 'local'      ("Local only")
 *   doc.github.remoteChanged === true                          → 'remote-changed'
 *   doc.updatedAt (parsed) > doc.github.syncedAt (parsed)       → 'local-changes'
 *   otherwise                                                  → 'synced'
 *
 * `remoteChanged` does not exist on any record WP-2.5 produces — it is a
 * forward-compatible hook for WP-5.1 (FR-GH.5's "remote has newer changes"
 * banner / passive check), which is expected to set it after comparing the
 * bound file's remote SHA against the stored one. Until that lands every
 * bound document is either 'synced' or 'local-changes', decided purely by
 * comparing `updatedAt` to `github.syncedAt` — the simplest available proxy
 * for "the buffer changed since the last successful push", with no separate
 * dirty flag to keep in sync. State names match the JSDoc contract already
 * written into `editor/statusbar.js`'s stub
 * (`'local'|'synced'|'local-changes'|'remote-changed'|'conflict'`); this
 * module never produces `'conflict'` (that is exclusively a live sync-session
 * state introduced by WP-5.1).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NEW POST / TEMPLATE-FILL RULES (FR-DOC.6)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The inline form (see `openNewPostForm`) collects a title only (no
 * window.prompt). On submit:
 *   - date  = today (`toDateString(new Date())`, i.e. local Y-M-D — no
 *             repo-fetched `.template.md` is used: WP-2.5 has no repo
 *             binding to fetch from (that arrives with context.js/WP-3.2),
 *             so every New Post uses the bundled `fallbackTemplate` from
 *             `editor/viewer-catalog.js`, per spec's documented unbound
 *             fallback path).
 *   - slug  = `slugify(title)` — lowercase; diacritics stripped via Unicode
 *             NFD decomposition + combining-mark removal; every run of
 *             non-`[a-z0-9]` characters collapses to a single hyphen;
 *             leading/trailing hyphens trimmed; empty result → 'untitled'.
 *   - path  = `_posts/<yyyy-mm-dd>-<slug>.md` (`buildDefaultPath`).
 *   - content = `fillTemplate(fallbackTemplate, { title, date })`: replaces
 *             the template's `title:` line and `date:` line (first match of
 *             each, multiline-anchored) with the supplied values verbatim;
 *             every other line (description, categories, media_subpath, …)
 *             passes through unchanged.
 *   - `store.docs.create({ title, path, content })` is called; on success the
 *     form closes, the list refreshes, and `onOpen(created.id)` fires.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPORT / EXPORT (FR-DOC.7)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Import: an "Import…" button opens a native file picker (`accept=".md,
 * text/markdown,text/plain"`); dropping one or more `.md` files anywhere on
 * `mount` does the same (dragover shows a `.dl-drop-target` outline on the
 * mount element itself, reusing the sidebar's own `.doclist` box rather than
 * a separate overlay). Each file's title is taken from its YAML front
 * matter's `title:` (via `extractFrontMatterTitle`, same quote-stripping
 * rules as below), falling back to the filename with `.md` stripped
 * (`titleFromFilename`). Imported docs get `path: null` (unbound — the
 * author didn't specify a repo path) and are opened immediately.
 *
 * Export: a Blob download of `doc.content` as `<basename-of-path>` if the
 * document has a `path`, else `<yyyy-mm-dd>-<slugified-title>.md` — the same
 * filename shape New Post would have generated.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DELETE (FR-DOC.5)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Two-step, no window.confirm: the per-item "Delete" button is replaced by
 * "Confirm delete" + "Cancel" (in-place, per-item — only one item's delete
 * can be mid-confirmation at a time). `store.docs.remove(id)` is only ever
 * called from the "Confirm delete" handler.
 *
 * All actions are plain `<button>`/`<input>`/`<form>` elements — no custom
 * roving-tabindex widgets — so native keyboard operability (Tab/Shift-Tab,
 * Enter/Space activation, Enter-to-submit forms) and the page-wide
 * `:focus-visible` styling in editor/styles.css apply for free.
 *
 * Component CSS lives in a single injected `<style id="sk-doclist-styles">`
 * (idempotent — checked by id before appending), styled entirely from the
 * `--sk-*` tokens defined in editor/styles.css. This file never edits
 * editor/index.html, editor/app.js, or editor/styles.css.
 */

import { fallbackTemplate } from './viewer-catalog.js';

// ═════════════════════════════════════════════════════════════════════════
// Pure helpers — independently unit-tested (tests/unit/doclist.test.js),
// no DOM access.
// ═════════════════════════════════════════════════════════════════════════

/**
 * lowercase → diacritics stripped → non-alphanumerics collapsed to single
 * hyphens → leading/trailing hyphens trimmed → 'untitled' if empty.
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  const base = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'untitled';
}

/**
 * Normalizes a Date object or a date-ish string to `yyyy-mm-dd`. Strings are
 * read literally (first `yyyy-mm-dd` found) rather than re-parsed through
 * `Date`, so front-matter dates round-trip byte-for-byte; anything else is
 * parsed via `Date` and reformatted in local time.
 * @param {Date|string} [date]
 * @returns {string}
 */
export function toDateString(date = new Date()) {
  if (date instanceof Date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(date);
  const literal = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (literal) return literal[1];
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? s : toDateString(parsed);
}

/** `yyyy-mm-dd-slug.md` per FR-DOC.6. @param {Date|string} date @param {string} title */
export function buildFilename(date, title) {
  return `${toDateString(date)}-${slugify(title)}.md`;
}

/** `_posts/yyyy-mm-dd-slug.md` — the default repo path for a new post. */
export function buildDefaultPath(date, title) {
  return `_posts/${buildFilename(date, title)}`;
}

/**
 * Extracts `title:` from a document's YAML front matter (`---\n...\n---`).
 * Handles a bare value, a double- or single-quoted value (matching quotes
 * only), and strips surrounding whitespace. Falls back to `fallback` when
 * there is no front-matter block, no `title:` key, or the value is empty
 * after unquoting.
 * @param {string} content
 * @param {string} [fallback]
 */
export function extractFrontMatterTitle(content, fallback = 'Untitled') {
  if (typeof content === 'string') {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (fm) {
      const titleLine = /^title:[ \t]*(.*)$/m.exec(fm[1]);
      if (titleLine) {
        let raw = titleLine[1].trim();
        if (raw.length >= 2) {
          const q = raw[0];
          if ((q === '"' || q === "'") && raw[raw.length - 1] === q) {
            raw = raw.slice(1, -1).trim();
          }
        }
        if (raw) return raw;
      }
    }
  }
  return fallback;
}

/** Import fallback title when a file has no usable front-matter title. */
export function titleFromFilename(filename) {
  if (!filename) return 'Untitled';
  const base = String(filename).replace(/\.[Mm][Dd]$/, '');
  return base || 'Untitled';
}

/**
 * Fills a `.template.md`-shaped string's `title:` and `date:` lines
 * (first match of each, line-anchored) with the given values. Every other
 * line passes through unchanged.
 * @param {string} template
 * @param {{ title?: string, date?: string }} [fields]
 */
export function fillTemplate(template, { title = '', date = toDateString() } = {}) {
  let out = String(template);
  out = out.replace(/^title:.*$/m, `title: ${title}`);
  out = out.replace(/^date:.*$/m, `date: ${date}`);
  return out;
}

/**
 * v1 sync-status heuristic — see the file header for the full rationale.
 * @param {{ updatedAt?: string, github?: { syncedAt?: string, remoteChanged?: boolean }|null }} doc
 * @returns {'local'|'synced'|'local-changes'|'remote-changed'}
 */
export function deriveSyncStatus(doc) {
  const gh = doc && doc.github;
  if (gh == null) return 'local';
  if (gh.remoteChanged === true) return 'remote-changed';
  // Bound but never committed (sync.js leaves syncedAt null until the first
  // successful commit): there IS local work the remote doesn't have.
  if (!gh.syncedAt) return 'local-changes';
  const updatedAt = doc && doc.updatedAt ? Date.parse(doc.updatedAt) : NaN;
  const syncedAt = Date.parse(gh.syncedAt);
  if (Number.isFinite(updatedAt) && Number.isFinite(syncedAt) && updatedAt > syncedAt) {
    return 'local-changes';
  }
  return 'synced';
}

const STATUS_LABEL = Object.freeze({
  local: 'Local only',
  synced: 'Synced',
  'local-changes': 'Local changes',
  'remote-changed': 'Remote changed',
});

function exportFilename(docRecord) {
  if (docRecord.path) {
    const base = String(docRecord.path).split('/').pop();
    if (base) return base;
  }
  const seed = docRecord.updatedAt || docRecord.createdAt;
  const date = seed ? new Date(seed) : new Date();
  return buildFilename(Number.isNaN(date.getTime()) ? new Date() : date, docRecord.title || 'untitled');
}

function formatUpdated(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'unknown';
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  if (abs < MIN) return 'just now';
  if (abs < HOUR) return `${Math.round(abs / MIN)}m ago`;
  if (abs < DAY) return `${Math.round(abs / HOUR)}h ago`;
  if (abs < DAY * 7) return `${Math.round(abs / DAY)}d ago`;
  try {
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(t);
  } catch {
    return new Date(t).toDateString();
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Component styles — injected once per document, token-driven.
// ═════════════════════════════════════════════════════════════════════════

const STYLE_ID = 'sk-doclist-styles';

const CSS_TEXT = `
.dl-root { display: flex; flex-direction: column; gap: var(--sk-space-1); }
.dl-toolbar { display: flex; justify-content: flex-end; padding: 0 var(--sk-space-xs) var(--sk-space-xs); }
.dl-file-input { display: none; }
.dl-form-host:empty { display: none; }
.dl-new-form, .dl-rename-form {
  display: flex; flex-direction: column; gap: var(--sk-space-1);
  padding: var(--sk-space-1);
  margin-bottom: var(--sk-space-1);
  background: var(--sk-surface);
  border: 1px solid var(--sk-border);
  border-radius: var(--sk-radius);
}
.dl-rename-form { flex-direction: row; align-items: center; margin: 4px 0 0; }
.dl-new-label { display: flex; flex-direction: column; gap: 4px; font-size: var(--sk-fs-xs); color: var(--sk-text-muted); }
.dl-new-input, .dl-rename-input {
  font: inherit; padding: 4px var(--sk-space-1);
  border: 1px solid var(--sk-border); border-radius: var(--sk-radius-sm);
  background: var(--sk-bg); color: var(--sk-text);
}
.dl-rename-input { flex: 1 1 auto; min-width: 0; }
.dl-new-actions { display: flex; gap: var(--sk-space-xs); justify-content: flex-end; }
.dl-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sk-space-xs); }
.dl-empty { padding: var(--sk-space-2); font-size: var(--sk-fs-sm); color: var(--sk-text-faint); text-align: center; }
.dl-empty-item, .dl-skeleton-item { list-style: none; }
.dl-skeleton-item { padding: var(--sk-space-xs) var(--sk-space-1); }
.dl-skeleton-item .skeleton-line { margin-bottom: 0; }
.dl-item { padding: var(--sk-space-xs); border-radius: var(--sk-radius); border: 1px solid transparent; }
.dl-item:hover { background: var(--sk-surface); border-color: var(--sk-border); }
.dl-item-main { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sk-space-xs); }
.dl-open {
  flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; align-items: flex-start;
  gap: 2px; padding: 2px 4px; background: transparent; border: 0; cursor: pointer;
  text-align: left; border-radius: var(--sk-radius-sm);
}
.dl-open:hover { background: var(--sk-bg-sunken); }
.dl-title { font-size: var(--sk-fs-sm); font-weight: 600; color: var(--sk-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 17ch; }
.dl-path { font-size: var(--sk-fs-xs); color: var(--sk-text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 20ch; font-family: var(--sk-font-mono); }
.dl-badge {
  flex: 0 0 auto; font-size: var(--sk-fs-xs); padding: 2px 7px; border-radius: 999px;
  background: var(--sk-bg-sunken); color: var(--sk-text-muted); border: 1px solid var(--sk-border);
  white-space: nowrap;
}
.dl-badge[data-status='synced'] { color: var(--sk-success); }
.dl-badge[data-status='local-changes'] { color: var(--sk-warning); }
.dl-badge[data-status='remote-changed'] { color: var(--sk-danger); }
.dl-item-meta { font-size: var(--sk-fs-xs); color: var(--sk-text-faint); padding: 0 4px; }
.dl-item-active {
  background: var(--sk-selection);
  border-left: 3px solid var(--sk-accent);
  border-radius: 4px;
}
.dl-item-active .dl-item-title { color: var(--sk-accent); }
.dl-repo-chip { color: var(--sk-text-muted); font-family: var(--sk-mono, ui-monospace, monospace); }
.dl-item-actions { display: flex; flex-wrap: wrap; gap: var(--sk-space-xs); padding: 4px 4px 0; }
.dl-action { font-size: var(--sk-fs-xs); padding: 2px 8px; }
.dl-sync-action { display: inline-flex; align-items: center; gap: 5px; }
.dl-sync-action:disabled { opacity: 0.45; cursor: default; }
.dl-gh-icon { flex: none; }
.dl-danger { color: var(--sk-accent-contrast); background: var(--sk-danger); border-color: var(--sk-danger); }
/* Keep the danger scheme on hover: the generic .btn:hover swaps the
   background to gray while the white text stays — unreadable. Extra
   specificity (.btn.dl-danger) so this wins regardless of sheet order. */
.btn.dl-danger:hover:not(:disabled) {
  background: var(--sk-danger);
  border-color: var(--sk-danger);
  filter: brightness(0.88);
}
.doclist.dl-drop-target { outline: 2px dashed var(--sk-accent); outline-offset: -2px; background: var(--sk-selection); }
`;

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  doc.head.appendChild(style);
}

// ═════════════════════════════════════════════════════════════════════════
// createDocList — see the file header for the full contract.
// ═════════════════════════════════════════════════════════════════════════

/**
 * @param {{ mount: HTMLElement, store: object, bus?: EventTarget, onOpen?: (id: string) => void }} opts
 * @returns {{ refresh: () => Promise<void>, destroy: () => void, openNewPostForm: () => void }}
 */
export function createDocList({ mount, store, bus, onOpen, onSync, onOpenRemote } = {}) {
  if (!mount) throw new Error('createDocList: mount is required');
  if (!store || !store.docs) throw new Error('createDocList: store (with a .docs subset) is required');

  const doc = mount.ownerDocument || document;
  ensureStyles(doc);

  let destroyed = false;
  let confirmingDeleteId = null;
  let renamingId = null;
  let currentDocs = [];
  let activeDocId = null; // the document on the editing surface (doc:opened)

  const root = doc.createElement('div');
  root.className = 'dl-root';
  mount.replaceChildren(root);

  const toolbar = doc.createElement('div');
  toolbar.className = 'dl-toolbar';
  const importBtn = doc.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'btn btn-sm dl-import-btn';
  importBtn.textContent = 'Import…';
  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.md,text/markdown,text/plain';
  fileInput.className = 'dl-file-input';
  fileInput.setAttribute('aria-label', 'Import Markdown file');
  toolbar.append(importBtn, fileInput);

  // Optional "Open…" (from GitHub): shown only when the host wires
  // onOpenRemote. Prompts for a GitHub file URL / repo path and delegates
  // parsing + fetching to the host (app.js → sync.openFromGitHub).
  if (typeof onOpenRemote === 'function') {
    const openBtn = doc.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-sm dl-open-remote-btn';
    openBtn.textContent = 'Open…';
    openBtn.title = 'Open a file that already exists on GitHub';
    openBtn.addEventListener('click', () => {
      const ref = doc.defaultView.prompt(
        'Open from GitHub — paste a file URL (github.com/…/blob/…) or a repo path like _posts/2026-01-01-post.md:');
      if (ref && ref.trim()) onOpenRemote(ref.trim());
    });
    toolbar.insertBefore(openBtn, importBtn);
  }

  const formHost = doc.createElement('div');
  formHost.className = 'dl-form-host';

  const listEl = doc.createElement('ul');
  listEl.className = 'dl-list';
  listEl.setAttribute('aria-label', 'Local documents');

  root.append(toolbar, formHost, listEl);

  // ── Boot skeleton (WP-6.2 — no layout shift while store.docs.list()'s
  //    first IndexedDB read is in flight) — replaced synchronously by
  //    renderItems() the instant refresh() resolves, below. ──────────────
  (function renderListSkeleton() {
    for (const w of ['w-60', 'w-40', 'w-70']) {
      const li = doc.createElement('li');
      li.className = 'dl-skeleton-item';
      li.setAttribute('aria-hidden', 'true');
      const line = doc.createElement('div');
      line.className = `skeleton-line ${w}`;
      li.append(line);
      listEl.append(li);
    }
  })();

  function notify(type, detail) {
    if (bus && typeof bus.dispatchEvent === 'function') {
      bus.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }

  // ── Import (file picker + drag-onto-list) — FR-DOC.7 ─────────────────
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) await importFile(file);
  });

  function hasFilesPayload(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.from(types).includes('Files');
  }
  // A link dragged from a GitHub page arrives as text/uri-list (no Files).
  // Only light up / accept when the host can actually open remote files.
  function hasLinkPayload(e) {
    if (typeof onOpenRemote !== 'function') return false;
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.from(types).includes('text/uri-list');
  }
  function onDragOver(e) {
    if (!hasFilesPayload(e) && !hasLinkPayload(e)) return;
    e.preventDefault();
    mount.classList.add('dl-drop-target');
  }
  function onDragLeave() {
    mount.classList.remove('dl-drop-target');
  }
  async function onDrop(e) {
    const isFiles = hasFilesPayload(e);
    const isLink = !isFiles && hasLinkPayload(e);
    if (!isFiles && !isLink) return;
    e.preventDefault();
    mount.classList.remove('dl-drop-target');
    if (isLink) {
      // uri-list: one URL per line, comment lines start with '#'
      const uris = String(e.dataTransfer.getData('text/uri-list') || '')
        .split(/\r?\n/).map((u) => u.trim()).filter((u) => u && !u.startsWith('#'));
      for (const uri of uris) onOpenRemote(uri);
      return;
    }
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /\.md$/i.test(f.name));
    for (const file of files) await importFile(file);
  }
  mount.addEventListener('dragover', onDragOver);
  mount.addEventListener('dragleave', onDragLeave);
  mount.addEventListener('drop', onDrop);

  async function importFile(file) {
    try {
      const content = await file.text();
      const title = extractFrontMatterTitle(content, titleFromFilename(file.name));
      const created = await store.docs.create({ title, path: null, content });
      notify('toast', { message: `Imported "${file.name}"`, level: 'success' });
      await refresh();
      if (created && created.id) onOpen?.(created.id);
    } catch (err) {
      notify('toast', { message: `Couldn't import "${file.name}": ${err?.message || err}`, level: 'error' });
    }
  }

  // ── New Post (FR-DOC.6) — wire the scaffold's #new-doc button if present ──
  const newDocBtn = doc.getElementById && doc.getElementById('new-doc');
  if (newDocBtn) {
    newDocBtn.disabled = false;
    newDocBtn.removeAttribute('aria-disabled');
    newDocBtn.addEventListener('click', openNewPostForm);
  }

  function openNewPostForm() {
    renamingId = null;
    confirmingDeleteId = null;
    formHost.replaceChildren();

    const form = doc.createElement('form');
    form.className = 'dl-new-form';

    const label = doc.createElement('label');
    label.className = 'dl-new-label';
    label.append('Title');
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'dl-new-input';
    input.placeholder = 'Untitled draft';
    input.setAttribute('aria-label', 'New post title');
    label.append(input);

    const actions = doc.createElement('div');
    actions.className = 'dl-new-actions';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => formHost.replaceChildren());
    const createBtn = doc.createElement('button');
    createBtn.type = 'submit';
    createBtn.className = 'btn btn-primary btn-sm';
    createBtn.textContent = 'Create';
    actions.append(cancelBtn, createBtn);

    form.append(label, actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await createNewPost(input.value);
    });

    formHost.append(form);
    input.focus();
  }

  async function createNewPost(rawTitle) {
    const title = (rawTitle || '').trim() || 'Untitled draft';
    const date = new Date();
    const path = buildDefaultPath(date, title);
    const content = fillTemplate(fallbackTemplate, { title, date: toDateString(date) });
    try {
      const created = await store.docs.create({ title, path, content });
      formHost.replaceChildren();
      notify('toast', { message: `Created ${path.split('/').pop()}`, level: 'success' });
      await refresh();
      if (created && created.id) onOpen?.(created.id);
    } catch (err) {
      notify('toast', { message: `Couldn't create post: ${err?.message || err}`, level: 'error' });
    }
  }

  // ── List rendering (FR-DOC.5) ─────────────────────────────────────────
  async function refresh() {
    let list;
    try {
      list = await store.docs.list();
    } catch (err) {
      listEl.replaceChildren();
      const li = doc.createElement('li');
      li.className = 'dl-empty';
      li.textContent = `Couldn't load documents: ${err?.message || err}`;
      listEl.append(li);
      currentDocs = [];
      return;
    }
    currentDocs = [...(list || [])].sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt));
    renderItems();
  }

  function parseTime(v) {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : 0;
  }

  /** Empty-state guidance (WP-6.2 · spec §5.4 "empty states with guidance"):
   *  an icon, a plain-language title, a one-line hint, and a CTA that opens
   *  the same inline form the sidebar's own "+ New" button does. */
  function renderEmptyState() {
    const li = doc.createElement('li');
    // `dl-empty` is the pre-existing, test-covered marker class (also used
    // by the "couldn't load documents" error branch above); `dl-empty-item`
    // is new (WP-6.2) — just a hook for the item-level CSS.
    li.className = 'dl-empty dl-empty-item';
    const wrap = doc.createElement('div');
    wrap.className = 'empty-state dl-empty-state';

    const icon = doc.createElement('span');
    icon.className = 'empty-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" '
      + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M7 3h7l4 4v14a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/>'
      + '<path d="M14 3v4h4"/><path d="M9 13h6M9 17h6"/></svg>';

    const title = doc.createElement('p');
    title.className = 'empty-title';
    title.textContent = 'No documents yet';
    const hint = doc.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = 'Everything is saved locally in your browser — nothing to lose.';
    const cta = doc.createElement('button');
    cta.type = 'button';
    cta.className = 'btn btn-primary btn-sm';
    cta.textContent = 'Create your first post';
    cta.addEventListener('click', openNewPostForm);

    wrap.append(icon, title, hint, cta);
    li.append(wrap);
    return li;
  }

  function renderItems() {
    listEl.replaceChildren();
    if (!currentDocs.length) {
      listEl.append(renderEmptyState());
      return;
    }
    for (const docRecord of currentDocs) {
      listEl.append(renderItem(docRecord));
    }
  }

  function makeActionBtn(label, handler) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm dl-action';
    btn.textContent = label;
    btn.addEventListener('click', handler);
    return btn;
  }

  /** The GitHub mark as an inline SVG (decorative — the label carries the
   *  meaning). currentColor so it follows the button's text/disabled color. */
  function githubIcon() {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('dl-gh-icon');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z');
    svg.append(path);
    return svg;
  }

  function renderItem(docRecord) {
    const li = doc.createElement('li');
    li.className = 'dl-item';
    if (docRecord.id === activeDocId) li.classList.add('dl-item-active');
    li.dataset.docId = docRecord.id;

    const main = doc.createElement('div');
    main.className = 'dl-item-main';

    const openBtn = doc.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'dl-open';
    openBtn.setAttribute('aria-label', `Open ${docRecord.title || 'Untitled'}`);
    const titleEl = doc.createElement('span');
    titleEl.className = 'dl-title';
    titleEl.textContent = docRecord.title || 'Untitled';
    const pathEl = doc.createElement('span');
    pathEl.className = 'dl-path';
    pathEl.textContent = docRecord.path || 'unsaved';
    openBtn.append(titleEl, pathEl);
    openBtn.addEventListener('click', () => onOpen?.(docRecord.id));

    const status = deriveSyncStatus(docRecord);
    const badge = doc.createElement('span');
    badge.className = 'dl-badge';
    badge.dataset.status = status;
    badge.textContent = STATUS_LABEL[status] || status;

    main.append(openBtn, badge);

    const meta = doc.createElement('div');
    meta.className = 'dl-item-meta';
    meta.textContent = `Updated ${formatUpdated(docRecord.updatedAt)}`;
    // One list can span repos (central editor) — bound rows say which.
    if (docRecord.github && docRecord.github.owner) {
      const repoChip = doc.createElement('span');
      repoChip.className = 'dl-repo-chip';
      const gh = docRecord.github;
      repoChip.textContent = `${gh.owner}/${gh.repo}`;
      if (gh.branch && gh.branch !== 'main') repoChip.textContent += `@${gh.branch}`;
      meta.append(' · ', repoChip);
    }

    const actions = doc.createElement('div');
    actions.className = 'dl-item-actions';
    // "Sync with GitHub" leads the cluster when the host wires onSync — the
    // primary discoverable entry point to the sync panel (the status-bar
    // badge remains a secondary one). Disabled while local and remote are
    // already in sync: there is nothing to push or pull. ('local' — unbound —
    // stays enabled: the button is how a document gets bound in the first
    // place.)
    if (onSync) {
      const syncBtn = makeActionBtn('Sync with GitHub', () => onSync(docRecord.id));
      syncBtn.classList.add('dl-sync-action');
      syncBtn.prepend(githubIcon());
      if (status === 'synced') {
        syncBtn.disabled = true;
        syncBtn.title = 'Local and GitHub copies are in sync';
      }
      actions.append(syncBtn);
    }
    actions.append(
      makeActionBtn('Rename path', () => {
        renamingId = renamingId === docRecord.id ? null : docRecord.id;
        confirmingDeleteId = null;
        renderItems();
      }),
      makeActionBtn('Duplicate', () => duplicateDoc(docRecord)),
      makeActionBtn('Export', () => exportDoc(docRecord)),
      renderDeleteControl(docRecord)
    );

    li.append(main, meta, actions);
    if (renamingId === docRecord.id) li.append(renderRenameForm(docRecord));

    return li;
  }

  function renderDeleteControl(docRecord) {
    const wrap = doc.createElement('span');
    wrap.className = 'dl-delete-wrap';
    if (confirmingDeleteId === docRecord.id) {
      const confirmBtn = doc.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'btn btn-sm dl-action dl-danger';
      confirmBtn.textContent = 'Confirm delete';
      confirmBtn.addEventListener('click', () => deleteDoc(docRecord));
      const cancelBtn = doc.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-sm dl-action';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        confirmingDeleteId = null;
        renderItems();
      });
      wrap.append(confirmBtn, cancelBtn);
    } else {
      wrap.append(
        makeActionBtn('Delete', () => {
          confirmingDeleteId = docRecord.id;
          renamingId = null;
          renderItems();
        })
      );
    }
    return wrap;
  }

  async function deleteDoc(docRecord) {
    try {
      await store.docs.remove(docRecord.id);
      confirmingDeleteId = null;
      // Tell the host which document is gone — if it's the open one, the
      // editor/preview panes must clear rather than keep showing a ghost.
      notify('doc:deleted', { docId: docRecord.id });
      notify('toast', { message: `Deleted "${docRecord.title || 'document'}"`, level: 'success' });
      await refresh();
    } catch (err) {
      notify('toast', { message: `Couldn't delete: ${err?.message || err}`, level: 'error' });
    }
  }

  async function duplicateDoc(docRecord) {
    try {
      const copy = await store.docs.duplicate(docRecord.id);
      notify('toast', { message: `Duplicated "${docRecord.title || 'document'}"`, level: 'success' });
      await refresh();
      if (copy && copy.id) onOpen?.(copy.id);
    } catch (err) {
      notify('toast', { message: `Couldn't duplicate: ${err?.message || err}`, level: 'error' });
    }
  }

  function exportDoc(docRecord) {
    try {
      const filename = exportFilename(docRecord);
      const blob = new Blob([docRecord.content || ''], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = filename;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      notify('toast', { message: `Exported ${filename}`, level: 'success' });
    } catch (err) {
      notify('toast', { message: `Export failed: ${err?.message || err}`, level: 'error' });
    }
  }

  function renderRenameForm(docRecord) {
    const form = doc.createElement('form');
    form.className = 'dl-rename-form';
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'dl-rename-input';
    input.value = docRecord.path || '';
    input.setAttribute('aria-label', `Path for ${docRecord.title || 'document'}`);
    const saveBtn = doc.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = 'Save';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      renamingId = null;
      renderItems();
    });
    form.append(input, saveBtn, cancelBtn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await store.docs.update(docRecord.id, { path: input.value.trim() || null });
        renamingId = null;
        notify('toast', { message: 'Path updated', level: 'success' });
        await refresh();
      } catch (err) {
        notify('toast', { message: `Couldn't rename: ${err?.message || err}`, level: 'error' });
      }
    });
    return form;
  }

  // ── Bus-driven re-render ──────────────────────────────────────────────
  function onBusEvent() {
    refresh();
  }
  // The host announces which document is on the editing surface
  // (`doc:opened`, detail.docId — null when the surface is cleared); the
  // matching row gets `.dl-item-active`. Updated in place, no refetch.
  function onDocOpened(e) {
    activeDocId = (e.detail && e.detail.docId) || null;
    for (const li of mount.querySelectorAll('.dl-item')) {
      li.classList.toggle('dl-item-active', li.dataset.docId === activeDocId);
    }
  }
  if (bus && typeof bus.addEventListener === 'function') {
    bus.addEventListener('doc:saved', onBusEvent);
    bus.addEventListener('sync:status', onBusEvent);
    bus.addEventListener('doc:opened', onDocOpened);
  }

  refresh();

  return {
    refresh,
    openNewPostForm,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (bus && typeof bus.removeEventListener === 'function') {
        bus.removeEventListener('doc:saved', onBusEvent);
        bus.removeEventListener('sync:status', onBusEvent);
      }
      mount.removeEventListener('dragover', onDragOver);
      mount.removeEventListener('dragleave', onDragLeave);
      mount.removeEventListener('drop', onDrop);
      if (newDocBtn) newDocBtn.removeEventListener('click', openNewPostForm);
      mount.replaceChildren();
    },
  };
}
