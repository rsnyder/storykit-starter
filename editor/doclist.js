/**
 * editor/doclist.js — document list panel (WP-2.5)
 *
 * NOT frozen in docs/editor-plan.md §1.2. PROVISIONAL shape for the scaffold;
 * WP-2.5 owns the final contract. Scope (spec FR-DOC.5/6/7): document list
 * panel + actions, new-from-template (fallbackTemplate when unbound) +
 * `yyyy-mm-dd-slug.md` generation, import/export.
 *
 * Stub behaviour: `createDocList` throws — it would otherwise mount live UI
 * backed by the (also-stubbed) store. app.js renders a static empty-state
 * placeholder in the sidebar until WP-2.5 lands.
 */

const NI = 'WP-2.5: not implemented';

/**
 * @param {{ mount: HTMLElement }} opts
 * @returns {{ refresh: () => Promise<void>, destroy: () => void }}
 */
export function createDocList({ mount } = {}) {
  throw new Error(NI);
}
