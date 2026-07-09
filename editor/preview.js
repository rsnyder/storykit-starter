/**
 * editor/preview.js — preview pane (WP-3.3)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2 —
 *   createPreviewPane({ mount }) → { render({content,path,binding}), destroy() }
 * (scroll is restored across srcdoc replacement by nearest-heading anchor).
 * Per the WP-3.3 brief (docs/editor-plan.md §3), the returned object ALSO
 * exposes `schedule({content,path,binding})` — a ~1s-debounced `render()` for
 * split-mode live updates. This is an additive, backward-compatible
 * extension of the frozen shape (`render`/`destroy` behave exactly as
 * specified); WP-3.4 wires `doc:changed` → `schedule()` in split mode and
 * calls `render()` directly on entry to full Preview mode.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIBRARY LOADING (spec FR-PRE.2, docs/editor-plan.md §1.1 as-built notes)
 * ─────────────────────────────────────────────────────────────────────────
 * assets/js/skrender.js's top-level module code calls `window.markdownit(…)`
 * *at import evaluation time* (it builds the shared markdown-it instance as
 * a module-scope constant). That means the classic-script globals
 * (window.liquidjs / window.markdownit(+footnote/sub/sup) / window.jsyaml)
 * MUST already be on `window` *before* skrender.js is ever imported — a
 * static top-level `import … from '../assets/js/skrender.js'` here would
 * evaluate too early (before this module has had a chance to inject the
 * classic `<script>` tags) and throw. So library loading is two steps,
 * both deferred to first render():
 *   1. inject the five classic <script> tags (exact pinned CDN URLs below,
 *      copied verbatim from preview/index.html's <head>) and wait for them
 *      to set their globals;
 *   2. THEN dynamically `import('../assets/js/skrender.js')` — only at that
 *      point does the module's top-level `window.markdownit(...)` call see
 *      a real implementation.
 * Both steps are memoized behind a single-flight promise per pane instance
 * (`ensureRenderPost`), so rapid/duplicate renders never re-inject scripts
 * or re-import the module. A load failure clears the memo so a later
 * render() can retry (e.g. after the author's network recovers).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TEST SEAMS (documented per the WP-3.3 brief — "mock renderPost/buildContext
 * via injectable params or module-level test seams")
 * ─────────────────────────────────────────────────────────────────────────
 * `createPreviewPane` accepts three optional params beyond the frozen
 * `mount`:
 *   - `buildContext` — defaults to the real `./context.js#buildContext`
 *     (statically imported; safe — unlike skrender.js, context.js does no
 *     window-global work at import time).
 *   - `renderPost`   — defaults to undefined, meaning "load skrender.js for
 *     real on first render()". Tests inject a fake `async ({content,path,
 *     context}) => ({html, diagnostics})` here to exercise the pane's own
 *     logic (token staleness, scroll capture/restore, diagnostics panel,
 *     debounce, error-document fallback) WITHOUT touching the network or
 *     real Liquid/Markdown rendering (explicitly out of scope for unit
 *     tests per the brief — that's WP-3.4's e2e job).
 *   - `loadLibraries` — defaults to the real classic-script injector +
 *     dynamic import; tests never need to override this directly since
 *     supplying `renderPost` short-circuits it entirely (see
 *     `ensureRenderPost` below).
 * The pure/testable pieces are also exported standalone, independent of any
 * mount/iframe: `nearestAnchor`, `resolveScrollRestore`, `createRenderToken`,
 * `debounce`, `renderDiagnosticsPanel`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCROLL RESTORE (spec FR-PRE.3)
 * ─────────────────────────────────────────────────────────────────────────
 * Because a full re-render replaces the iframe's `srcdoc` (there is no way
 * to patch a srcdoc document in place), naive replacement resets scroll to
 * the top on every keystroke-triggered re-render in split mode. Before
 * writing the new `srcdoc`, `captureAnchor()` reads the CURRENT iframe
 * document's headings (`h1..h6[id]`, which Chirpy's markdown pipeline always
 * assigns) and the current scroll position, and picks the nearest heading
 * at-or-above that scroll position via the pure `nearestAnchor()` helper.
 * Same-origin access to `iframe.contentDocument`/`contentWindow` works
 * because the sandbox includes `allow-same-origin` (srcdoc iframes with that
 * flag are same-origin with the embedder). After the new document's `load`
 * event fires, `restoreAnchor()` looks the same id up in the NEW document's
 * headings via `resolveScrollRestore()` and scrolls to it if found, else
 * falls back to the top (0) — e.g. when an edit removed/renamed the heading
 * that was previously in view.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DIAGNOSTICS PANEL (spec FR-PRE.5)
 * ─────────────────────────────────────────────────────────────────────────
 * A collapsible strip above the iframe. Diagnostics come from THREE
 * sources, concatenated in order: (1) `context.diagnostics` if buildContext
 * exposes any (e.g. offline/stale-cache warnings — WP-3.2 contract delta),
 * (2) `renderPost()`'s own `diagnostics` array, (3) on a thrown error from
 * either step, a single synthesized `{level:'error', stage:'render', message}`
 * entry. The panel starts collapsed when every diagnostic is `info`-level
 * (the common case: a clean render's final layout-chain summary) and starts
 * expanded when any `error`/`warn` is present, so an author's attention is
 * only ever demanded when something needs it. Entries carrying a numeric
 * `line` render as a clickable button; clicking dispatches `preview:goto-line`
 * `{line}` on the shared app bus (docs/editor-plan.md §1.2 `bus`) — WP-3.4's
 * job is to listen for that event and move the CM6 cursor/selection to that
 * line. This event name is a documented, non-frozen addition to the bus
 * vocabulary (the same pattern WP-2.3 used for `editor:wordcount`/
 * `editor:cursor`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NEVER A BLANK IFRAME (spec FR-PRE.5)
 * ─────────────────────────────────────────────────────────────────────────
 * Any thrown error (context build failure, skrender import/library-load
 * failure, renderPost throwing) writes a self-contained, styled, readable
 * inline error document into the iframe via `errorDocument()` instead of
 * leaving the previous (possibly stale) or blank content in place, while the
 * diagnostics panel surfaces the same message.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONCURRENCY (spec FR-PRE.3, "rapid re-renders must never interleave")
 * ─────────────────────────────────────────────────────────────────────────
 * `render()` draws a fresh token from `createRenderToken()` on entry.
 * Every `await` boundary re-checks `tokenTracker.isCurrent(token)`; a stale
 * completion (an older render() call whose async work finishes after a
 * newer one already started) is silently discarded — it never touches the
 * iframe or diagnostics panel. This makes `schedule()`'s debounced calls
 * and any direct `render()` calls from WP-3.4 safe to fire concurrently.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STYLES
 * ─────────────────────────────────────────────────────────────────────────
 * A single idempotent `<style id="sk-preview-styles">` is appended to the
 * mount's owner document (same pattern as editor/doclist.js's
 * `sk-doclist-styles` — the codebase's established convention for
 * "constructable/injected stylesheet" in this buildless setup), styled
 * entirely from the `--sk-*` tokens in editor/styles.css. This file never
 * edits editor/index.html, editor/app.js, or editor/styles.css.
 */

