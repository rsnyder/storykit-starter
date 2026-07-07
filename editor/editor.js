/**
 * editor/editor.js — CodeMirror 6 editor factory (WP-2.3)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2.
 *
 *   createEditor({ parent, initialContent, extraExtensions=[] })
 *     → { view, getContent(), setContent(str), focus(), destroy() }
 *
 * Extension set (spec FR-EDIT.1 + FR-EDIT.6 + this WP's brief):
 *   - Markdown (GFM, via @codemirror/lang-markdown's `markdownLanguage`
 *     base) with a YAML front-matter sub-language for the leading
 *     `---…---` block (see "Front matter" below), and trivial fenced-code
 *     language support for ```html/css/js blocks (the only languages
 *     already pinned for lang-markdown's own transitive graph).
 *   - history, search panel, closeBrackets, drop cursor, active-line,
 *     line-number gutter (UX parity with the WP-2.1 bare editor it
 *     supersedes).
 *   - FR-EDIT.6 keymap from ./commands.js (bold/italic/link/heading/list
 *     continuation/tab-indent).
 *   - EditorView.lineWrapping.
 *   - `extraExtensions` spliced in LAST — this is where lang-storykit
 *     (WP-2.4), dnd (WP-4.1), and wikidata hover (WP-4.2) extensions land,
 *     so they can see/override anything above (e.g. their own decorations,
 *     completion sources, or higher-precedence keymaps).
 *
 * Front matter (spec FR-EDIT.1/7):
 *   `@codemirror/lang-yaml@6.1.3` ships `yamlFrontmatter({ content })`, a
 *   ready-made top-level grammar (`Document → Frontmatter(DashLine,
 *   FrontmatterContent) Body`) built on `@lezer/common`'s `parseMixed`.
 *   This is exactly the "lezer-markdown frontmatter parser" approach
 *   flagged as an option in the WP brief, just shipped from the *YAML*
 *   package instead of `@lezer/markdown` (which has no frontmatter support
 *   in the pinned 1.6.4). No new pin was needed — `yamlFrontmatter` is
 *   already exported by the pinned `@codemirror/lang-yaml@6.1.3`.
 *
 *   As-built, empirically verified (see tests/unit/editor.test.js, which
 *   dumps the real tree): parseMixed *mounts* the nested parser at the
 *   FrontmatterContent/Body node, which means those two node names never
 *   actually appear in the materialized tree — they're transparently
 *   superseded by the mounted parser's own top node (@lezer/yaml's
 *   `Stream`, our markdown's `Document`). What IS directly observable, and
 *   what actually matters for highlighting/lint: a `Frontmatter` node
 *   bounded by two `DashLine` nodes, wrapping real YAML nodes
 *   (`BlockMapping`/`Key`/`Pair`/…), with the ordinary Markdown parse
 *   resuming right after the closing `---`.
 *
 *   Caveat: the grammar only recognises a `---` DASH LINE as the very
 *   first line of the document. A document with no front matter parses
 *   entirely as Markdown (no `Frontmatter` node at all — also verified).
 *   Malformed front matter (a leading `---` with no closing `---`) falls
 *   back gracefully to treating the rest of the document as unterminated
 *   YAML rather than corrupting the Markdown parse.
 *
 * Bus events (docs/editor-plan.md §1.2 lists doc:changed as frozen; word
 * count + cursor position are NOT in that frozen list — mountBareEditor
 * today writes them straight to status-bar DOM nodes rather than emitting
 * bus events, so there is no existing event name to match exactly. This
 * module instead emits `editor:wordcount` / `editor:cursor` shaped to drop
 * straight into editor/statusbar.js's future `setWordCount`/`setCursor`
 * (WP-5.1) — see the handoff notes for the full rationale):
 *   - 'doc:changed'       debounced 250ms, { content: string }
 *   - 'editor:wordcount'  debounced with doc:changed, { words: number }
 *   - 'editor:cursor'     synchronous (cheap), { line: number, col: number }
 *     (1-based, matching the "Ln N, Col N" the status bar already shows)
 *
 * Perf: the only per-keystroke bus work is the synchronous cursor update
 * (an O(log n) `doc.lineAt` lookup); the word count (a whole-doc regex
 * scan) and the `doc:changed` payload are both deferred to the trailing
 * edge of the same 250ms debounce, so neither runs on every keystroke.
 */

import { EditorState } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, dropCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  syntaxHighlighting, HighlightStyle, bracketMatching,
  indentOnInput,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { htmlLanguage } from '@codemirror/lang-html';
