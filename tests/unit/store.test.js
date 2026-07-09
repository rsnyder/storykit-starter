// tests/unit/store.test.js  (WP-2.2)
//
// Unit tests for editor/store.js — the IndexedDB persistence layer per
// docs/editor-plan.md §1.2 and docs/editor-spec.md FR-DOC.2/3/4/8.
//
// Hermeticity: tools/run_browser_tests.py launches a fresh Chromium
// instance with a fresh (in-memory, non-persistent) browser context per
// invocation, so IndexedDB starts empty on every run of the suite — no
// indexedDB.deleteDatabase() dance is needed between runs. Within a single
// page load, tests share the one "storykit-editor" database (store.js is a
// singleton module), so every test creates its own document(s) via
// docs.create() (fresh ULID per call) rather than relying on a clean slate.
//
// Some tests need revisions/entity-cache rows with crafted timestamps (to
// exercise the ≥10-minute spacing rule and the 30-day TTL without actually
// sleeping the test for minutes/days). Rather than adding a private `_now`
// parameter to the frozen snapshot()/get() signatures, these tests reach
// into the database directly with `idb`'s `openDB` (same DB name/version
// store.js uses — documented in the store.js module header) and write rows
// by hand, exactly as docs/editor-plan.md's WP-2.2 brief allows ("write
// records directly for setup").
import { openDB } from 'idb';
import { describe, it, assert } from './runner.js';
import {
  initStore, docs, revisions, repoCache, entityCache, createAutosaver,
  requestPersistence, ulid,
} from '../../editor/store.js';

const DB_NAME = 'storykit-editor';
const DB_VERSION = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── initStore / requestPersistence ──────────────────────────────────────────
describe('store: initStore / requestPersistence', () => {
  it('initStore resolves without throwing and is idempotent', async () => {
    await initStore();
    await initStore();
    assert.ok(true);
  });

  it('requestPersistence resolves to a boolean', async () => {
    const result = await requestPersistence();
    assert.equal(typeof result, 'boolean');
  });
});

// ── docs: CRUD + duplicate ───────────────────────────────────────────────────
describe('store: docs CRUD + duplicate (FR-DOC.2)', () => {
  it('create fills the FR-DOC.2 field set', async () => {
    const doc = await docs.create({ title: 'Hello', path: '_posts/2026-07-06-hello.md', content: '# hi' });
    assert.equal(typeof doc.id, 'string');
    assert.equal(doc.id.length, 26, 'id should be a 26-char ULID');
    assert.equal(doc.title, 'Hello');
    assert.equal(doc.path, '_posts/2026-07-06-hello.md');
    assert.equal(doc.content, '# hi');
    assert.ok(doc.createdAt && doc.updatedAt, 'createdAt/updatedAt should be set');
    assert.equal(doc.createdAt, doc.updatedAt, 'createdAt === updatedAt on creation');
    assert.equal(doc.github, null);
    assert.deepEqual(doc.revisions, []);
    assert.deepEqual(
      Object.keys(doc).sort(),
      ['content', 'createdAt', 'github', 'id', 'path', 'revisions', 'title', 'updatedAt'].sort(),
    );
  });

  it('create defaults path to null and content to "" when omitted', async () => {
    const doc = await docs.create({ title: 'Bare' });
    assert.equal(doc.path, null);
    assert.equal(doc.content, '');
  });

  it('create derives the title from front-matter when no title is given', async () => {
    const doc = await docs.create({ content: '---\ntitle: "My Post"\n---\nbody' });
    assert.equal(doc.title, 'My Post');
  });

  it('create falls back to the filename when there is no title or front matter', async () => {
    const doc = await docs.create({ path: '_posts/x.md', content: 'no front matter here' });
    assert.equal(doc.title, 'x');
  });

  it('create falls back to "Untitled" with nothing to derive from', async () => {
    const doc = await docs.create({});
    assert.equal(doc.title, 'Untitled');
  });

  it('get returns null for a missing id', async () => {
    assert.equal(await docs.get('does-not-exist'), null);
  });

  it('get roundtrips a created document', async () => {
    const created = await docs.create({ title: 'Roundtrip' });
    const got = await docs.get(created.id);
    assert.deepEqual(got, created);
  });

  it('list returns documents newest-updated first', async () => {
    const a = await docs.create({ title: 'A' });
    await sleep(10);
    const b = await docs.create({ title: 'B' });
    const list = await docs.list();
    const ai = list.findIndex((d) => d.id === a.id);
    const bi = list.findIndex((d) => d.id === b.id);
    assert.ok(ai !== -1 && bi !== -1, 'both docs should be present');
    assert.ok(bi < ai, 'the more recently updated doc should sort first');
  });

  it('update patches fields and bumps updatedAt', async () => {
    const doc = await docs.create({ title: 'orig' });
    await sleep(10);
    const updated = await docs.update(doc.id, { title: 'changed' });
    assert.equal(updated.id, doc.id);
    assert.equal(updated.title, 'changed');
    assert.ok(updated.updatedAt > doc.updatedAt, 'updatedAt should advance past createdAt');
    assert.equal(updated.createdAt, doc.createdAt, 'createdAt is immutable across updates');
  });

  it('update rejects for an unknown id', async () => {
    await assert.rejects(() => docs.update('nope', { title: 'x' }), /no document/i);
  });

  it('remove deletes the document', async () => {
    const doc = await docs.create({ title: 'to remove' });
    await docs.remove(doc.id);
    assert.equal(await docs.get(doc.id), null);
  });

  it('remove also deletes the document\'s revisions', async () => {
    const doc = await docs.create({ title: 'with revisions' });
    await revisions.snapshot(doc.id, 'v1', 'manual');
    assert.equal((await revisions.list(doc.id)).length, 1);
    await docs.remove(doc.id);
    assert.deepEqual(await revisions.list(doc.id), []);
  });

  it('duplicate copies content with a new id and a "(copy)" title suffix', async () => {
    const doc = await docs.create({ title: 'Original', path: '_posts/o.md', content: 'body text' });
    const dup = await docs.duplicate(doc.id);
    assert.ok(dup.id !== doc.id, 'duplicate must get a new id');
    assert.equal(dup.title, 'Original (copy)');
    assert.equal(dup.content, 'body text');
    assert.equal(dup.path, '_posts/o.md');
    assert.equal(dup.github, null, 'duplicate is not synced to the original\'s remote');
    // Original is untouched.
    assert.equal((await docs.get(doc.id)).title, 'Original');
  });

  it('duplicate rejects for an unknown id', async () => {
    await assert.rejects(() => docs.duplicate('nope'), /no document/i);
  });
});

