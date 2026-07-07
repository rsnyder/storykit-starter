/**
 * editor/conflict.js — conflict resolution dialog (WP-5.2)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. Three-choice dialog + read-only
 * side-by-side diff (a pinned diff lib is added to the import map by WP-5.2).
 *
 * INVARIANT (spec FR-GH.4): revisions.snapshot() MUST complete before any
 * resolution executes. Enforced by WP-5.2 tests.
 *
 * Stub behaviour: `resolveConflict` throws the marker.
 */

const NI = 'WP-5.2: not implemented';

/**
 * @param {{ local: string, remote: string }} args
 * @returns {Promise<'mine' | 'remote'>}
 */
export async function resolveConflict({ local, remote } = {}) {
  throw new Error(NI);
}