import { bus } from './app.js';
import { buildContext as defaultBuildContext } from './context.js';

// ═════════════════════════════════════════════════════════════════════════
// Pinned classic-script CDN URLs — copied VERBATIM from preview/index.html's
// <head> (do not drift; these are the same globals skrender.js consumes).
// ═════════════════════════════════════════════════════════════════════════
const LIB_SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/liquidjs@10.27.1/dist/liquid.browser.min.js',
  'https://cdn.jsdelivr.net/npm/markdown-it@14.3.0/dist/markdown-it.min.js',
  'https://cdn.jsdelivr.net/npm/markdown-it-footnote@3.0.3/dist/markdown-it-footnote.min.js',
  'https://cdn.jsdelivr.net/npm/markdown-it-sub@1.0.0/dist/markdown-it-sub.min.js',
  'https://cdn.jsdelivr.net/npm/markdown-it-sup@1.0.0/dist/markdown-it-sup.min.js',
  'https://cdn.jsdelivr.net/npm/js-yaml@4.3.0/dist/js-yaml.min.js',
];

// skrender's location relative to THIS page differs by deployment layout:
// per-site (page at <site>/editor/, skrender at <site>/assets/js/) vs the
// central editor (page at the repo's Pages root, skrender under ./assets/).
// Candidates are tried in order; a 404 on the first import is not module-
// poisoning (only a THROWING evaluation is cached — a failed fetch retries
// cleanly on a different specifier).
const SKRENDER_MODULE_CANDIDATES = [
  '../assets/js/skrender.js',
  './assets/js/skrender.js',
];