// ── revisions: spacing, forced reasons, prune cap (FR-DOC.4) ────────────────
describe('store: revisions spacing + forced reasons + prune cap (FR-DOC.4)', () => {
  it('the first snapshot for a document is always recorded', async () => {
    const doc = await docs.create({ title: 'rev doc 1' });
    const rec = await revisions.snapshot(doc.id, 'content v1');
    assert.ok(rec && rec.id, 'expected a revision record, not a skip');
    assert.equal(rec.docId, doc.id);
    assert.equal(rec.content, 'content v1');
    assert.equal(rec.reason, 'auto');
  });

  it('a second non-forced snapshot within 10 minutes is skipped', async () => {
    const doc = await docs.create({ title: 'rev doc 2' });
    await revisions.snapshot(doc.id, 'v1');
    const second = await revisions.snapshot(doc.id, 'v2');
    assert.equal(second, null, 'snapshot() should return null when skipped for spacing');
    const list = await revisions.list(doc.id);
    assert.equal(list.length, 1, 'the skipped snapshot must not have been written');
  });

  it('forced reasons (pre-pull/pre-conflict/pre-restore/manual) always snapshot', async () => {
    const doc = await docs.create({ title: 'rev doc 3' });
    await revisions.snapshot(doc.id, 'v0');
    for (const reason of ['pre-pull', 'pre-conflict', 'pre-restore', 'manual']) {
      const rec = await revisions.snapshot(doc.id, `content-${reason}`, reason);
      assert.ok(rec, `forced snapshot for reason "${reason}" must not be skipped`);
      assert.equal(rec.reason, reason);
    }
    const list = await revisions.list(doc.id);
    assert.equal(list.length, 5, '1 initial + 4 forced snapshots');
  });

  it('a non-forced snapshot ≥10 minutes after the newest one is recorded', async () => {
    const doc = await docs.create({ title: 'rev doc 4' });
    // Seed an "old" revision directly, simulating 11 elapsed minutes
    // without sleeping the test for 11 real minutes.
    const db = await openDB(DB_NAME, DB_VERSION);
    const oldCreatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await db.put('revisions', {
      id: 'seed-old-rev', docId: doc.id, content: 'old', reason: 'auto', createdAt: oldCreatedAt,
    });
    const rec = await revisions.snapshot(doc.id, 'fresh content');
    assert.ok(rec, 'snapshot should succeed once the newest revision is old enough');
    const list = await revisions.list(doc.id);
    assert.equal(list.length, 2);
    assert.equal(list[0].content, 'fresh content', 'list() is newest-first');
  });

  it('prune keeps only the newest 20 revisions', async () => {
    const doc = await docs.create({ title: 'rev doc prune' });
    const db = await openDB(DB_NAME, DB_VERSION);
    const base = Date.now() - 25 * 60 * 60 * 1000; // spaced an hour apart, well past the spacing window
    for (let i = 0; i < 25; i++) {
      await db.put('revisions', {
        id: `seed-prune-${i}`,
        docId: doc.id,
        content: `v${i}`,
        reason: 'auto',
        createdAt: new Date(base + i * 60 * 60 * 1000).toISOString(),
      });
    }
    await revisions.prune(doc.id);
    const list = await revisions.list(doc.id);
    assert.equal(list.length, 20, 'prune should cap at 20');
    assert.equal(list[0].content, 'v24', 'newest kept');
    assert.equal(list[19].content, 'v5', 'oldest surviving is the 20th-newest');
  });

  it('snapshot() self-prunes: writing past the cap trims older rows', async () => {
    const doc = await docs.create({ title: 'rev doc self-prune' });
    const db = await openDB(DB_NAME, DB_VERSION);
    const base = Date.now() - 21 * 60 * 60 * 1000;
    for (let i = 0; i < 20; i++) {
      await db.put('revisions', {
        id: `seed-self-prune-${i}`,
        docId: doc.id,
        content: `v${i}`,
        reason: 'auto',
        createdAt: new Date(base + i * 60 * 60 * 1000).toISOString(),
      });
    }
    assert.equal((await revisions.list(doc.id)).length, 20);
    await revisions.snapshot(doc.id, 'v20', 'manual');
    const list = await revisions.list(doc.id);
    assert.equal(list.length, 20, 'the new snapshot should push the total back down to 20');
    assert.equal(list[0].content, 'v20');
    assert.ok(!list.some((r) => r.content === 'v0'), 'the oldest row should have been pruned');
  });

  it('get returns null for a missing revision id', async () => {
    assert.equal(await revisions.get('does-not-exist'), null);
  });

  it('get roundtrips a snapshot', async () => {
    const doc = await docs.create({ title: 'rev doc get' });
    const rec = await revisions.snapshot(doc.id, 'content');
    const got = await revisions.get(rec.id);
    assert.deepEqual(got, rec);
  });
});

