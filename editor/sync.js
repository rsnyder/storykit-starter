/**
 * editor/sync.js — GitHub sync workflows + status machine (WP-5.1)
 *
 * NOT frozen in docs/editor-plan.md §1.2 (§1.2 names sync.js under WP-5.1 but
 * freezes only conflict.js's `resolveConflict`). PROVISIONAL shape for the
 * scaffold; WP-5.1 owns the final contract. Scope (spec FR-GH.1–6): token
 * UI, binding + branch create, commit + sha bookkeeping, pull +
 * remote-changed banner, five-state machine + toasts.
 *
 * INVARIANT (spec FR-GH.4/5): every buffer-replacing path MUST snapshot to
 * revisions first. Encoded here as a doc comment; enforced by WP-5.1 tests.
 *
 * Stub behaviour: all workflow functions throw the marker.
 */

const NI = 'WP-5.1: not implemented';

/**
 * Commit the document buffer to its bound branch (FR-GH.3).
 * @param {{ docId: string, message: string }} args
 * @returns {Promise<{ sha: string, syncedAt: string }>}
 */
export async function commitDocument({ docId, message } = {}) {
  throw new Error(NI);
}

/**
 * Pull the bound file, snapshotting local first (FR-GH.5).
 * @param {{ docId: string }} args
 * @returns {Promise<{ content: string, sha: string }>}
 */
export async function pullDocument({ docId } = {}) {
  throw new Error(NI);
}

/**
 * Bind a document to {owner,repo,branch,path}, creating the branch if asked
 * (FR-GH.2).
 * @param {{ docId: string, owner: string, repo: string, branch: string, path: string, createBranch?: boolean }} args
 * @returns {Promise<object>} the updated document record
 */
export async function bindDocument({ docId, owner, repo, branch, path, createBranch } = {}) {
  throw new Error(NI);
}