import { cssLanguage } from '@codemirror/lang-css';
import { javascriptLanguage } from '@codemirror/lang-javascript';

import { bus } from './app.js';
import { editorKeymap } from './commands.js';

// ── Fenced-code languages ("codeLanguages for fenced blocks where trivial") ─
// Only the languages already pulled into the pinned graph by lang-markdown
// itself (html/css/javascript — see editor/index.html's import-map header)
// are wired up here; anything else falls back to plain highlighting.
function codeLanguageFor(info) {
  const lang = (info || '').trim().toLowerCase().split(/\s+/)[0];
  switch (lang) {
    case 'html':
    case 'htm':
      return htmlLanguage;
    case 'css':
      return cssLanguage;
    case 'js':
    case 'javascript':
      return javascriptLanguage;
    default:
      return null;
  }
}

const markdownSupport = markdown({ base: markdownLanguage, codeLanguages: codeLanguageFor });
const docLanguage = yamlFrontmatter({ content: markdownSupport });

// ── Theme-aware highlight style (parity with app.js's bare-editor palette;
// extended with YAML-ish tags so the front-matter block reads distinctly
// from prose). WP-2.4 layers StoryKit-tag-specific tokens on top via
// extraExtensions. ─────────────────────────────────────────────────────────
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
    // YAML front matter (propertyName = keys, string/number/bool = scalars).
    { tag: t.propertyName, color: c.list, fontWeight: '600' },
    { tag: [t.string, t.special(t.string)], color: c.url },
    { tag: [t.number, t.bool, t.null], color: c.code },
    { tag: t.punctuation, color: c.meta },
  ]);
}

function resolvedTheme() {
  if (typeof document === 'undefined') return 'light';
  const pref = document.documentElement.getAttribute('data-theme');
  if (pref === 'light' || pref === 'dark') return pref;
  return (typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark'
    : 'light';
}

const WORD_RE = /\S+/g;

function countWords(text) {
  const m = text.match(WORD_RE);
  return m ? m.length : 0;
}

function cursorPos(state) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1 };
}

/**
 * Create the editing surface.
 * @param {{ parent: HTMLElement, initialContent?: string, extraExtensions?: import('@codemirror/state').Extension[] }} opts
 * @returns {{
 *   view: import('@codemirror/view').EditorView,
 *   getContent: () => string,
 *   setContent: (str: string) => void,
 *   focus: () => void,
 *   destroy: () => void,
 * }}
 * @fires bus#doc:changed — debounced 250 ms, detail `{ content }`
 * @fires bus#editor:wordcount — debounced with doc:changed, detail `{ words }`
 * @fires bus#editor:cursor — synchronous, detail `{ line, col }`
 */
export function createEditor({ parent, initialContent = '', extraExtensions = [] } = {}) {
  if (!parent) {
    throw new Error('createEditor: `parent` (a mount element) is required');
  }

  let changeTimer = null;
  function scheduleDocChanged(state) {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = null;
      const content = state.doc.toString();
      bus.dispatchEvent(new CustomEvent('doc:changed', { detail: { content } }));
      bus.dispatchEvent(new CustomEvent('editor:wordcount', { detail: { words: countWords(content) } }));
    }, 250);
  }

  const dark = resolvedTheme() === 'dark';

  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(makeHighlightStyle(dark), { fallback: true }),
      docLanguage,
      EditorView.lineWrapping,
      // Accessible name for the contenteditable textbox CM6 renders
      // (.cm-content, role="textbox") — without it, axe flags
      // aria-input-field-name on every surface (WP-6.3, WCAG 4.1.2).
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown editor' }),
      keymap.of([
        ...closeBracketsKeymap,
        ...editorKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) scheduleDocChanged(update.state);
        if (update.selectionSet || update.docChanged) {
          bus.dispatchEvent(new CustomEvent('editor:cursor', { detail: cursorPos(update.state) }));
        }
      }),
      EditorView.theme({ '&': { height: '100%' } }, { dark }),
      extraExtensions,
    ],
  });

  const view = new EditorView({ state, parent });
  bus.dispatchEvent(new CustomEvent('editor:cursor', { detail: cursorPos(view.state) }));

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent(str) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: str ?? '' },
      });
    },
    focus: () => view.focus(),
    destroy() {
      if (changeTimer) {
        clearTimeout(changeTimer);
        changeTimer = null;
      }
      view.destroy();
    },
  };
}