// ── repoCache ────────────────────────────────────────────────────────────────
describe('store: repoCache (makeKey stability + get/put)', () => {
  it('makeKey is stable for identical inputs', () => {
    const parts = { owner: 'acme', repo: 'blog', ref: 'main', path: '_posts/a.md' };
    assert.equal(repoCache.makeKey(parts), repoCache.makeKey({ ...parts }));
  });

  it('makeKey differs when any part differs', () => {
    const base = { owner: 'acme', repo: 'blog', ref: 'main', path: '_posts/a.md' };
    const variants = [
      { ...base, owner: 'other' },
      { ...base, repo: 'other' },
      { ...base, ref: 'dev' },
      { ...base, path: '_posts/b.md' },
    ];
    const baseKey = repoCache.makeKey(base);
    for (const v of variants) {
      assert.ok(repoCache.makeKey(v) !== baseKey, `expected a distinct key for ${JSON.stringify(v)}`);
    }
  });

  it('put then get roundtrips a cache entry', async () => {
    const key = repoCache.makeKey({ owner: 'acme', repo: 'blog', ref: 'main', path: '_includes/embed/image.html' });
    const value = { etag: 'abc123', content: '<div></div>', fetchedAt: Date.now() };
    await repoCache.put(key, value);
    assert.deepEqual(await repoCache.get(key), value);
  });

  it('get returns null for a missing key', async () => {
    assert.equal(await repoCache.get('never/put/this/key'), null);
  });
});

