/**
 * editor/preview.js — preview pane (WP-3.3)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. WP-3.3 renders the editor
 * buffer through assets/js/skrender.js into a sandboxed iframe, debounced,
 * with nearest-heading scroll restore across srcdoc replacement and an
 * inline diagnostics panel linking back to editor lines.
 *
 * Stub behaviour: `createPreviewPane` throws — there is no renderer wired up
 * yet. app.js shows a static "Preview lands in M3" placeholder.
 */

const NI = 'WP-3.3: not implemented';

/**
 * @param {{ mount: HTMLElement }} opts
 * @returns {{
 *   render: (args: { content: string, path: string, binding: object|null }) => Promise<void>,
 *   destroy: () => void,
 * }}
 */
export function createPreviewPane({ mount } = {}) {
  throw new Error(NI);
}
