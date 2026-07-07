/**
 * editor/store.js — IndexedDB persistence layer (WP-2.2)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. This scaffold file (WP-2.1)
 * provides the export shapes only; every storage operation throws the
 * not-implemented marker until WP-2.2 lands the real implementation.
 * DB name "storykit-editor", version 1 (idb). Document record fields per
 * spec FR-DOC.2 (ULID ids).
 *
 * Stub behaviour: all storage operations THROW `new Error('WP-2.2: not
 * implemented')` — a stub must never silently pretend to persist, or a
 * caller would lose data believing it was saved.
 */

const NI = 'WP-2.2: not implemented';

/** Open/upgrade the IndexedDB database. Idempotent. @returns {Promise<void>} */
export async function initStore() {
  throw new Error(NI);
}

/**
 * Document CRUD. All ids are ULIDs (FR-DOC.2).
 * @type {{
 *   list: () => Promise<Array<object>>,
 *   get: (id: string) => Promise<object|null>,
 *   create: (init: { title?: string, path?: string|null, content?: string }) => Promise<object>,
 *   update: (id: string, patch: object) => Promise<object>,
 *   remove: (id: string) => Promise<void>,
 *   duplicate: (id: string) => Promise<object>,
 * }}
 */
export const docs = {
  async list() { throw new Error(NI); },
  async get(id) { throw new Error(NI); },
  async create({ title, path, content } = {}) { throw new Error(NI); },
  async update(id, patch) { throw new Error(NI); },
  async remove(id) { throw new Error(NI); },
  async duplicate(id) { throw new Error(NI); },
};

/**
 * Rolling local revision snapshots (FR-DOC.4): cap 20, ≥10 min spacing.
 * @type {{
 *   snapshot: (docId: string, content: string, reason?: string) => Promise<object>,
 *   list: (docId: string) => Promise<Array<object>>,
 *   get: (revId: string) => Promise<object|null>,
 *   prune: (docId: string) => Promise<void>,
 * }}
 */
export const revisions = {
  async snapshot(docId, content, reason) { throw new Error(NI); },
  async list(docId) { throw new Error(NI); },
  async get(revId) { throw new Error(NI); },
  async prune(docId) { throw new Error(NI); },
};

/**
 * Fetched includes/layouts/config keyed by {owner,repo,ref,path} + ETag.
 * @type {{
 *   get: (key: string) => Promise<{ etag: string, content: string, fetchedAt: number }|null>,
 *   put: (key: string, value: { etag: string, content: string, fetchedAt: number }) => Promise<void>,
 *   makeKey: (parts: { owner: string, repo: string, ref: string, path: string }) => string,
 * }}
 */
export const repoCache = {
  async get(key) { throw new Error(NI); },
  async put(key, value) { throw new Error(NI); },
  makeKey({ owner, repo, ref, path } = {}) { throw new Error(NI); },
};

/**
 * Wikidata entity cache, 30-day TTL enforced on get.
 * @type {{
 *   get: (qid: string) => Promise<object|null>,
 *   put: (qid: string, entity: object) => Promise<void>,
 * }}
 */
export const entityCache = {
  async get(qid) { throw new Error(NI); },
  async put(qid, entity) { throw new Error(NI); },
};

/**
 * Debounced autosaver bound to one document. `flush` is wired by the app to
 * `visibilitychange`/`pagehide` (FR-DOC.3).
 * @param {string} docId
 * @param {{ debounceMs?: number }} [opts]
 * @returns {{ push: (content: string) => void, flush: () => Promise<void> }}
 */
export function createAutosaver(docId, { debounceMs = 1500 } = {}) {
  throw new Error(NI);
}

/**
 * Request durable storage (FR-DOC.8). Wraps navigator.storage.persist().
 * @returns {Promise<boolean>}
 */
export async function requestPersistence() {
  throw new Error(NI);
}