// Sandbox attrs copied verbatim from preview/index.html's #__preview-frame.
const SANDBOX_ATTRS = 'allow-scripts allow-same-origin allow-popups allow-forms allow-modals';

const DEFAULT_DEBOUNCE_MS = 1000;

const HEADING_SELECTOR = 'h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]';

// ═════════════════════════════════════════════════════════════════════════
// Pure helpers — independently unit-tested (tests/unit/preview.test.js),
// no DOM/iframe access.
// ═════════════════════════════════════════════════════════════════════════

/**
 * Given a list of heading anchors sorted ascending by `top`, return the id
 * of the nearest heading at-or-above `scrollY` — i.e. the heading currently
 * "in view" at the top of the viewport. Returns null when `scrollY` is
 * above every heading (e.g. still in the lead-in before the first one) or
 * when there are no headings at all.
 * @param {{id:string, top:number}[]} headings — MUST be sorted ascending by top
 * @param {number} scrollY
 * @returns {string|null}
 */
export function nearestAnchor(headings, scrollY) {
  if (!Array.isArray(headings) || headings.length === 0) return null;
  let candidate = null;
  for (const h of headings) {
    if (h.top <= scrollY) candidate = h;
    else break; // ascending order — no further candidate can qualify
  }
  return candidate ? candidate.id : null;
}

/**
 * Resolve the scroll-restore target after a srcdoc replacement: the `top`
 * of the heading matching `anchorId` in the NEW document's heading list, or
 * 0 (top of document) when there is no anchor to restore, or the anchor no
 * longer exists in the re-rendered document.
 * @param {string|null} anchorId
 * @param {{id:string, top:number}[]} headings — the new document's headings
 * @returns {number}
 */
export function resolveScrollRestore(anchorId, headings) {
  if (!anchorId || !Array.isArray(headings)) return 0;
  const match = headings.find((h) => h.id === anchorId);
  return match ? match.top : 0;
}

/**
 * A monotonically-increasing token source for discarding stale async
 * render completions. `next()` draws a new current token; `isCurrent(token)`
 * tells a caller, after an `await`, whether its token is still the latest
 * one drawn (i.e. no newer render() has started since).
 * @returns {{ next: () => number, isCurrent: (token:number) => boolean }}
 */
export function createRenderToken() {
  let latest = 0;
  return {
    next() {
      latest += 1;
      return latest;
    },
    isCurrent(token) {
      return token === latest;
    },
  };
}

/**
 * Trailing-edge debounce. Repeated calls within `delay` ms coalesce into a
 * single invocation of `fn` using the LAST call's arguments. The returned
 * function also exposes `.cancel()` (drop any pending invocation).
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function & { cancel: () => void }}
 */
export function debounce(fn, delay) {
  let timer = null;
  function scheduled(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  }
  scheduled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return scheduled;
}

