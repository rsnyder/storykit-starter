/**
 * editor/wikidata.js — Wikidata entity search + hover cards (WP-4.2)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. Uses wbsearchentities /
 * wbgetentities with origin=* (CORS, keyless); entityCache-backed 30-day
 * TTL. Registers a label resolver into the WP-2.4 QID-decoration hook.
 *
 * Stub behaviour: network calls (`searchEntities`, `getEntities`) throw.
 * `linkEntityCommand` returns false (inert CM6 command — "not handled").
 * `qidHoverExtension` returns an inert empty extension array so it composes
 * into the editor today.
 */

const NI = 'WP-4.2: not implemented';

/**
 * @param {string} q
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<{ id: string, label: string, description?: string, thumbnail?: string }>>}
 */
export async function searchEntities(q, { signal } = {}) {
  throw new Error(NI);
}

/**
 * @param {string[]} qids
 * @returns {Promise<Map<string, object>>}
 */
export async function getEntities(qids) {
  throw new Error(NI);
}

/**
 * ⌘⇧K command: open the entity-search popup for the selection.
 * @param {import('@codemirror/view').EditorView} view
 * @returns {boolean} whether the command handled the key
 */
export function linkEntityCommand(view) {
  return false;
}

/**
 * Hover cards on `[text](Q…)` links.
 * @returns {import('@codemirror/state').Extension[]}
 */
export function qidHoverExtension() {
  return [];
}
