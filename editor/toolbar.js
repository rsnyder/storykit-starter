/**
 * editor/toolbar.js — editor toolbar (WP-6.1)
 *
 * Spec: docs/editor-spec.md §7 ("Toolbar (editor): minimal — bold, italic,
 * link, heading, list, Insert viewer (menu of the six embeds with
 * attribute-prompting snippets), Link entity. Everything else lives in the
 * command palette."). docs/editor-plan.md §3 WP-6.1.
 *
 *   createToolbar({ mount, actions })
 *     → { destroy(): void }
 *
 *   mount   — HTMLElement to render the toolbar's icon buttons into (app.js
 *             wires this to `#toolbar-mount`, a new region above the editor
 *             pane — see editor/index.html/styles.css).
 *   actions — zero-arg callbacks supplied by app.js, each closing over the
 *             live `editorHandle` (which is destroyed/recreated on theme
 *             change and document switch, so the toolbar must never cache a
 *             `view` reference itself — mirrors the existing "Link entity"
 *             top-bar button precedent in app.js's wireControls()):
 *               { bold, italic, link, heading, list, linkEntity,
 *                 insertViewer(catalogKey) }
 *             Any action may be omitted; the corresponding button simply
 *             becomes a no-op (defensive — keeps this module usable in
 *             tests that only care about a subset).
 *
 * ── Insert-viewer snippet behaviour (chosen design, documented per the
 *    WP-6.1 brief's "OR document a simpler chosen behaviour") ─────────────
 * `buildViewerSnippet(key)` builds the `{% include <key> attr="" ... %}`
 * text for one of the six catalog entries (editor/viewer-catalog.js),
 * using every attribute marked `required: true`. ONE entry — embed/image.html
 * — has NO `required: true` attribute in the catalog (its doc string says
 * "one of src or manifest is required", a disjunction the catalog schema
 * can't express as a single `required` flag); for that case (and, generally,
 * any viewer with zero required attrs) the snippet falls back to a single
 * placeholder on the catalog's FIRST listed attribute, so every one of the
 * six menu items always inserts at least one attribute-prompting
 * placeholder rather than a bare, un-promptable tag.
 *
 * Placeholder behaviour: the first placeholder's empty `""` is where the
 * cursor lands immediately after insert (ready to type — same idiom as
 * dnd.js's post-insert hint and lang-storykit's attribute-completion
 * cursor-between-quotes convention). For a tag with MORE than one
 * required attribute (only embed/image-compare.html: `before` + `after`),
 * subsequent Tab presses jump the cursor to the next placeholder instead of
 * indenting — a small transient CM6 extension (`viewerSnippetExtension()`,
 * spliced into app.js's `buildExtraExtensions()`) tracks the remaining
 * placeholder positions in a StateField and intercepts Tab (Prec.high, so it
 * runs ahead of the base editorKeymap's `indentWithTab`) only while
 * placeholders remain; it clears itself (falling back to normal Tab/indent
 * behaviour) once every placeholder has been visited, or on any edit that
 * isn't one of its own jumps.
 *
 * Selectors for tests/e2e:
 *   `.sk-toolbar`                              the toolbar root
 *   `[data-sk-toolbar-action="bold|italic|link|heading|list|link-entity"]`
 *   `[data-sk-toolbar-action="insert-viewer"]`  the dropdown trigger
 *   `.sk-toolbar-viewer-menu`                   the dropdown popup
 *   `[data-sk-viewer-key="<catalog key>"]`      one dropdown item
 */