function summarizeDiagnostics(diagnostics) {
  const errors = diagnostics.filter((d) => d.level === 'error').length;
  const warns = diagnostics.filter((d) => d.level === 'warn').length;
  const infos = diagnostics.filter((d) => d.level === 'info');
  return { errors, warns, infos };
}

function summaryLabel(diagnostics) {
  const { errors, warns, infos } = summarizeDiagnostics(diagnostics);
  if (errors) {
    return `${errors} error${errors === 1 ? '' : 's'}` + (warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '');
  }
  if (warns) return `${warns} warning${warns === 1 ? '' : 's'}`;
  // Happy path: just "Preview OK". Info notes (e.g. the renderer's layout
  // chain) live in the expandable list — repeating them here made the
  // collapsed toggle read as duplicated jargon (user-reported confusion).
  if (infos.length) return 'Preview OK';
  return diagnostics.length ? `${diagnostics.length} note${diagnostics.length === 1 ? '' : 's'}` : 'No diagnostics';
}

/**
 * Build the diagnostics-panel DOM from a diagnostics array. Pure w.r.t. the
 * rest of the pane — no mount/iframe required, so this is directly
 * unit-testable with a canned array. Entries with a numeric `line` render
 * as a clickable "Line N" button that invokes `onGotoLine(line)`. The panel
 * starts collapsed (`data-collapsed="true"`) when every diagnostic is
 * info-level (or there are none), and starts expanded when any error/warn
 * is present.
 * @param {{level:'error'|'warn'|'info', stage:string, message:string, line?:number}[]} diagnostics
 * @param {{ onGotoLine?: (line:number) => void, doc?: Document }} [opts]
 * @returns {HTMLElement}
 */
