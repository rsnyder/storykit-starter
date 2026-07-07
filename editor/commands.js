/**
 * editor/commands.js — editor commands + keymap (WP-2.3)
 *
 * NOT frozen in docs/editor-plan.md §1.2 (that section freezes editor.js's
 * `createEditor` but leaves the command surface to WP-2.3). This scaffold
 * declares a PROVISIONAL shape so app.js can import it and the smoke test
 * can confirm presence; WP-2.3 owns the final contract and may extend it.
 *
 * WP-2.3 scope (spec FR-EDIT.6): bold/italic/link (⌘B/⌘I/⌘K), heading-level
 * cycling, list continuation on Enter, tab-indent in lists, undo/redo.
 *
 * Stub behaviour: `editorKeymap` is an inert empty array (composable into a
 * CM6 extension list today); the command helpers throw the marker.
 */

const NI = 'WP-2.3: not implemented';

/**
 * KeyBinding[] for FR-EDIT.6 shortcuts. Inert (empty) until WP-2.3.
 * @type {import('@codemirror/view').KeyBinding[]}
 */
export const editorKeymap = [];

/** Toggle bold (`**…**`) around the selection. CM6 command. */
export function toggleBold(view) { throw new Error(NI); }

/** Toggle italic (`_…_`) around the selection. CM6 command. */
export function toggleItalic(view) { throw new Error(NI); }

/** Insert/wrap a Markdown link around the selection (⌘K). CM6 command. */
export function insertLink(view) { throw new Error(NI); }

/** Cycle the current line's heading level. CM6 command. */
export function cycleHeading(view) { throw new Error(NI); }