import { EditorSelection, StateField, StateEffect, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { catalog } from './viewer-catalog.js';

// ── Short human labels for the six catalog entries (the catalog itself only
//    carries the long `doc` description + the repo-relative include path). ─
export const VIEWER_LABELS = Object.freeze({
  'embed/image.html': 'Image',
  'embed/image-compare.html': 'Image compare',
  'embed/map.html': 'Map',
  'embed/vis-network.html': 'Network diagram',
  'embed/youtube.html': 'YouTube video',
  'embed/iframe.html': 'Iframe embed',
});

/** Catalog keys in the toolbar/palette's preferred menu order. */
export const VIEWER_KEYS = Object.freeze(Object.keys(VIEWER_LABELS).filter((k) => catalog[k]));

// ── buildViewerSnippet: pure, no DOM — the unit-testable core ────────────

/**
 * @param {string} key a editor/viewer-catalog.js key, e.g. "embed/map.html"
 * @returns {{ key: string, tag: string, attrs: string[], placeholders: number[] } | null}
 *   `placeholders` are offsets INTO `tag` (cursor position, between the two
 *   quotes of each attribute placeholder), in insertion order.
 */
export function buildViewerSnippet(key) {
  const entry = catalog[key];
  if (!entry || !entry.attrs) return null;
  const attrNames = Object.keys(entry.attrs);
  let chosen = attrNames.filter((n) => entry.attrs[n] && entry.attrs[n].required);
  if (!chosen.length && attrNames.length) chosen = [attrNames[0]]; // see header note
  const parts = chosen.map((n) => `${n}=""`);
  const attrsText = parts.length ? ` ${parts.join(' ')}` : '';
  const tag = `{% include ${key}${attrsText} %}`;

  const placeholders = [];
  let searchFrom = 0;
  for (const part of parts) {
    const idx = tag.indexOf(part, searchFrom);
    // `part` is `name=""` — the cursor slot is between the two quotes, i.e.
    // the index of the SECOND (closing) quote character.
    const pos = idx + part.length - 1;
    placeholders.push(pos);
    searchFrom = idx + part.length;
  }
  return { key, tag, attrs: chosen, placeholders };
}

// ── viewerSnippetExtension: Tab-jump between remaining placeholders ──────

const setViewerPlaceholders = StateEffect.define(); // value: number[] | null (absolute doc positions)

const viewerPlaceholderField = StateField.define({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setViewerPlaceholders)) return e.value && e.value.length ? e.value : null;
    }
    if (!value) return value;
    if (tr.docChanged) {
      // Remap surviving placeholders through the change; drop any that no
      // longer make sense (defensive — the jump itself is the only expected
      // mutation while this field is populated).
      const mapped = value.map((pos) => tr.changes.mapPos(pos, 1)).filter((p) => p != null);
      return mapped.length ? mapped : null;
    }
    return value;
  },
});

/**
 * Tab, while `viewerPlaceholderField` still holds pending positions, jumps
 * the cursor to the next one instead of indenting. Prec.high (not
 * `.highest`) is enough: editor.js's base keymap concatenates
 * `editorKeymap` (which owns `indentWithTab`) ahead of `extraExtensions` in
 * ONE `keymap.of([...])` array — see that file's header note — so a
 * *separate* keymap.of() call in extraExtensions needs an explicit
 * precedence bump to win the tie-break (same reasoning as wikidata.js's
 * Mod-Shift-k binding in app.js).
 */
const viewerTabJump = Prec.high(
  keymap.of([
    {
      key: 'Tab',
      run(view) {
        const pending = view.state.field(viewerPlaceholderField, false);
        if (!pending || !pending.length) return false;
        const [next, ...rest] = pending;
        view.dispatch({
          selection: EditorSelection.cursor(next),
          effects: setViewerPlaceholders.of(rest.length ? rest : null),
          scrollIntoView: true,
        });
        return true;
      },
    },
  ])
);

/** @returns {import('@codemirror/state').Extension[]} */
export function viewerSnippetExtension() {
  return [viewerPlaceholderField, viewerTabJump];
}

// ── list-item command (the toolbar's "list" button + palette entry) ──────

const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * Inserts a `- ` bullet marker at the start of the line at each range's
 * head (a no-op on a line that already looks like a list item — bullet,
 * numbered, or task-list — so repeated invocation is harmless rather than
 * double-prefixing). Mirrors editor/commands.js's `cycleHeading` — one
 * marker per selection range's current line, single change per range — so
 * a multi-cursor selection gets a marker on each cursor's line. CM6 command
 * shape: `(view) => boolean`, matching editor/commands.js's convention.
 * @param {import('@codemirror/view').EditorView} view
 */