export function renderDiagnosticsPanel(diagnostics, { onGotoLine, doc = document } = {}) {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  const { errors, warns } = summarizeDiagnostics(list);
  const hasIssue = errors > 0 || warns > 0;

  const root = doc.createElement('div');
  root.className = 'pv-diagnostics';
  if (list.length === 0) root.classList.add('pv-diagnostics-empty');
  root.dataset.collapsed = hasIssue ? 'false' : 'true';

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pv-diagnostics-toggle';
  toggle.textContent = summaryLabel(list);
  toggle.setAttribute('aria-expanded', String(hasIssue));
  toggle.addEventListener('click', () => {
    const collapsed = root.dataset.collapsed !== 'false';
    root.dataset.collapsed = collapsed ? 'false' : 'true';
    toggle.setAttribute('aria-expanded', String(collapsed));
  });

  const ul = doc.createElement('ul');
  ul.className = 'pv-diagnostics-list';
  for (const d of list) {
    const li = doc.createElement('li');
    li.className = `pv-diag pv-diag-${d.level || 'info'}`;
    li.dataset.stage = d.stage || '';

    if (Number.isFinite(d.line)) {
      const gotoBtn = doc.createElement('button');
      gotoBtn.type = 'button';
      gotoBtn.className = 'pv-diag-goto';
      gotoBtn.textContent = `Line ${d.line}`;
      gotoBtn.addEventListener('click', () => onGotoLine?.(d.line));
      li.append(gotoBtn);
    }

    const msg = doc.createElement('span');
    msg.className = 'pv-diag-msg';
    // The renderer's layout-chain info note ("post → default → compress") is
    // opaque out of context — label it for authors browsing the list.
    msg.textContent = (d.stage === 'layout' && (d.level || 'info') === 'info')
      ? `Layout chain: ${d.message || ''}`
      : (d.message || '');
    li.append(msg);

    ul.append(li);
  }

  root.append(toggle, ul);
  return root;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * A self-contained, styled, readable error document — written into the
 * iframe on any render failure so the iframe is never blank (FR-PRE.5).
 * @param {string} message
 * @returns {string}
 */
function errorDocument(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview error</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 2rem; background: #fff5f5; color: #7a1f1a; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #ffffff; border: 1px solid #f3c6c2; border-radius: 8px; padding: 14px; color: #1f2328; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  @media (prefers-color-scheme: dark) {
    body { background: #2a1414; color: #f5b8b0; }
    pre { background: #1b1f24; border-color: #5a2a24; color: #e6edf3; }
  }
</style></head>
<body>
  <h1>Preview failed to render</h1>
  <pre>${escapeHtml(message)}</pre>
</body></html>`;
}

// ═════════════════════════════════════════════════════════════════════════
// Component styles — injected once per document, token-driven (same
// idempotent-<style> convention as editor/doclist.js).
// ═════════════════════════════════════════════════════════════════════════

const STYLE_ID = 'sk-preview-styles';

const CSS_TEXT = `
.pv-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.pv-diagnostics { flex: 0 0 auto; border-bottom: 1px solid var(--sk-border); background: var(--sk-surface); font-size: var(--sk-fs-xs); }
.pv-diagnostics.pv-diagnostics-empty { display: none; }
.pv-diagnostics[data-collapsed='true'] .pv-diagnostics-list { display: none; }
.pv-diagnostics-toggle {
  /* Reads as a BUTTON, not stray text (review item #7): chip outline + hover. */
  display: inline-block; margin: 4px var(--sk-space-2); padding: 2px 10px;
  text-align: left; font: inherit; font-size: var(--sk-fs-xs);
  color: var(--sk-text-muted); background: var(--sk-surface);
  border: 1px solid var(--sk-border); border-radius: 10px; cursor: pointer;
}
/* Chevron affordance: the summary line is a collapse/expand toggle. */
.pv-diagnostics[data-collapsed='true'] .pv-diagnostics-toggle::before { content: '\\25B8'; margin-right: 6px; opacity: .7; }
.pv-diagnostics[data-collapsed='false'] .pv-diagnostics-toggle::before { content: '\\25BE'; margin-right: 6px; opacity: .7; }
.pv-diagnostics-toggle:hover { background: var(--sk-bg-sunken); }
.pv-diagnostics-list { list-style: none; margin: 0; padding: 0 var(--sk-space-2) var(--sk-space-1); max-height: 160px; overflow-y: auto; }
.pv-diag { display: flex; gap: var(--sk-space-xs); align-items: baseline; padding: 2px 0; }
.pv-diag-error { color: var(--sk-danger); }
.pv-diag-warn { color: var(--sk-warning); }
.pv-diag-info { color: var(--sk-text-faint); }
.pv-diag-goto {
  flex: 0 0 auto; font: inherit; font-size: var(--sk-fs-xs); padding: 0 6px;
  border: 1px solid var(--sk-border); border-radius: var(--sk-radius-sm);
  background: var(--sk-bg-sunken); color: inherit; cursor: pointer;
}
.pv-diag-goto:hover { background: var(--sk-bg); border-color: var(--sk-border-strong); }
.pv-diag-msg { flex: 1 1 auto; min-width: 0; }
.pv-frame-wrap { flex: 1 1 auto; min-height: 0; position: relative; }
.pv-frame { width: 100%; height: 100%; border: 0; display: block; background: var(--sk-bg); }
.pv-overlay {
  position: absolute; inset: 0; z-index: 2;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--sk-space-2); padding: var(--sk-space-3);
  background: var(--sk-bg);
}
/* [hidden] alone loses to the .pv-overlay class rule above (author CSS wins
   ties over the UA stylesheet's own [hidden] rule) — without this, setting
   the hidden property/attribute would silently do nothing. */
.pv-overlay[hidden] { display: none; }
.pv-overlay-skeleton { width: min(320px, 80%); }
.pv-overlay-skeleton .skeleton-line:last-child { margin-bottom: 0; }
.pv-overlay-text { margin: 0; font-size: var(--sk-fs-sm); color: var(--sk-text-faint); }
`;

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  doc.head.appendChild(style);
}

// ═════════════════════════════════════════════════════════════════════════
// Library loading — classic <script> injection + deferred skrender.js
// import (see the file header for why the ordering matters).
// ═════════════════════════════════════════════════════════════════════════

function injectScript(doc, src) {
  return new Promise((resolve, reject) => {
    const existing = [...doc.head.querySelectorAll('script[src]')].find((s) => s.src === src);
    if (existing) {
      if (existing.dataset.skLoaded === 'true') { resolve(); return; }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load preview library: ${src}`)), { once: true });
      return;
    }
    const s = doc.createElement('script');
    s.src = src;
    s.addEventListener('load', () => { s.dataset.skLoaded = 'true'; resolve(); }, { once: true });
    s.addEventListener('error', () => reject(new Error(`Failed to load preview library: ${src}`)), { once: true });
    doc.head.appendChild(s);
  });
}