// ── entityCache: 30-day TTL enforced on get ─────────────────────────────────
describe('store: entityCache 30-day TTL (§6.4)', () => {
  it('put then get roundtrips a fresh entity', async () => {
    await entityCache.put('Q42', { label: 'Douglas Adams' });
    assert.deepEqual(await entityCache.get('Q42'), { label: 'Douglas Adams' });
  });

  it('get returns null for a missing qid', async () => {
    assert.equal(await entityCache.get('Q999999999'), null);
  });

  it('get evicts and returns null for an entry older than 30 days', async () => {
    const db = await openDB(DB_NAME, DB_VERSION);
    const stale = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await db.put('entityCache', { entity: { label: 'Stale' }, fetchedAt: stale }, 'Q7');
    assert.equal(await entityCache.get('Q7'), null, 'stale entry should read back as null');
    const raw = await db.get('entityCache', 'Q7');
    assert.equal(raw, undefined, 'get() should have lazily deleted the stale row');
  });

  it('get keeps an entry just under the TTL boundary', async () => {
    const db = await openDB(DB_NAME, DB_VERSION);
    const almostStale = Date.now() - (30 * 24 * 60 * 60 * 1000 - 60_000); // 30d minus 1min
    await db.put('entityCache', { entity: { label: 'Fresh enough' }, fetchedAt: almostStale }, 'Q8');
    assert.deepEqual(await entityCache.get('Q8'), { label: 'Fresh enough' });
  });
});

// ── createAutosaver: debounce + flush (FR-DOC.3) ────────────────────────────
describe('store: createAutosaver debounce + flush (FR-DOC.3)', () => {
  it('push debounces the write until debounceMs has elapsed', async () => {
    const doc = await docs.create({ title: 'autosave doc 1', content: 'initial' });
    const saver = createAutosaver(doc.id, { debounceMs: 50 });
    try {
      saver.push('typed content 1');
      assert.equal((await docs.get(doc.id)).content, 'initial', 'write should not land before the debounce fires');
      await sleep(150);
      assert.equal((await docs.get(doc.id)).content, 'typed content 1');
    } finally {
      saver.dispose();
    }
  });

  it('rapid pushes coalesce into a single write of the latest content', async () => {
    const doc = await docs.create({ title: 'autosave doc 2', content: '' });
    const saver = createAutosaver(doc.id, { debounceMs: 50 });
    try {
      saver.push('a');
      saver.push('ab');
      saver.push('abc');
      await sleep(150);
      assert.equal((await docs.get(doc.id)).content, 'abc');
    } finally {
      saver.dispose();
    }
  });

  it('flush() writes immediately, without waiting for the debounce window', async () => {
    const doc = await docs.create({ title: 'autosave doc 3', content: '' });
    const saver = createAutosaver(doc.id, { debounceMs: 5000 });
    try {
      saver.push('urgent content');
      await saver.flush();
      assert.equal((await docs.get(doc.id)).content, 'urgent content');
    } finally {
      saver.dispose();
    }
  });

  it('flush() is a no-op when nothing has been pushed', async () => {
    const doc = await docs.create({ title: 'autosave doc 4', content: 'stable' });
    const saver = createAutosaver(doc.id, { debounceMs: 50 });
    try {
      await saver.flush();
      assert.equal((await docs.get(doc.id)).content, 'stable');
    } finally {
      saver.dispose();
    }
  });

  it('dispose() detaches listeners and is idempotent', async () => {
    const doc = await docs.create({ title: 'autosave doc 5' });
    const saver = createAutosaver(doc.id, { debounceMs: 50 });
    saver.dispose();
    saver.dispose(); // must not throw the second time
    assert.ok(true);
  });
});

// ── ulid: additive helper (not in the frozen §1.2 surface, flagged in the WP-2.2 handoff) ──
describe('store: ulid (additive export)', () => {
  it('produces a 26-character Crockford Base32 string', () => {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.ok(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id), `unexpected ulid shape: ${id}`);
  });

  it('sorts lexicographically by the timestamp it was generated for', () => {
    const earlier = ulid(1_000_000);
    const later = ulid(2_000_000);
    assert.ok(earlier < later, 'a ulid for an earlier timestamp should sort before a later one');
  });
});

describe('store: sample flag lifecycle', () => {
  it('create honors sample:true; duplicate strips it (the copy is the author\'s own)', async () => {
    const rec = await docs.create({ title: 'W', content: 'x', sample: true });
    try {
      assert.equal(rec.sample, true);
      const plain = await docs.create({ title: 'P', content: 'y' });
      assert.equal('sample' in plain, false, 'absent unless requested');
      const copy = await docs.duplicate(rec.id);
      assert.equal('sample' in copy, false, 'duplicate is a normal document');
      await docs.remove(plain.id);
      await docs.remove(copy.id);
    } finally {
      await docs.remove(rec.id);
    }
  });
});