export function insertListItem(view) {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    if (LIST_MARKER_RE.test(line.text)) return { range };
    const shift = (pos) => (pos >= line.from ? pos + 2 : pos);
    return {
      changes: { from: line.from, insert: '- ' },
      range: EditorSelection.range(shift(range.anchor), shift(range.head)),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

// ── insertViewerTag: block-tag insertion (own line, blank-line surround) ──

/**
 * Inserts the snippet for `key` at the current line (own line, surrounded
 * by blank lines when not at a document boundary — same placement idiom as
 * dnd.js's block-tag drop insertion, reimplemented minimally here since
 * dnd.js's version isn't exported and this is a distinct insertion path).
 * Places the cursor in the first placeholder and arms
 * `viewerSnippetExtension()`'s Tab-jump for any remaining ones.
 * @param {import('@codemirror/view').EditorView} view
 * @param {string} key
 * @returns {boolean}
 */
export function insertViewerTag(view, key) {
  if (!view) return false;
  const snippet = buildViewerSnippet(key);
  if (!snippet) return false;

  const { state } = view;
  const pos = state.selection.main.head;
  const doc = state.doc;
  const line = doc.lineAt(pos);
  const anchor = line.length === 0 ? line.from : line.to;

  // Collapse any ALREADY-existing blank-line run adjacent to `anchor` into
  // the replaced range (rather than blindly inserting a fresh "\n\n" pair
  // next to it, which would double up blank lines) — the same scan-and-
  // collapse strategy as dnd.js's `computeBlockInsertion` (reimplemented
  // here since that function isn't exported and this is a distinct
  // insertion path; see this function's header note).
  const SCAN_WINDOW = 200;
  const left = doc.sliceString(Math.max(0, anchor - SCAN_WINDOW), anchor);
  const right = doc.sliceString(anchor, Math.min(doc.length, anchor + SCAN_WINDOW));
  const leftBlankRun = /\n*$/.exec(left)[0];
  const rightBlankRun = /^\n*/.exec(right)[0];

  const from = anchor - leftBlankRun.length;
  const to = anchor + rightBlankRun.length;
  const atDocStart = from === 0;
  const atDocEnd = to === doc.length;
  const before = atDocStart ? '' : '\n\n';
  const after = atDocEnd ? '' : '\n\n';
  const insert = before + snippet.tag + after;
  const tagFrom = from + before.length;

  const absolutePlaceholders = snippet.placeholders.map((p) => tagFrom + p);
  const [first, ...rest] = absolutePlaceholders;
  const cursorPos = first != null ? first : tagFrom + snippet.tag.length;

  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(cursorPos),
    effects: setViewerPlaceholders.of(rest.length ? rest : null),
    scrollIntoView: true,
    userEvent: 'input.complete',
  });
  view.focus();
  return true;
}