/**
 * Inject the pinned classic-script libraries (single-flight per call site —
 * the caller is expected to memoize this), then dynamically import
 * skrender.js only once the globals it needs at import time are present.
 * @param {Document} doc
 * @returns {Promise<{ renderPost: Function, createResolveFileCache: Function }>}
 */
async function defaultLoadLibraries(doc) {
  await Promise.all(LIB_SCRIPTS.map((src) => injectScript(doc, src)));
  const win = doc.defaultView || window;
  if (!win.liquidjs || !win.markdownit || !win.jsyaml) {
    throw new Error('Preview libraries loaded but expected globals are missing (liquidjs/markdownit/jsyaml)');
  }
  let lastErr = null;
  for (const candidate of SKRENDER_MODULE_CANDIDATES) {
    try {
      return await import(candidate);
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('skrender.js not found at any known location');
}

// ═════════════════════════════════════════════════════════════════════════
// createPreviewPane — see the file header for the full contract.
// ═════════════════════════════════════════════════════════════════════════

/**
 * @param {{
 *   mount: HTMLElement,
 *   buildContext?: (args: { binding: object|null }) => Promise<object>,
 *   renderPost?: (args: { content: string, path: string, context: object }) => Promise<{ html: string, diagnostics: object[] }>,
 *   loadLibraries?: (doc: Document) => Promise<{ renderPost: Function }>,
 *   debounceMs?: number,
 * }} opts
 * @returns {{
 *   render: (args: { content: string, path: string, binding: object|null }) => Promise<void>,
 *   schedule: (args: { content: string, path: string, binding: object|null }) => void,
 *   destroy: () => void,
 * }}
 */
export function createPreviewPane({
  mount,
  buildContext: buildContextFn,
  renderPost: renderPostFn,
  loadLibraries: loadLibrariesFn,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  // Additive: called after each successful srcdoc load (scroll restore done).
  // The host uses it to (re)attach scroll-sync listeners and rebuild the
  // anchor map — the iframe document is REPLACED on every render.
  onRendered,
} = {}) {
  if (!mount) throw new Error('createPreviewPane: mount is required');

  const doc = mount.ownerDocument || document;
  ensureStyles(doc);

  let destroyed = false;
  const tokenTracker = createRenderToken();
  let libsPromise = null;

  function gotoLine(line) {
    bus.dispatchEvent(new CustomEvent('preview:goto-line', { detail: { line } }));
  }

  // ── DOM scaffold ─────────────────────────────────────────────────────
  const root = doc.createElement('div');
  root.className = 'pv-root';

  let diagPanel = renderDiagnosticsPanel([], { onGotoLine: gotoLine, doc });

  const frameWrap = doc.createElement('div');
  frameWrap.className = 'pv-frame-wrap';
  const iframe = doc.createElement('iframe');
  iframe.className = 'pv-frame';
  iframe.setAttribute('sandbox', SANDBOX_ATTRS);
  // Permissions-Policy delegation must pass EVERY frame hop: the viewer
  // components' copy-coordinates / copy-tag features use the async Clipboard
  // API from iframes nested inside this one (component → expand dialog).
  // Without this, clipboard writes fail everywhere inside the preview even
  // though the inner iframes carry their own allow attributes.
  iframe.setAttribute('allow', 'clipboard-write; fullscreen');
  iframe.setAttribute('title', 'Post preview');

  // ── "Quiet" overlay (WP-6.2 §5.4 no-CLS/empty-states) ───────────────────
  // Covers the iframe from construction until the FIRST writeFrame() ever
  // happens, instead of leaving a blank white iframe while (a) no render()
  // has been requested yet (no document open — app.js's showEmpty() sets
  // the copy for that case) or (b) the very first render() is awaiting the
  // library-load network round trip (see the file header — classic <script>
  // injection + the skrender.js import can visibly take a moment on a real
  // network). Never shown again after the first successful writeFrame() —
  // subsequent doc switches/edits keep the previous render on screen while
  // the next one resolves, exactly like before this overlay existed.
  const overlay = doc.createElement('div');
  overlay.className = 'pv-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const overlaySkeleton = doc.createElement('div');
  overlaySkeleton.className = 'pv-overlay-skeleton';
  overlaySkeleton.innerHTML = '<div class="skeleton-line w-40"></div><div class="skeleton-line w-70"></div><div class="skeleton-line w-50"></div>';
  const overlayText = doc.createElement('p');
  overlayText.className = 'pv-overlay-text';
  overlayText.textContent = 'Preparing preview…';
  overlay.append(overlaySkeleton, overlayText);

  frameWrap.append(iframe, overlay);

  root.append(diagPanel, frameWrap);
  mount.replaceChildren(root);

  let everRendered = false;

  /** Additive, non-frozen extension (same pattern as `schedule`): swaps the
   * overlay's copy for an app-supplied message (e.g. "no document open")
   * without touching the frozen render()/schedule()/destroy() contract.
   * A no-op once a real render has landed — the overlay is gone for good
   * at that point, by design (see the comment above). */
  function showEmpty(message) {
    if (destroyed || everRendered) return;
    overlayText.textContent = message || 'Nothing to preview yet.';
    overlay.hidden = false;
  }

  // ── Library loading (single-flight per pane instance) ──────────────────
  async function ensureRenderPost() {
    if (typeof renderPostFn === 'function') return renderPostFn;
    if (!libsPromise) {
      const loader = loadLibrariesFn || defaultLoadLibraries;
      libsPromise = Promise.resolve(loader(doc)).catch((err) => {
        libsPromise = null; // allow a later render() to retry
        throw err;
      });
    }
    const mod = await libsPromise;
    return mod.renderPost;
  }

  // ── Scroll capture/restore (FR-PRE.3) ──────────────────────────────────
  function readHeadings(idoc) {
    return [...idoc.querySelectorAll(HEADING_SELECTOR)]
      .map((el) => ({ id: el.id, top: el.offsetTop }))
      .sort((a, b) => a.top - b.top);
  }

  function captureAnchor() {
    try {
      const idoc = iframe.contentDocument;
      const iwin = iframe.contentWindow;
      if (!idoc || !iwin) return null;
      const headings = readHeadings(idoc);
      const scrollY = iwin.scrollY ?? idoc.documentElement.scrollTop ?? 0;
      return nearestAnchor(headings, scrollY);
    } catch {
      return null; // best-effort only — never block a render on this
    }
  }

  function restoreAnchor(anchorId) {
    if (!anchorId) return;
    try {
      const idoc = iframe.contentDocument;
      const iwin = iframe.contentWindow;
      if (!idoc || !iwin) return;
      const target = resolveScrollRestore(anchorId, readHeadings(idoc));
      iwin.scrollTo(0, target);
    } catch {
      // best-effort only
    }
  }

  // ── Writing the iframe + diagnostics panel ──────────────────────────────
  function writeFrame(html, diagnostics) {
    if (destroyed) return;
    everRendered = true;
    overlay.hidden = true;
    const anchorId = captureAnchor();
    const onLoad = () => {
      iframe.removeEventListener('load', onLoad);
      restoreAnchor(anchorId);
      if (typeof onRendered === 'function') {
        try { onRendered(); } catch (err) { console.error('[storykit-editor] onRendered hook failed', err); }
      }
    };
    iframe.addEventListener('load', onLoad);
    iframe.srcdoc = html;

    const nextPanel = renderDiagnosticsPanel(diagnostics, { onGotoLine: gotoLine, doc });
    diagPanel.replaceWith(nextPanel);
    diagPanel = nextPanel;
  }

  // ── render() — the frozen entry point ───────────────────────────────────
  //
  // WP-3.4 RECONCILIATION (module-poisoning race between this file and
  // context.js — found while wiring the app, see docs/editor-plan.md WP-3.4
  // handoff for the full writeup): `ensureRenderPost()` and `buildCtx()` were
  // originally run via `Promise.all(...)`, i.e. truly in parallel. But
  // context.js's `getResolveFileCacheWrapper()` ALSO speculatively does
  // `import('../assets/js/skrender.js')` (to reuse skrender's own
  // `createResolveFileCache`, falling back to a local copy if that import
  // isn't safe yet) — and `assets/js/skrender.js` calls `window.markdownit(…)`
  // at module-EVALUATION time (see this file's header). On a real network
  // (unlike the render_regression.py harness's near-instant jsdelivr
  // fixtures), the classic-script injection this file does in
  // `ensureRenderPost()` reliably takes tens-to-hundreds of ms longer than
  // context.js's plain same-origin `import()` of the (locally-served)
  // skrender.js module. So context.js's import routinely WINS the race and
  // evaluates skrender.js before `window.markdownit` exists, throwing at
  // module top level. Per the ES module spec, a module whose evaluation
  // throws is cached PERMANENTLY in that "errored" state — every subsequent
  // `import()` of the same URL (including THIS file's own, later, correctly-
  // sequenced one) immediately rethrows the same error without re-running,
  // for the rest of the page's lifetime. The result: the very first Preview
  // render after a cold load could permanently break preview until a full
  // page reload, no retry possible. Fix: `ensureRenderPost()` MUST fully
  // resolve (libraries injected, skrender.js successfully imported) before
  // anything else gets a chance to import skrender.js — hence the sequential
  // awaits below instead of Promise.all. This only costs latency on the
  // very first render (both caches are warm for every render after); once
  // skrender.js has been imported successfully once, context.js's own import
  // resolves the SAME cached, successful module instantly.
  async function render({ content, path, binding } = {}) {
    const token = tokenTracker.next();
    const diagnostics = [];
    try {
      const buildCtx = buildContextFn || defaultBuildContext;
      const renderPostImpl = await ensureRenderPost();
      if (destroyed || !tokenTracker.isCurrent(token)) return;
      const context = await buildCtx({ binding });
      if (destroyed || !tokenTracker.isCurrent(token)) return;

      if (context && Array.isArray(context.diagnostics)) diagnostics.push(...context.diagnostics);

      const result = await renderPostImpl({ content, path, context });
      if (destroyed || !tokenTracker.isCurrent(token)) return;

      writeFrame(result.html, diagnostics.concat(result.diagnostics || []));
    } catch (err) {
      if (destroyed || !tokenTracker.isCurrent(token)) return;
      const message = (err && err.message) || String(err);
      diagnostics.push({ level: 'error', stage: 'render', message });
      writeFrame(errorDocument(message), diagnostics);
    }
  }

  const scheduled = debounce(render, debounceMs);

  return {
    render,
    schedule: scheduled,
    showEmpty,
    /** Additive: the preview iframe (same-origin srcdoc) — scroll sync
     *  reads its document geometry and window scroll position. */
    getFrame() { return iframe; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      scheduled.cancel();
      mount.replaceChildren();
    },
  };
}
