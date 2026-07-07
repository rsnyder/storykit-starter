/**
 * editor/store.js — IndexedDB persistence layer (WP-2.2)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2 — implemented exactly (plus one
 * additive export, `ulid`, flagged in the WP-2.2 handoff notes). DB name
 * "storykit-editor", version 1, via `idb` (esm.sh pin, see
 * docs/dependencies.md). Document record fields per spec FR-DOC.2.
 *
 * ── Schema (IndexedDB object stores) ────────────────────────────────────────
 *   documents   keyPath 'id'         — FR-DOC.2 document records
 *   revisions   keyPath 'id'         — index 'byDoc' on 'docId' (non-unique)
 *                                       record: { id, docId, content, reason,
 *                                       createdAt (ISO string) }
 *   repoCache   out-of-line keys     — value: { etag, content, fetchedAt }
 *                                       key: repoCache.makeKey({owner,repo,ref,path})
 *   entityCache out-of-line keys     — value: { entity, fetchedAt (ms epoch) }
 *                                       key: qid
 *
 * Note on FR-DOC.2's `revisions` field vs. §6.4's separate `revisions` store:
 * the spec lists `revisions` as an array field on the document record *and*
 * as its own IndexedDB store "FK to document" in the architecture table.
 * The frozen §1.2 contract exposes `revisions` as an independent module with
 * its own CRUD (snapshot/list/get/prune) keyed by docId — that is the real,
 * queryable source of truth implemented here (a separate object store, not
 * an array glued onto the document row, so pruning/spacing don't require
 * rewriting the whole document). The document record's `revisions` field is
 * therefore kept present for schema conformance but left as a reserved,
 * unused empty array — logged here rather than decided silently.
 */

import { openDB } from 'idb';

const DB_NAME = 'storykit-editor';
const DB_VERSION = 1;

const REVISION_CAP = 20;
const REVISION_MIN_SPACING_MS = 10 * 60 * 1000; // 10 minutes, FR-DOC.4
const FORCED_SNAPSHOT_REASONS = new Set(['pre-pull', 'pre-conflict', 'pre-restore', 'manual']);

const ENTITY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, §6.4

/** @type {Promise<import('idb').IDBPDatabase>|null} */
let dbPromise = null;

/**
 * Open/upgrade the IndexedDB database. Idempotent — safe to call repeatedly
 * (and safe to skip: every store operation below opens lazily via getDB()).
 * @returns {Promise<void>}
 */
export async function initStore() {
  await getDB();
}

function openDatabase() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('documents')) {
        db.createObjectStore('documents', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('revisions')) {
        const store = db.createObjectStore('revisions', { keyPath: 'id' });
        store.createIndex('byDoc', 'docId');
      }
      if (!db.objectStoreNames.contains('repoCache')) {
        db.createObjectStore('repoCache');
      }
      if (!db.objectStoreNames.contains('entityCache')) {
        db.createObjectStore('entityCache');
      }
    },
  });
}

function getDB() {
  if (!dbPromise) dbPromise = openDatabase();
  return dbPromise;
}

// ── ULID (inline, no dependency added) ──────────────────────────────────────
// docs/editor-plan.md instructs WP-2.2 to implement a small inline ULID
// rather than add an import-map pin (that's integration-WP territory). This
// is a minimal Crockford Base32 encoder: 48-bit timestamp (10 chars) + 80
// bits of randomness (16 chars) = 26 chars, lexicographically sortable by
// creation time. Exported as an additive convenience (not in the frozen
// contract) so tests/callers can validate id shape; flagged in the handoff.
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidEncodeTime(time, length) {
  let t = time;
  let str = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = t % 32;
    str = ULID_ENCODING[mod] + str;
    t = (t - mod) / 32;
  }
  return str;
}

function ulidEncodeRandom(length) {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let str = '';
  for (let i = 0; i < length; i++) str += ULID_ENCODING[bytes[i] % 32];
  return str;
}

/**
 * Minimal inline ULID generator (26-char Crockford Base32: 48-bit time +
 * 80-bit randomness). Additive export, not part of the frozen §1.2 surface.
 * @param {number} [time] ms since epoch; defaults to now.
 * @returns {string}
 */
export function ulid(time = Date.now()) {
  return ulidEncodeTime(time, 10) + ulidEncodeRandom(16);
}

