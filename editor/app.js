/**
 * editor/app.js — StoryKit Editor application shell (WP-2.1 scaffold)
 *
 * Owns the shared app surface per docs/editor-plan.md §1.2:
 *   - `bus`      : the app-wide EventTarget (event names frozen below)
 *   - `appState` : { currentDocId, mode, binding, prefs }
 *   - preference persistence in localStorage ('storykit-editor-prefs')
 *   - theme + mode toggles, sidebar collapse
 *   - the single-instance CM6 assertion (risk R-3)
 *   - a working BARE CodeMirror 6 editor (markdown; no StoryKit extension yet)
 *
 * This file is edited only by WP-2.1 and the integration WPs (2.6, 3.4, 4.3).
 * Feature WPs code against `bus` / `appState` and their own module files.
 *
 * Buildless: every import below resolves through the pinned import map in
 * editor/index.html (esm.sh, `?external=*` dedupe — see index.html header and
 * tools/check_editor_pins.py).
 */

// ── CodeMirror 6 (bare editor + single-instance assertion) ──────────────────
import { EditorState, StateField, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection,
  crosshairCursor, highlightSpecialChars,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, historyField, indentWithTab,
} from '@codemirror/commands';
import {
  syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching,
  indentOnInput, foldGutter, foldKeymap,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import {
  closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap,
} from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { lintKeymap, lintGutter } from '@codemirror/lint';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';

// ── Editor module surface (imported for skeleton wiring + smoke-test proof) ──
// These are WP-2.1 stubs today; importing them proves the pinned graph and the
// frozen contracts load cleanly. They are wired for real by later WPs.
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

// Keep tree-shakers / linters from flagging the skeleton imports as unused, and
// give integration WPs a single object to reach the module namespaces through.
export const modules = {
  store, editor, commands, langStorykit, doclist, preview, statusbar,
  github, context, wikidata, dnd, sync, conflict,
};

// ─────────────────────────────────────────────────────────────────────────────
// Event bus. Frozen event names (docs/editor-plan.md §1.2):
//   doc:changed · doc:saved · mode:changed · sync:status · lint:count · toast
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

/** Rebuild the bare editor so CM syntax colors follow the active theme. */
function rethemeEditor() {
  if (!bareView) return;
  const content = bareView.state.doc.toString();
  const parent = bareView.dom.parentElement;
  bareView.destroy();
  bareView = null;
  if (parent) mountBareEditor(parent, content);
}

function resolvedTheme() {
  if (appState.prefs.theme !== 'system') return appState.prefs.theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
// Bare CodeMirror 6 editor (WP-2.1 baseline; replaced by editor.js in WP-2.3).
// ─────────────────────────────────────────────────────────────────────────────
const WELCOME_DOC = `---
title: Untitled draft
date: 2026-07-06
categories: [ ]
tags: [ ]
---

# Start writing

This is the **StoryKit Editor** scaffold (WP-2.1). The editing surface is a
bare CodeMirror 6 instance — Markdown highlighting works, but StoryKit tag
highlighting, autocomplete, lint, preview, media drops and GitHub sync arrive
in later work packages.

Drop a StoryKit viewer tag in and it is just text for now:

{% include embed/image.html src="wc:Westgate_Towers_Canterbury.jpg" %}
`;

// Theme-aware Markdown highlight styles (kept legible on both backgrounds;
// WP-2.4 replaces this with the full StoryKit token palette).
function makeHighlightStyle(dark) {
  const c = dark
    ? { head: '#8ab4f8', strong: '#e6edf3', link: '#8ab4f8', url: '#7ee787',
        quote: '#adbac7', list: '#daaa3f', code: '#ff9492', meta: '#768390', mark: '#6e7781' }
    : { head: '#0b3d91', strong: '#1f2328', link: '#0056b2', url: '#0a7d2c',
        quote: '#57606a', list: '#9a6700', code: '#b3261e', meta: '#57606a', mark: '#818b98' };
  return HighlightStyle.define([
    { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4], color: c.head, fontWeight: '600' },
    { tag: t.strong, color: c.strong, fontWeight: '700' },
    { tag: t.emphasis, color: c.strong, fontStyle: 'italic' },
    { tag: [t.link, t.labelName], color: c.link, textDecoration: 'underline' },
    { tag: t.url, color: c.url },
    { tag: t.quote, color: c.quote, fontStyle: 'italic' },
    { tag: [t.list, t.atom], color: c.list },
    { tag: [t.monospace, t.literal], color: c.code },
    { tag: [t.meta, t.comment, t.processingInstruction, t.contentSeparator], color: c.meta },
    { tag: [t.keyword, t.tagName, t.brace], color: c.head },
    { tag: t.strikethrough, textDecoration: 'line-through', color: c.mark },
  ]);
}

let bareView = null;

/**
 * Mount the bare editor into `parent`.
 * @param {HTMLElement} parent
 * @param {string} [content]
 * @returns {EditorView}
 */
export function mountBareEditor(parent, content = WELCOME_DOC) {
  const state = EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(makeHighlightStyle(resolvedTheme() === 'dark'), { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      lintGutter(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
      markdown({ base: markdownLanguage }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((v) => {
        if (v.docChanged) emit('doc:changed', { content: v.state.doc.toString() });
        if (v.selectionSet || v.docChanged) updateStatusPlaceholders(v.state);
      }),
      EditorView.theme({ '&': { height: '100%' } }, { dark: resolvedTheme() === 'dark' }),
    ],
  });
  bareView = new EditorView({ state, parent });
  updateStatusPlaceholders(bareView.state);
  return bareView;
}

function updateStatusPlaceholders(state) {
  const text = state.doc.toString();
  const words = (text.match(/\S+/g) || []).length;
  const wc = document.getElementById('status-wordcount');
  if (wc) wc.textContent = `${words.toLocaleString()} words`;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const cur = document.getElementById('status-cursor');
  if (cur) cur.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
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
// Bootstrap.
// ─────────────────────────────────────────────────────────────────────────────
export function init() {
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

  const mount = document.getElementById('editor-mount');
  if (mount) {
    try {
      const skeleton = mount.querySelector('.skeleton');
      if (skeleton) skeleton.remove();
      mountBareEditor(mount);
    } catch (error) {
      showFatalBanner(`CodeMirror failed to initialise: ${error?.message || error}`);
      console.error('[storykit-editor] editor mount failed', error);
      return { ok: false };
    }
  }

  wireControls();
  wireLifecycle();
  return { ok: true, view: bareView };
}

function wireControls() {
  for (const btn of document.querySelectorAll('[data-mode-btn]')) {
    btn.addEventListener('click', () => setMode(btn.getAttribute('data-mode-btn')));
  }
  document.getElementById('sidebar-toggle')?.addEventListener('click', toggleSidebar);
  document.getElementById('theme-toggle')?.addEventListener('click', cycleTheme);

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
