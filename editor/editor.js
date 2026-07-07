/**
 * editor/editor.js — CodeMirror 6 editor factory (WP-2.3)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. WP-2.3 builds the real editor
 * (lang-markdown GFM + YAML front-matter sub-language, history, search,
 * close-brackets, drop-cursor, active-line, FR-EDIT.6 shortcuts, word-count
 * + cursor on the bus). This scaffold stub throws when called.
 *
 * NOTE: the WP-2.1 scaffold instantiates its own bare CM6 editor inline in
 * app.js (see `mountBareEditor`) rather than depending on this stub, so the
 * page loads and edits cleanly before WP-2.3 exists. Once WP-2.3 lands,
 * app.js switches to `createEditor` and the inline path is removed.
 */

const NI = 'WP-2.3: not implemented';

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
 */
export function createEditor({ parent, initialContent = '', extraExtensions = [] } = {}) {
  throw new Error(NI);
}
