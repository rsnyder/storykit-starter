/**
 * editor/commands.js — editor commands + keymap (WP-2.3)
 *
 * NOT frozen in docs/editor-plan.md §1.2 (that section freezes editor.js's
 * `createEditor` but leaves the command surface to WP-2.3). This is the
 * final WP-2.3 shape; later WPs (palette/toolbar in WP-6.1) may extend it
 * further but should not need to change these signatures.
 *
 * Scope (spec FR-EDIT.6): bold/italic/link (⌘B/⌘I/⌘K), heading-level
 * cycling, list continuation on Enter, tab-indent in lists, undo/redo
 * (handled by history()/historyKeymap in editor.js, not here).
 *
 * All commands are plain CM6 commands: `(view: EditorView) => boolean`.
 * They dispatch a single transaction (multi-range aware via
 * `state.changeByRange`) and return `true` when they handled the key,
 * `false` to let CM6 fall through to the next binding.
 */

import { EditorSelection } from '@codemirror/state';
import {
  insertNewlineContinueMarkup,
  deleteMarkupBackward,
} from '@codemirror/lang-markdown';
import { indentWithTab } from '@codemirror/commands';

// ─────────────────────────────────────────────────────────────────────────
// Inline wrap/unwrap (bold, italic).
//
// Semantics (idempotent round-trip):
//   - non-empty selection  → wrap/unwrap the marker directly around it
//   - empty selection sitting between two existing markers (`**|**`) →
//     unwrap (removes the empty pair)
//   - empty selection inside/adjacent to a word → expand to that word,
//     then wrap/unwrap around it
//   - empty selection with no adjacent word → insert an empty marker pair
//     with the cursor left in the middle, ready to type
// ─────────────────────────────────────────────────────────────────────────

function isWrapped(state, from, to, marker) {
  const before = state.sliceDoc(Math.max(0, from - marker.length), from);
  const after = state.sliceDoc(to, to + marker.length);
  return before === marker && after === marker;
}

/**
 * Build a toggle-wrap command for a given inline marker (e.g. `**`, `*`).
 * @param {string} marker
 * @returns {(view: import('@codemirror/view').EditorView) => boolean}
 */
export function toggleWrap(marker) {
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      let { from, to } = range;

      if (from === to) {
        if (isWrapped(state, from, to, marker)) {
          // Cursor sits exactly between an empty marker pair — unwrap.
          return {
            changes: [
              { from: from - marker.length, to: from },
              { from: to, to: to + marker.length },
            ],
            range: EditorSelection.cursor(from - marker.length),
          };
        }
        const word = state.wordAt(from);
        if (word) ({ from, to } = word);
      }

      if (isWrapped(state, from, to, marker)) {
        return {
          changes: [
            { from: from - marker.length, to: from },
            { from: to, to: to + marker.length },
          ],
          range: EditorSelection.range(from - marker.length, to - marker.length),
        };
      }

      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + marker.length, to + marker.length),
      };
    });

    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

/** Toggle bold (`**…**`) around the selection or word at cursor (⌘B). CM6 command. */
export const toggleBold = toggleWrap('**');

/** Toggle italic (`*…*`) around the selection or word at cursor (⌘I). CM6 command. */
export const toggleItalic = toggleWrap('*');

/**
 * Insert/wrap a Markdown link around the selection (⌘K):
 * `[selected text]()` with the cursor left inside the (empty) URL parens,
 * ready to type or paste a URL. Selection is used verbatim as the link
 * text; an empty selection produces `[]()`.
 */
export function insertLink(view) {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[${text}]()`;
    const urlPos = range.from + insert.length - 1; // just inside the ')'
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(urlPos),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Heading level cycle.
//
// Per spec: cycling ## → ### → #### → none on the current line. A line
// whose marker isn't one of those three (no marker, or `#`/`#####`/`######`)
// is treated as outside the cycle and jumps in at `##`. The cursor is left
// right after the (possibly empty) new marker.
// ─────────────────────────────────────────────────────────────────────────

const HEADING_STATES = ['', '## ', '### ', '#### '];

/** Cycle the current line's heading level (## → ### → #### → none). CM6 command. */
export function cycleHeading(view) {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const match = /^(#{1,6})\s/.exec(line.text);
    const currentMarker = match ? match[0] : '';
    const idx = HEADING_STATES.indexOf(currentMarker);
    const next = HEADING_STATES[(Math.max(idx, 0) + 1) % HEADING_STATES.length];
    const to = line.from + currentMarker.length;
    return {
      changes: { from: line.from, to, insert: next },
      range: EditorSelection.cursor(line.from + next.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Keymap (FR-EDIT.6). Spliced into editor.js's extension list.
//
// Enter/Backspace reuse lang-markdown's own list-continuation commands
// rather than reimplementing list logic; Tab/Shift-Tab reuses
// @codemirror/commands' `indentWithTab` binding as-is (it already is
// `{ key: 'Tab', run: indentMore, shift: indentLess }`) — works for list
// items too, since the Markdown language configures per-node indent
// behaviour. Note: binding Tab this way traps keyboard focus in the
// editor (no way to Tab out); flagged for WP-6.3's accessibility pass.
// ─────────────────────────────────────────────────────────────────────────

/**
 * KeyBinding[] for FR-EDIT.6 shortcuts.
 * @type {import('@codemirror/view').KeyBinding[]}
 */
export const editorKeymap = [
  { key: 'Mod-b', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', run: toggleItalic, preventDefault: true },
  { key: 'Mod-k', run: insertLink, preventDefault: true },
  { key: 'Enter', run: insertNewlineContinueMarkup },
  { key: 'Backspace', run: deleteMarkupBackward },
  indentWithTab,
];

// Re-exported so tests/other modules don't need a separate import path for
// the underlying lang-markdown commands this keymap composes.
export { insertNewlineContinueMarkup, deleteMarkupBackward };