// ── injected styles (own stylesheet, --sk-* tokens with hermetic fallbacks) ─
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'sk-toolbar-styles';
  style.textContent = `
.sk-toolbar {
  display: flex; align-items: center; gap: 2px; flex: 0 0 auto;
  padding: 4px var(--sk-space-1, 8px); overflow-x: auto; overflow-y: hidden;
  background: var(--sk-surface, #fff); border-bottom: 1px solid var(--sk-border, #d8dee4);
}
.sk-toolbar-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; flex: none; padding: 0;
  color: var(--sk-text-muted, #57606a); background: transparent;
  border: 1px solid transparent; border-radius: var(--sk-radius, 6px); cursor: pointer;
}
.sk-toolbar-btn:hover { background: var(--sk-bg-sunken, #f6f8fa); color: var(--sk-text, #1f2328); }
.sk-toolbar-sep { width: 1px; align-self: stretch; margin: 4px 4px; background: var(--sk-border, #d8dee4); flex: none; }
.sk-toolbar-dropdown { position: relative; flex: none; }
.sk-toolbar-btn[aria-expanded="true"] { background: var(--sk-selection, rgba(9,105,218,.14)); color: var(--sk-text, #1f2328); }
.sk-toolbar-viewer-menu {
  /* position/top/left are set inline (fixed, under the trigger) at open
     time — see buildViewerDropdown()'s openMenu(); this rule's position is
     just a sane fallback. Appended to document.body, NOT nested under
     .sk-toolbar-dropdown, specifically to escape .sk-toolbar's
     overflow-x:auto (which implicitly computes overflow-y:auto too, per
     the CSS overflow spec, and was clipping an absolutely-positioned menu
     to the toolbar's own ~38px height). */
  position: fixed; z-index: 5000; min-width: 200px;
  background: var(--sk-elevated, #fff); color: var(--sk-text, #1f2328);
  border: 1px solid var(--sk-border, #d8dee4); border-radius: var(--sk-radius, 6px);
  box-shadow: var(--sk-shadow-2, 0 8px 24px rgba(31,35,40,.18)); padding: 4px; margin: 0; list-style: none;
}
.sk-toolbar-viewer-item {
  padding: 6px 10px; border-radius: var(--sk-radius-sm, 4px); cursor: pointer; font-size: var(--sk-fs-sm, 13px);
}
.sk-toolbar-viewer-item.is-active, .sk-toolbar-viewer-item:hover { background: var(--sk-selection, rgba(9,105,218,.14)); }
/* Responsive collapse (WP-6.2 §5.5 "toolbar collapses"): priority+scroll —
   every button stays reachable (nothing is ever hidden behind a menu the
   author has to discover), the row just becomes horizontally scrollable
   with native momentum/snap so it reads as an intentional filmstrip rather
   than an overflow bug. Buttons grow slightly at the narrowest widths for
   easier touch targeting. */
@media (max-width: 800px) {
  .sk-toolbar {
    gap: 0; padding: 2px 4px;
    scroll-snap-type: x proximity;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
  }
  .sk-toolbar-btn { width: 30px; height: 30px; scroll-snap-align: start; }
  .sk-toolbar-sep { margin: 4px 2px; }
}
@media (max-width: 480px) {
  .sk-toolbar-btn { width: 34px; height: 34px; }
}
`;
  document.head.appendChild(style);
}

// ── icon glyphs (inline SVG, currentColor — theme-aware for free) ────────

const ICONS = {
  bold: '<path d="M6 4h5.2a3.3 3.3 0 010 6.6H6zM6 10.6h5.6a3.4 3.4 0 010 6.8H6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  italic: '<path d="M11 4h5M4 16h5M13 4L7 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  link: '<path d="M8.2 11.8a3 3 0 004.3 0l2-2a3 3 0 00-4.3-4.3l-1 1M11.8 8.2a3 3 0 00-4.3 0l-2 2a3 3 0 004.3 4.3l1-1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  heading: '<path d="M5 4v12M13 4v12M5 10h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  list: '<path d="M8 5h8M8 10h8M8 15h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="4.3" cy="5" r="1.1" fill="currentColor"/><circle cx="4.3" cy="10" r="1.1" fill="currentColor"/><circle cx="4.3" cy="15" r="1.1" fill="currentColor"/>',
  viewer: '<rect x="4" y="5" width="12" height="10" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 12l3.2-3.2a1 1 0 011.4 0L12 12M11 10.6l1.3-1.3a1 1 0 011.4 0L16 11.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  entity: '<path d="M8.5 11.5a3 3 0 004.24 0l2-2a3 3 0 00-4.24-4.24l-1 1M11.5 8.5a3 3 0 00-4.24 0l-2 2a3 3 0 004.24 4.24l1-1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
};

function svgIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