// ── title derivation helper (FR-DOC.2: "derived from front matter title,
//    fallback to filename") ─────────────────────────────────────────────────
function deriveTitle(content, path) {
  if (content) {
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content);
    if (fm) {
      const titleLine = /^title:\s*(.+)\s*$/m.exec(fm[1]);
      if (titleLine) {
        const t = titleLine[1].trim().replace(/^["']|["']$/g, '');
        if (t) return t;
      }
    }
  }
  if (path) {
    const base = path.split('/').pop().replace(/\.md$/i, '');
    if (base) return base;
  }
  return 'Untitled';
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
  /** @returns {Promise<Array<object>>} newest-updated first */
  async list() {
    const db = await getDB();
    const all = await db.getAll('documents');
    return all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  },

  async get(id) {
    const db = await getDB();
    return (await db.get('documents', id)) ?? null;
  },

  /**
   * Fills FR-DOC.2 fields: id (ULID), title, path (nullable), content,
   * createdAt/updatedAt (ISO), github: null. `revisions` field kept as a
   * reserved empty array (see module header note).
   */
  async create({ title, path = null, content = '' } = {}) {
    const db = await getDB();
    const now = new Date().toISOString();
    const record = {
      id: ulid(),
      title: title && title.trim() ? title.trim() : deriveTitle(content, path),
      path: path ?? null,
      content: content ?? '',
      createdAt: now,
      updatedAt: now,
      github: null,
      revisions: [],
    };
    await db.put('documents', record);
    return record;
  },

  /**
   * Patches the record and bumps updatedAt; `id` in patch is ignored.
   * Exception (WP-5.1 integration reconciliation): a patch touching ONLY the
   * `github` sync-metadata field does NOT bump updatedAt — sync bookkeeping is
   * not a content edit, and the local-changes heuristic
   * (`updatedAt > github.syncedAt`) would otherwise depend on the millisecond
   * ordering of two separately-taken timestamps. sync.js anchors
   * `github.syncedAt` to the record's `updatedAt` via such metadata-only
   * patches, making the dirty check exact instead of racy.
   */
  async update(id, patch = {}) {
    const db = await getDB();
    const existing = await db.get('documents', id);
    if (!existing) throw new Error(`docs.update: no document with id "${id}"`);
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    const metadataOnly = keys.length > 0 && keys.every((k) => k === 'github');
    const next = {
      ...existing, ...patch, id: existing.id,
      updatedAt: metadataOnly ? existing.updatedAt : new Date().toISOString(),
    };
    await db.put('documents', next);
    return next;
  },

  /** Removes the document and all of its revisions. */
  async remove(id) {
    const db = await getDB();
    const tx = db.transaction(['documents', 'revisions'], 'readwrite');
    await tx.objectStore('documents').delete(id);
    const revStore = tx.objectStore('revisions');
    let cursor = await revStore.index('byDoc').openCursor(IDBKeyRange.only(id));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  },

  /** Copies a document with a new ULID id and a "(copy)" title suffix. */
  async duplicate(id) {
    const db = await getDB();
    const existing = await db.get('documents', id);
    if (!existing) throw new Error(`docs.duplicate: no document with id "${id}"`);
    const now = new Date().toISOString();
    const copy = {
      ...existing,
      id: ulid(),
      title: `${existing.title} (copy)`,
      createdAt: now,
      updatedAt: now,
      github: null,
      revisions: [],
    };
    await db.put('documents', copy);
    return copy;
  },
};

/**
 * Rolling local revision snapshots (FR-DOC.4): cap 20, ≥10 min spacing.
 *
 * M5 DATA-LOSS INVARIANT (docs/editor-plan.md §1.2, "editor/sync.js"):
 * every buffer-replacing operation (pull that overwrites the local buffer,
 * conflict resolution, restore-from-revision) MUST snapshot before it
 * touches the buffer. Those call sites MUST pass one of the forced reasons
 * below so the snapshot always happens, bypassing the 10-minute throttle
 * that protects against explosive growth during normal active editing.
 *
 * @type {{
 *   snapshot: (docId: string, content: string, reason?: string) => Promise<object|null>,
 *   list: (docId: string) => Promise<Array<object>>,
 *   get: (revId: string) => Promise<object|null>,
 *   prune: (docId: string) => Promise<void>,
 * }}
 */
export const revisions = {
  /**
   * Records a snapshot of `content` for `docId`. Skipped (returns `null`)
   * when the newest existing snapshot for this document is <10 minutes old
   * AND `reason` is not one of the forced kinds: 'pre-pull', 'pre-conflict',
   * 'pre-restore', 'manual' — those ALWAYS snapshot regardless of spacing
   * (see the M5 invariant above). Always prunes to the cap-20 window after
   * a successful write.
   * @returns {Promise<object|null>} the created revision record, or `null`
   *   if skipped due to spacing.
   */
  async snapshot(docId, content, reason) {
    const db = await getDB();
    const forced = FORCED_SNAPSHOT_REASONS.has(reason);
    if (!forced) {
      const existing = await revisions.list(docId); // newest first
      const newest = existing[0];
      if (newest && Date.now() - new Date(newest.createdAt).getTime() < REVISION_MIN_SPACING_MS) {
        return null;
      }
    }
    const record = {
      id: ulid(),
      docId,
      content,
      reason: reason || 'auto',
      createdAt: new Date().toISOString(),
    };
    await db.put('revisions', record);
    await revisions.prune(docId);
    return record;
  },

  /** @returns {Promise<Array<object>>} newest-first */
  async list(docId) {
    const db = await getDB();
    const all = await db.getAllFromIndex('revisions', 'byDoc', docId);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async get(revId) {
    const db = await getDB();
    return (await db.get('revisions', revId)) ?? null;
  },

  /** Keeps only the newest 20 revisions for `docId`; deletes the rest. */
  async prune(docId) {
    const db = await getDB();
    const all = await revisions.list(docId); // newest first
    if (all.length <= REVISION_CAP) return;
    const toDelete = all.slice(REVISION_CAP);
    const tx = db.transaction('revisions', 'readwrite');
    await Promise.all(toDelete.map((r) => tx.store.delete(r.id)));
    await tx.done;
  },
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
  async get(key) {
    const db = await getDB();
    return (await db.get('repoCache', key)) ?? null;
  },

  async put(key, value) {
    const db = await getDB();
    await db.put('repoCache', value, key);
  },

  /** Stable, order-preserving string key: "owner/repo/ref/path". */
  makeKey({ owner, repo, ref, path } = {}) {
    return [owner, repo, ref, path].map((p) => String(p ?? '')).join('/');
  },
};

/**
 * Wikidata entity cache, 30-day TTL enforced on get. Stored internally as
 * { entity, fetchedAt } but `get` returns the bare entity (or null).
 * @type {{
 *   get: (qid: string) => Promise<object|null>,
 *   put: (qid: string, entity: object) => Promise<void>,
 * }}
 */
export const entityCache = {
  async get(qid) {
    const db = await getDB();
    const record = await db.get('entityCache', qid);
    if (!record) return null;
    if (Date.now() - record.fetchedAt > ENTITY_TTL_MS) {
      await db.delete('entityCache', qid); // lazy eviction
      return null;
    }
    return record.entity;
  },

  async put(qid, entity) {
    const db = await getDB();
    await db.put('entityCache', { entity, fetchedAt: Date.now() }, qid);
  },
};

/**
 * Debounced autosaver bound to one document (FR-DOC.3: debounce ≤ 2 s,
 * flush on visibilitychange/pagehide — those listeners are registered here,
 * so the app only needs to call `createAutosaver` once per open document;
 * WP-2.6 should call `dispose()` when switching/closing documents to avoid
 * leaking listeners).
 *
 * `flush()` is "synchronous-best-effort": IndexedDB has no true synchronous
 * write path, so on pagehide/visibilitychange we fire the write immediately
 * (without awaiting anything first) and let the browser's grace period
 * finish it; this is why `push`→timer→`writeNow` is a single read-modify-
 * write against the `documents` store with no intermediate async hops.
 *
 * @param {string} docId
 * @param {{ debounceMs?: number }} [opts]
 * @returns {{ push: (content: string) => void, flush: () => Promise<void>, dispose: () => void }}
 */
export function createAutosaver(docId, { debounceMs = 1500 } = {}) {
  let latestContent = null;
  let timer = null;
  let pending = Promise.resolve();

  async function writeNow() {
    if (latestContent === null) return;
    const content = latestContent;
    latestContent = null;
    await docs.update(docId, { content });
  }

  function push(content) {
    latestContent = content;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      pending = writeNow().catch((err) => {
        console.error('[storykit-editor] autosave failed', err);
      });
    }, debounceMs);
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await writeNow();
    await pending;
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = () => {
    flush();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
  }

  /** Additive extra: detaches the visibilitychange/pagehide listeners. */
  function dispose() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPageHide);
    }
  }

  return { push, flush, dispose };
}

/**
 * Request durable storage (FR-DOC.8). Wraps navigator.storage.persist().
 * @returns {Promise<boolean>}
 */
export async function requestPersistence() {
  if (typeof navigator === 'undefined' || !navigator.storage
      || typeof navigator.storage.persist !== 'function') {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
