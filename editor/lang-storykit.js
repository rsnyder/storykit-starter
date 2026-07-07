/**
 * editor/lang-storykit.js — StoryKit/Liquid CM6 language extension (WP-2.4)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. WP-2.4 builds highlighting
 * (FR-EDIT.2), autocomplete (FR-EDIT.3), lint (FR-EDIT.4), QID decoration
 * (FR-EDIT.5) and front-matter YAML diagnostics (FR-EDIT.7). The Wikidata
 * label resolver is injected later by wikidata.js (WP-4.2).
 *
 * Stub behaviour: returns an INERT empty extension array so the editor can
 * compose it today without behaviour change — nothing highlights/lints yet,
 * but `EditorState.create` accepts the result.
 */

/**
 * @param {{
 *   catalog: object,
 *   getIncludeList: () => string[],
 *   getDocViewerIds: () => string[],
 * }} deps
 * @returns {import('@codemirror/state').Extension[]}
 */
export function storykit({ catalog, getIncludeList, getDocViewerIds } = {}) {
  return [];
}
