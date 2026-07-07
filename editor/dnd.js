/**
 * editor/dnd.js — drop/paste tag-insertion handlers (WP-4.1)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. CM6 drop/paste handlers layered
 * over editor/url-grammars.js (FR-DND.*). `onNotice` surfaces the
 * degrade/fallback messages the grammar layer returns.
 *
 * Stub behaviour: returns an INERT empty extension array so the editor can
 * compose it today with no drop/paste transformation.
 */

/**
 * @param {{ onNotice: (message: string) => void }} opts
 * @returns {import('@codemirror/state').Extension[]}
 */
export function dndExtension({ onNotice } = {}) {
  return [];
}