function makeButton({ action, label, icon, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sk-toolbar-btn';
  btn.dataset.skToolbarAction = action;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.appendChild(svgIcon(icon));
  btn.addEventListener('click', onClick);
  return btn;
}

function sep() {
  const s = document.createElement('span');
  s.className = 'sk-toolbar-sep';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

const noop = () => {};

// ── Insert-viewer dropdown ────────────────────────────────────────────────

function buildViewerDropdown(doc, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'sk-toolbar-dropdown';

  const trigger = makeButton({
    action: 'insert-viewer',
    label: 'Insert viewer',
    icon: 'viewer',
    onClick: () => toggle(),
  });
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  wrap.appendChild(trigger);

  let menu = null;
  let activeIndex = -1;

  function items() {
    return menu ? Array.from(menu.querySelectorAll('.sk-toolbar-viewer-item')) : [];
  }

  function setActive(i) {
    const els = items();
    if (!els.length) return;
    activeIndex = (i + els.length) % els.length;
    els.forEach((el, idx) => el.classList.toggle('is-active', idx === activeIndex));
    els[activeIndex].focus();
  }

  function openMenu() {
    if (menu) return;
    menu = doc.createElement('ul');
    menu.className = 'sk-toolbar-viewer-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Insert viewer');

    VIEWER_KEYS.forEach((key, i) => {
      const li = doc.createElement('li');
      li.className = 'sk-toolbar-viewer-item';
      li.setAttribute('role', 'menuitem');
      li.tabIndex = -1;
      li.dataset.skViewerKey = key;
      li.textContent = VIEWER_LABELS[key] || key;
      li.title = (catalog[key] && catalog[key].doc) || '';
      li.addEventListener('click', () => {
        close();
        trigger.focus();
        onPick(key);
      });
      li.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); }
        else if (e.key === 'Tab') { close(); }
      });
      menu.appendChild(li);
    });

    // Appended to `document.body` (fixed-positioned under the trigger via
    // getBoundingClientRect), NOT to `wrap` — the toolbar row sets
    // `overflow-x: auto` so it can scroll horizontally at narrow widths
    // (§7 "collapse gracefully at 800px"), and per the CSS overflow spec a
    // non-'visible' overflow-x implicitly computes overflow-y as 'auto'
    // too, which was silently CLIPPING the dropdown to the toolbar's own
    // ~38px height (verified empirically via a screenshot: only the first
    // menu item was ever visible). Fixed positioning escapes that
    // scroll/clip context entirely — the same technique editor/wikidata.js's
    // search popup already uses for the identical reason.
    const rect = trigger.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left}px`;
    document.body.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    setActive(0);

    queueMicrotask(() => document.addEventListener('mousedown', onOutside, true));
  }

  function onOutside(e) {
    if (!wrap.contains(e.target) && !(menu && menu.contains(e.target))) close();
  }

  function close() {
    if (!menu) return;
    document.removeEventListener('mousedown', onOutside, true);
    menu.remove();
    menu = null;
    activeIndex = -1;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    if (menu) close();
    else openMenu();
  }

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu();
    }
  });

  return { el: wrap, close };
}

// ── createToolbar ──────────────────────────────────────────────────────

/**
 * @param {{ mount: HTMLElement, actions: object }} opts
 * @returns {{ destroy: () => void }}
 */
export function createToolbar({ mount, actions = {} } = {}) {
  if (!mount) throw new Error('createToolbar: `mount` is required');
  ensureStyles();
  const doc = mount.ownerDocument || document;

  const root = doc.createElement('div');
  root.className = 'sk-toolbar';
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Formatting');

  const boldBtn = makeButton({ action: 'bold', label: 'Bold', icon: 'bold', onClick: () => (actions.bold || noop)() });
  const italicBtn = makeButton({ action: 'italic', label: 'Italic', icon: 'italic', onClick: () => (actions.italic || noop)() });
  const linkBtn = makeButton({ action: 'link', label: 'Insert link', icon: 'link', onClick: () => (actions.link || noop)() });
  const headingBtn = makeButton({ action: 'heading', label: 'Heading level', icon: 'heading', onClick: () => (actions.heading || noop)() });
  const listBtn = makeButton({ action: 'list', label: 'List item', icon: 'list', onClick: () => (actions.list || noop)() });
  const viewerDropdown = buildViewerDropdown(doc, (key) => (actions.insertViewer || noop)(key));
  const entityBtn = makeButton({ action: 'link-entity', label: 'Link entity', icon: 'entity', onClick: () => (actions.linkEntity || noop)() });

  root.append(boldBtn, italicBtn, linkBtn, sep(), headingBtn, listBtn, sep(), viewerDropdown.el, sep(), entityBtn);
  mount.replaceChildren(root);

  return {
    destroy() {
      viewerDropdown.close();
      mount.replaceChildren();
    },
  };
}
