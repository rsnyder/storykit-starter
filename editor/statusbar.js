/**
 * editor/statusbar.js — status bar controller (WP-5.1)
 *
 * NOT frozen in docs/editor-plan.md §1.2 (§1.2 pairs statusbar.js with
 * sync.js under WP-5.1 but freezes only conflict.js's `resolveConflict`).
 * PROVISIONAL shape for the scaffold; WP-5.1 owns the final contract.
 * Scope (spec §7 / FR-GH.6): binding (repo·branch·path), sync state,
 * word count, cursor position, lint count — all surfaced in the status bar.
 *
 * Stub behaviour: `createStatusBar` throws. app.js renders static status-bar
 * placeholder segments so the §7 three-region layout is visible immediately.
 */

const NI = 'WP-5.1: not implemented';

/**
 * @param {{ mount: HTMLElement }} opts
 * @returns {{
 *   setBinding: (binding: object|null) => void,
 *   setSyncState: (state: 'local'|'synced'|'local-changes'|'remote-changed'|'conflict') => void,
 *   setWordCount: (n: number) => void,
 *   setCursor: (pos: { line: number, col: number }) => void,
 *   setLintCount: (n: number) => void,
 *   destroy: () => void,
 * }}
 */
export function createStatusBar({ mount } = {}) {
  throw new Error(NI);
}
