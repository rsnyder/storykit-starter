/**
 * editor/context.js — skrender context builder + repo cache (WP-3.2)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. Builds a context in the
 * assets/js/skrender.js shape. resolveFile chain: repoCache (ETag
 * revalidate) → GitHub (bound) | deployed starter defaults (unbound) →
 * miss-cache.
 *
 * Stub behaviour: `buildContext` throws the marker.
 */

const NI = 'WP-3.2: not implemented';

/**
 * @param {{ binding: { owner: string, repo: string, branch: string } | null }} args
 * @returns {Promise<{
 *   config: object,
 *   locales: object|null,
 *   layouts: Map<string, { frontMatter: object, body: string }>,
 *   includes: Map<string, string>,
 *   resolveFile: (repoRelPath: string) => Promise<string|null>,
 *   assetOrigin: string,
 *   baseurl: string,
 * }>}
 */
export async function buildContext({ binding } = {}) {
  throw new Error(NI);
}
