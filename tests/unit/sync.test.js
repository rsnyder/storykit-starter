// tests/unit/sync.test.js  (WP-5.1)
//
// Unit tests for editor/sync.js (bind/commit/pull/checkRemote workflows,
// FR-GH.2/3/4/5/6) and editor/statusbar.js (five-state badge + event-driven
// status surfaces).
//
// ── Seams ────────────────────────────────────────────────────────────────
// sync.js exposes an additive `_deps` object (documented in its header — not
// part of any frozen contract): { github, store, resolveConflict, emit,
// bridge }. Tests swap `github` for an in-memory fake (reusing the REAL
// GitHubError class so `kind` mapping stays honest), `resolveConflict` for a
// scripted chooser that honors the beforeResolve contract (awaits it before
// resolving — exactly what WP-5.2's dialog does), `emit` for a recorder, and
// `store` for a delegating wrapper around the REAL IndexedDB store that logs
// every docs.update / revisions.snapshot into a shared ordered call log.
//
// ── The M5 data-loss invariant, tested as ORDERING ───────────────────────
// Every buffer-replacing path (pull-overwrite, conflict take-remote, bind
// adopt-remote) must complete a revisions.snapshot with a FORCED reason
// ('pre-pull' / 'pre-conflict') BEFORE any replacement (docs.update carrying
// new content, or bridge.replaceBuffer). The shared call log records events
// in execution order; assertions compare log indices, not mere existence.

window.__SK_NO_AUTOBOOT = true;

import { describe, it, assert } from './runner.js';
import * as sync from '../../editor/sync.js';
import { initStore, docs, revisions } from '../../editor/store.js';
import { GitHubError } from '../../editor/github.js';
import { createStatusBar } from '../../editor/statusbar.js';

await initStore();

const { _deps } = sync;

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Run `fn` with _deps fields swapped, always restoring. Builds:
 *  - log:    ordered call log ['snapshot:pre-pull', 'update', 'replaceBuffer', …]
 *  - events: recorded emits [{type, detail}]
 *  - store wrapper delegating to the real store, logging update/snapshot
 */
async function withSyncEnv({ github, resolveConflict, bridge } = {}, fn) {
  const log = [];
  const events = [];

  const storeWrapper = {
    docs: {
      ...docs,
      get: (id) => docs.get(id),
      update: async (id, patch) => {
        const result = await docs.update(id, patch);
        log.push('update');
        return result;
      },
    },
    revisions: {
      ...revisions,
      snapshot: async (docId, content, reason) => {
        const result = await revisions.snapshot(docId, content, reason);
        log.push(`snapshot:${reason}`);
        return result;
      },
    },
  };

  const saved = {
    github: _deps.github,
    store: _deps.store,
    resolveConflict: _deps.resolveConflict,
    emit: _deps.emit,
    bridge: _deps.bridge,
  };

  _deps.github = github || saved.github;
  _deps.store = storeWrapper;
  if (resolveConflict) _deps.resolveConflict = resolveConflict;
  _deps.emit = (type, detail) => { events.push({ type, detail }); };
  _deps.bridge = bridge
    ? {
        getLocalContent: bridge.getLocalContent || (() => null),
        replaceBuffer: (docId, content) => {
          log.push('replaceBuffer');
          if (bridge.replaceBuffer) bridge.replaceBuffer(docId, content);
        },
      }
    : null;

  try {
    return await fn({ log, events });
  } finally {
    Object.assign(_deps, saved);
  }
}

/**
 * In-memory fake GitHub client. `files` maps path → {content, sha}; sha
 * bumps on every put. Configurable failures via `fail` ({methodName: err}).
 * Reuses the real GitHubError so sync.js's kind mapping is exercised honestly.
 */
function fakeGitHub({ files = {}, branches = ['main'], defaultBranch = 'main', fail = {} } = {}) {
  let shaCounter = 100;
  const state = {
    files: { ...files },
    branches: [...branches],
    calls: [],
  };
  const maybeFail = (method) => {
    if (fail[method]) throw fail[method];
  };
  const api = {
    GitHubError,
    _state: state,
    async getRepo({ owner, repo }) {
      state.calls.push(['getRepo', { owner, repo }]);
      maybeFail('getRepo');
      return { full_name: `${owner}/${repo}`, default_branch: defaultBranch };
    },
    async listBranches() {
      state.calls.push(['listBranches']);
      maybeFail('listBranches');
      return state.branches.map((name) => ({ name }));
    },
    async getBranchHead({ branch }) {
      state.calls.push(['getBranchHead', { branch }]);
      maybeFail('getBranchHead');
      return { sha: `head-of-${branch}` };
    },
    async createBranch({ name, fromSha }) {
      state.calls.push(['createBranch', { name, fromSha }]);
      maybeFail('createBranch');
      state.branches.push(name);
      return { sha: fromSha, ref: `refs/heads/${name}` };
    },
    async getFile({ path, etag }) {
      state.calls.push(['getFile', { path, etag }]);
      maybeFail('getFile');
      const f = state.files[path];
      if (!f) return null;
      if (etag && etag === f.etag) return 'not-modified';
      return { content: f.content, sha: f.sha, etag: f.etag || `W/"${f.sha}"` };
    },
    async putFile({ path, content, sha, message, branch }) {
      state.calls.push(['putFile', { path, content, sha, message, branch }]);
      maybeFail('putFile');
      const existing = state.files[path];
      if (existing && existing.sha !== sha) {
        throw new GitHubError('GitHub API error (409): sha mismatch', { status: 409, kind: 'conflict' });
      }
      if (!existing && sha) {
        throw new GitHubError('GitHub API error (422): sha provided for new file', { status: 422, kind: 'conflict' });
      }
      const newSha = `sha-${++shaCounter}`;
      state.files[path] = { content, sha: newSha, etag: `W/"${newSha}"` };
      return { sha: newSha };
    },
  };
  return api;
}

/** A scripted conflict resolver honoring the beforeResolve contract. */
function scriptedResolver(choice, record = {}) {
  return async ({ local, remote, beforeResolve }) => {
    record.called = true;
    record.local = local;
    record.remote = remote;
    record.hadBeforeResolve = typeof beforeResolve === 'function';
    if (beforeResolve) await beforeResolve(); // the WP-5.2 dialog MUST do this
    if (choice === 'cancel') {
      const err = new Error('conflict resolution cancelled');
      err.name = 'ConflictCancelled';
      throw err;
    }
    return choice;
  };
}

function lastStatus(events) {
  const list = events.filter((e) => e.type === 'sync:status');
  return list.length ? list[list.length - 1].detail : null;
}

function toasts(events) {
  return events.filter((e) => e.type === 'toast').map((e) => e.detail);
}

async function makeDoc(content, extra = {}) {
  const record = await docs.create({ title: 'Sync test', path: '_posts/2026-07-07-sync.md', content });
  if (Object.keys(extra).length) return docs.update(record.id, extra);
  return record;
}

const BOUND = { owner: 'o', repo: 'r', branch: 'draft', path: '_posts/2026-07-07-sync.md' };

function boundGithubField({ sha = 'sha-1', syncedAt = new Date().toISOString(), etag, remoteChanged } = {}) {
  const gh = { owner: BOUND.owner, repo: BOUND.repo, branch: BOUND.branch, sha, syncedAt };
  if (etag !== undefined) gh.etag = etag;
  if (remoteChanged !== undefined) gh.remoteChanged = remoteChanged;
  return gh;
}

// ═══════════════════════════════════════════════════════════════════════════
// bindDocument (FR-GH.2)
// ═══════════════════════════════════════════════════════════════════════════

describe('sync: bindDocument (FR-GH.2)', () => {
  it('binds to an existing branch + missing file: sha null, first commit creates', async () => {
    const doc = await makeDoc('# local draft\n');
    const gh = fakeGitHub({ branches: ['main', 'draft'] });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      const saved = await sync.bindDocument(doc.id, BOUND);
      assert.equal(saved.github.owner, 'o');
      assert.equal(saved.github.branch, 'draft');
      assert.equal(saved.github.sha, null, 'missing remote file leaves sha null');
      assert.equal(saved.path, BOUND.path);
      // No branch creation when it already exists.
      assert.ok(!gh._state.calls.some(([m]) => m === 'createBranch'));
      const st = lastStatus(events);
      assert.equal(st.state, 'local-changes', 'bound-not-committed reads local-changes');
      assert.deepEqual(st.binding, { owner: 'o', repo: 'r', branch: 'draft', path: BOUND.path });
    });
  });

  it('creates a missing branch from the default branch head', async () => {
    const doc = await makeDoc('# local\n');
    const gh = fakeGitHub({ branches: ['main'], defaultBranch: 'main' });
    await withSyncEnv({ github: gh }, async () => {
      await sync.bindDocument(doc.id, BOUND);
      const create = gh._state.calls.find(([m]) => m === 'createBranch');
      assert.ok(create, 'createBranch called');
      assert.equal(create[1].name, 'draft');
      assert.equal(create[1].fromSha, 'head-of-main', 'branched from the default head');
    });
  });

  it('adopts the remote sha silently when local content equals remote', async () => {
    const doc = await makeDoc('same\n');
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'same\n', sha: 'sha-R' } } });
    await withSyncEnv({ github: gh }, async ({ events, log }) => {
      const saved = await sync.bindDocument(doc.id, BOUND);
      assert.equal(saved.github.sha, 'sha-R');
      assert.equal(lastStatus(events).state, 'synced');
      assert.ok(!log.some((l) => l.startsWith('snapshot')), 'no conflict snapshot needed');
    });
  });

  it('empty local + existing remote: snapshots BEFORE adopting remote content', async () => {
    const doc = await makeDoc('   \n');
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'remote body\n', sha: 'sha-R' } } });
    await withSyncEnv({ github: gh }, async ({ log }) => {
      const saved = await sync.bindDocument(doc.id, BOUND);
      assert.equal(saved.content, 'remote body\n');
      assert.equal(saved.github.sha, 'sha-R');
      const snapIdx = log.indexOf('snapshot:pre-conflict');
      const updIdx = log.indexOf('update');
      assert.ok(snapIdx !== -1, 'pre-conflict snapshot taken');
      assert.ok(updIdx !== -1 && snapIdx < updIdx, `snapshot must precede replacement (log: ${log.join(',')})`);
    });
  });

  it('differing non-empty local surfaces the choice; "remote" adopts after snapshot', async () => {
    const doc = await makeDoc('mine\n');
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'theirs\n', sha: 'sha-R' } } });
    const rec = {};
    await withSyncEnv(
      { github: gh, resolveConflict: scriptedResolver('remote', rec), bridge: {} },
      async ({ log, events }) => {
        const saved = await sync.bindDocument(doc.id, BOUND);
        assert.ok(rec.called && rec.hadBeforeResolve, 'resolveConflict got beforeResolve');
        assert.equal(rec.local, 'mine\n');
        assert.equal(rec.remote, 'theirs\n');
        assert.equal(saved.content, 'theirs\n');
        assert.equal(saved.github.sha, 'sha-R');
        // Invariant ordering: snapshot before BOTH replacement paths.
        const snapIdx = log.indexOf('snapshot:pre-conflict');
        assert.ok(snapIdx !== -1);
        assert.ok(snapIdx < log.indexOf('replaceBuffer'), `snapshot before buffer replace (log: ${log.join(',')})`);
        assert.ok(snapIdx < log.indexOf('update'), `snapshot before store update (log: ${log.join(',')})`);
        // A transient conflict badge was surfaced while the dialog was open.
        assert.ok(events.some((e) => e.type === 'sync:status' && e.detail.state === 'conflict'));
        assert.equal(lastStatus(events).state, 'synced');
      }
    );
  });

  it('differing local, "mine": keeps local content, records remote sha, local-changes', async () => {
    const doc = await makeDoc('mine\n');
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'theirs\n', sha: 'sha-R' } } });
    await withSyncEnv({ github: gh, resolveConflict: scriptedResolver('mine') }, async ({ events }) => {
      const saved = await sync.bindDocument(doc.id, BOUND);
      assert.equal(saved.content, 'mine\n', 'local content untouched');
      assert.equal(saved.github.sha, 'sha-R', 'remote sha recorded for the overwrite commit');
      assert.equal(saved.github.syncedAt, null);
      assert.equal(lastStatus(events).state, 'local-changes');
    });
  });

  it('cancelling the bind choice leaves the document unbound and untouched', async () => {
    const doc = await makeDoc('mine\n');
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'theirs\n', sha: 'sha-R' } } });
    await withSyncEnv({ github: gh, resolveConflict: scriptedResolver('cancel') }, async ({ events }) => {
      await assert.rejects(() => sync.bindDocument(doc.id, BOUND), /cancelled/);
      const after = await docs.get(doc.id);
      assert.equal(after.github, null, 'no binding recorded');
      assert.equal(after.content, 'mine\n', 'content untouched');
      assert.equal(lastStatus(events).state, 'local', 'badge restored from transient conflict');
    });
  });

  it('repo access failure surfaces an actionable auth toast and rethrows', async () => {
    const doc = await makeDoc('x');
    const gh = fakeGitHub({ fail: { getRepo: new GitHubError('GitHub API error (401): Bad credentials', { status: 401, kind: 'auth' }) } });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      await assert.rejects(() => sync.bindDocument(doc.id, BOUND), GitHubError);
      const t = toasts(events);
      assert.ok(t.some((x) => x.level === 'error' && /token/i.test(x.message)), 'auth toast points at token setup');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// commitDocument (FR-GH.3) + conflict flow (FR-GH.4)
// ═══════════════════════════════════════════════════════════════════════════

describe('sync: commitDocument (FR-GH.3)', () => {
  it('creates a new file (no sha) and records the new blob sha + syncedAt', async () => {
    const doc = await makeDoc('# post\n', { github: boundGithubField({ sha: null, syncedAt: null }) });
    const gh = fakeGitHub({ branches: ['draft'] });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      const saved = await sync.commitDocument(doc.id, {});
      const put = gh._state.calls.find(([m]) => m === 'putFile');
      assert.equal(put[1].sha, undefined, 'no sha sent for a create');
      assert.equal(put[1].message, 'Update 2026-07-07-sync.md', 'default message is Update <basename>');
      assert.ok(saved.github.sha && saved.github.sha.startsWith('sha-'), 'new blob sha stored');
      assert.ok(saved.github.syncedAt, 'syncedAt stamped');
      assert.equal(saved.github.remoteChanged, false, 'remoteChanged cleared');
      assert.equal(lastStatus(events).state, 'synced');
      assert.ok(toasts(events).some((t) => t.level === 'success' && /committed/i.test(t.message)));
    });
  });

  it('updates with the stored sha and an explicit message', async () => {
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'old\n', sha: 'sha-A' } } });
    const doc = await makeDoc('new\n', { github: boundGithubField({ sha: 'sha-A' }) });
    await withSyncEnv({ github: gh }, async () => {
      await sync.commitDocument(doc.id, { message: 'My message' });
      const put = gh._state.calls.find(([m]) => m === 'putFile');
      assert.equal(put[1].sha, 'sha-A', 'stored sha sent');
      assert.equal(put[1].message, 'My message');
      assert.equal(gh._state.files[BOUND.path].content, 'new\n');
    });
  });

  it('commits the LIVE buffer (bridge) over stale stored content', async () => {
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'old\n', sha: 'sha-A' } } });
    const doc = await makeDoc('stale-store\n', { github: boundGithubField({ sha: 'sha-A' }) });
    await withSyncEnv(
      { github: gh, bridge: { getLocalContent: () => 'fresh-buffer\n' } },
      async () => {
        const saved = await sync.commitDocument(doc.id, {});
        const put = gh._state.calls.find(([m]) => m === 'putFile');
        assert.equal(put[1].content, 'fresh-buffer\n', 'live buffer wins over stored content');
        assert.equal(saved.content, 'fresh-buffer\n', 'store updated to what was committed');
      }
    );
  });

  it('unbound document: actionable toast + throws without any network call', async () => {
    const doc = await makeDoc('x');
    const gh = fakeGitHub();
    await withSyncEnv({ github: gh }, async ({ events }) => {
      await assert.rejects(() => sync.commitDocument(doc.id, {}), /not bound/);
      assert.equal(gh._state.calls.length, 0);
      assert.ok(toasts(events).some((t) => /sync panel/i.test(t.message)));
    });
  });

  it('conflict → "mine" force-puts with the REMOTE current sha', async () => {
    // Remote moved ahead: stored sha-A, remote now sha-B.
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'remote-newer\n', sha: 'sha-B' } } });
    const doc = await makeDoc('mine\n', { github: boundGithubField({ sha: 'sha-A' }) });
    const rec = {};
    await withSyncEnv({ github: gh, resolveConflict: scriptedResolver('mine', rec) }, async ({ events }) => {
      const saved = await sync.commitDocument(doc.id, { message: 'Force mine' });
      assert.ok(rec.called, 'conflict dialog invoked');
      assert.equal(rec.remote, 'remote-newer\n', 'remote fetched for the dialog');
      const puts = gh._state.calls.filter(([m]) => m === 'putFile');
      assert.equal(puts.length, 2, 'stale put then forced put');
      assert.equal(puts[0][1].sha, 'sha-A', 'first attempt used the stale stored sha');
      assert.equal(puts[1][1].sha, 'sha-B', 'forced put used the remote current sha');
      assert.equal(gh._state.files[BOUND.path].content, 'mine\n', 'remote now has my version');
      assert.equal(saved.github.sha, gh._state.files[BOUND.path].sha, 'new blob sha adopted');
      assert.equal(lastStatus(events).state, 'synced');
    });
  });

  it('conflict → "remote": snapshot precedes buffer + store replacement; remote sha adopted', async () => {
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'remote-newer\n', sha: 'sha-B' } } });
    const doc = await makeDoc('mine\n', { github: boundGithubField({ sha: 'sha-A' }) });
    await withSyncEnv(
      { github: gh, resolveConflict: scriptedResolver('remote'), bridge: {} },
      async ({ log, events }) => {
        const saved = await sync.commitDocument(doc.id, {});
        assert.equal(saved.content, 'remote-newer\n');
        assert.equal(saved.github.sha, 'sha-B', 'remote sha adopted, no put issued');
        assert.equal(gh._state.calls.filter(([m]) => m === 'putFile').length, 1, 'only the failed initial put');
        // THE invariant: pre-conflict snapshot strictly before any replacement.
        const snapIdx = log.indexOf('snapshot:pre-conflict');
        assert.ok(snapIdx !== -1, 'pre-conflict snapshot exists');
        assert.ok(snapIdx < log.indexOf('replaceBuffer'), `snapshot before buffer (log: ${log.join(',')})`);
        assert.ok(snapIdx < log.indexOf('update'), `snapshot before store (log: ${log.join(',')})`);
        // The snapshotted body is the pre-replacement local.
        const revs = await revisions.list(doc.id);
        const pre = revs.find((r) => r.reason === 'pre-conflict');
        assert.equal(pre.content, 'mine\n');
        assert.ok(events.some((e) => e.type === 'sync:status' && e.detail.state === 'conflict'));
        assert.equal(lastStatus(events).state, 'synced');
      }
    );
  });

  it('conflict → cancel: aborts, local + sha unchanged, badge restored', async () => {
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'remote-newer\n', sha: 'sha-B' } } });
    const doc = await makeDoc('mine\n', { github: boundGithubField({ sha: 'sha-A' }) });
    await withSyncEnv({ github: gh, resolveConflict: scriptedResolver('cancel'), bridge: {} }, async ({ log, events }) => {
      await assert.rejects(() => sync.commitDocument(doc.id, {}), /cancelled/);
      const after = await docs.get(doc.id);
      assert.equal(after.content, 'mine\n', 'local content unchanged');
      assert.equal(after.github.sha, 'sha-A', 'stored sha unchanged');
      assert.ok(!log.includes('replaceBuffer'), 'buffer never replaced');
      assert.equal(gh._state.files[BOUND.path].content, 'remote-newer\n', 'remote untouched');
      const st = lastStatus(events);
      assert.ok(st.state !== 'conflict', 'transient conflict badge restored');
      assert.ok(toasts(events).some((t) => /cancelled/i.test(t.message)));
    });
  });

  it('rate-limit failure surfaces a token-suggesting toast', async () => {
    const doc = await makeDoc('x', { github: boundGithubField({ sha: null, syncedAt: null }) });
    const gh = fakeGitHub({ fail: { putFile: new GitHubError('GitHub API error (403): API rate limit exceeded', { status: 403, kind: 'rate-limit' }) } });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      await assert.rejects(() => sync.commitDocument(doc.id, {}), GitHubError);
      assert.ok(toasts(events).some((t) => /rate limit/i.test(t.message) && /token/i.test(t.message)));
    });
  });

  it('network failure surfaces a retry-hint toast', async () => {
    const doc = await makeDoc('x', { github: boundGithubField({ sha: null, syncedAt: null }) });
    const gh = fakeGitHub({ fail: { putFile: new GitHubError('GitHub request failed: network error or timeout', { kind: 'network' }) } });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      await assert.rejects(() => sync.commitDocument(doc.id, {}), GitHubError);
      assert.ok(toasts(events).some((t) => /try again/i.test(t.message)));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// pullDocument (FR-GH.5)
// ═══════════════════════════════════════════════════════════════════════════

describe('sync: pullDocument (FR-GH.5)', () => {
  it('changed remote: snapshot(pre-pull) strictly BEFORE buffer + store replacement', async () => {
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'remote v2\n', sha: 'sha-2' } } });
    const doc = await makeDoc('local v1\n', { github: boundGithubField({ sha: 'sha-1' }) });
    await withSyncEnv({ github: gh, bridge: {} }, async ({ log, events }) => {
      const saved = await sync.pullDocument(doc.id);
      assert.equal(saved.content, 'remote v2\n');
      assert.equal(saved.github.sha, 'sha-2');
      const snapIdx = log.indexOf('snapshot:pre-pull');
      assert.ok(snapIdx !== -1, 'pre-pull snapshot exists');
      assert.ok(snapIdx < log.indexOf('replaceBuffer'), `snapshot before buffer (log: ${log.join(',')})`);
      assert.ok(snapIdx < log.indexOf('update'), `snapshot before store (log: ${log.join(',')})`);
      const revs = await revisions.list(doc.id);
      const pre = revs.find((r) => r.reason === 'pre-pull');
      assert.equal(pre.content, 'local v1\n', 'snapshot holds the pre-pull local');
      assert.equal(lastStatus(events).state, 'synced');
      assert.equal(saved.github.remoteChanged, false, 'remoteChanged cleared by pull');
    });
  });

  it('identical remote content: no pre-pull snapshot, sha refreshed', async () => {
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'same\n', sha: 'sha-9' } } });
    const doc = await makeDoc('same\n', { github: boundGithubField({ sha: 'sha-old' }) });
    await withSyncEnv({ github: gh, bridge: {} }, async ({ log }) => {
      const saved = await sync.pullDocument(doc.id);
      assert.equal(saved.github.sha, 'sha-9');
      assert.ok(!log.includes('snapshot:pre-pull'), 'no snapshot when nothing is replaced');
      assert.ok(!log.includes('replaceBuffer'), 'buffer untouched');
    });
  });

  it('missing remote file: returns null, local untouched, warning toast', async () => {
    const gh = fakeGitHub({ branches: ['draft'] });
    const doc = await makeDoc('keep me\n', { github: boundGithubField({ sha: null, syncedAt: null }) });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      const out = await sync.pullDocument(doc.id);
      assert.equal(out, null);
      const after = await docs.get(doc.id);
      assert.equal(after.content, 'keep me\n');
      assert.ok(toasts(events).some((t) => /nothing to pull/i.test(t.message)));
    });
  });

  it('unbound document: throws with an actionable toast', async () => {
    const doc = await makeDoc('x');
    await withSyncEnv({ github: fakeGitHub() }, async ({ events }) => {
      await assert.rejects(() => sync.pullDocument(doc.id), /not bound/);
      assert.ok(toasts(events).some((t) => /bind it in the sync panel/i.test(t.message)));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// checkRemote (passive banner, FR-GH.5)
// ═══════════════════════════════════════════════════════════════════════════

describe('sync: checkRemote (passive, never replaces)', () => {
  it('remote moved ahead: sets remoteChanged, emits remote-changed, buffer untouched', async () => {
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'v2\n', sha: 'sha-2' } } });
    const doc = await makeDoc('v1\n', { github: boundGithubField({ sha: 'sha-1' }) });
    await withSyncEnv({ github: gh, bridge: {} }, async ({ log, events }) => {
      const out = await sync.checkRemote(doc.id);
      assert.equal(out, 'changed');
      const after = await docs.get(doc.id);
      assert.equal(after.github.remoteChanged, true);
      assert.equal(after.content, 'v1\n', 'content NEVER auto-replaced');
      assert.ok(!log.includes('replaceBuffer'));
      assert.equal(lastStatus(events).state, 'remote-changed');
    });
  });

  it('etag 304: unchanged, and NO store write when the flag is already clear', async () => {
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'v1\n', sha: 'sha-1', etag: 'W/"e1"' } } });
    const doc = await makeDoc('v1\n', { github: boundGithubField({ sha: 'sha-1', etag: 'W/"e1"' }) });
    await withSyncEnv({ github: gh }, async ({ log, events }) => {
      const out = await sync.checkRemote(doc.id);
      assert.equal(out, 'unchanged');
      assert.ok(!log.includes('update'), 'no write when nothing flips');
      assert.equal(lastStatus(events), null, 'no status event when nothing changed');
      const probe = gh._state.calls.find(([m]) => m === 'getFile');
      assert.equal(probe[1].etag, 'W/"e1"', 'cheap conditional request sent');
    });
  });

  it('clears a stale remoteChanged flag when the remote matches again', async () => {
    const gh = fakeGitHub({ branches: ['draft'], files: { [BOUND.path]: { content: 'v1\n', sha: 'sha-1' } } });
    const doc = await makeDoc('v1\n', { github: boundGithubField({ sha: 'sha-1', remoteChanged: true }) });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      const out = await sync.checkRemote(doc.id);
      assert.equal(out, 'unchanged');
      const after = await docs.get(doc.id);
      assert.equal(after.github.remoteChanged, false);
      assert.ok(lastStatus(events), 'status re-emitted so the banner clears');
    });
  });

  it('unbound doc: skipped, silent', async () => {
    const doc = await makeDoc('x');
    await withSyncEnv({ github: fakeGitHub() }, async ({ events }) => {
      assert.equal(await sync.checkRemote(doc.id), 'skipped');
      assert.equal(events.length, 0);
    });
  });

  it('network failure is swallowed (passive probe must not disrupt open)', async () => {
    const doc = await makeDoc('x', { github: boundGithubField({ sha: 'sha-1' }) });
    const gh = fakeGitHub({ fail: { getFile: new GitHubError('GitHub request failed: network error or timeout', { kind: 'network' }) } });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      assert.equal(await sync.checkRemote(doc.id), 'skipped');
      assert.equal(toasts(events).length, 0, 'no toast for a background network blip');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// State machine: local → bound → synced → local-changes → remote-changed → synced
// ═══════════════════════════════════════════════════════════════════════════

describe('sync: five-state machine transitions (FR-GH.6)', () => {
  it('walks the full lifecycle via emitted sync:status states', async () => {
    const { deriveSyncStatus } = await import('../../editor/doclist.js');
    const gh = fakeGitHub({ branches: ['main'], defaultBranch: 'main' });
    const doc = await makeDoc('# v1\n');

    // local: unbound record derives 'local'.
    assert.equal(deriveSyncStatus(await docs.get(doc.id)), 'local');

    await withSyncEnv({ github: gh, bridge: {} }, async ({ events }) => {
      // → bound (no remote file): 'local-changes' (work not yet on the remote).
      await sync.bindDocument(doc.id, BOUND);
      assert.equal(lastStatus(events).state, 'local-changes');

      // → synced: first commit creates the file.
      await sync.commitDocument(doc.id, {});
      assert.equal(lastStatus(events).state, 'synced');
      assert.equal(deriveSyncStatus(await docs.get(doc.id)), 'synced');

      // → local-changes: a local edit bumps updatedAt past syncedAt.
      await new Promise((r) => setTimeout(r, 5));
      await docs.update(doc.id, { content: '# v2 local\n' });
      assert.equal(deriveSyncStatus(await docs.get(doc.id)), 'local-changes');

      // → remote-changed: the branch moves ahead externally; checkRemote flags it.
      gh._state.files[BOUND.path] = { content: '# v2 remote\n', sha: 'sha-ext' };
      await sync.checkRemote(doc.id);
      assert.equal(lastStatus(events).state, 'remote-changed');
      assert.equal(deriveSyncStatus(await docs.get(doc.id)), 'remote-changed');

      // → synced: pull adopts the remote (with the pre-pull snapshot).
      await sync.pullDocument(doc.id);
      assert.equal(lastStatus(events).state, 'synced');
      const final = await docs.get(doc.id);
      assert.equal(deriveSyncStatus(final), 'synced');
      assert.equal(final.content, '# v2 remote\n');
      // The overwritten local edit is recoverable.
      const revs = await revisions.list(doc.id);
      assert.ok(revs.some((r) => r.reason === 'pre-pull' && r.content === '# v2 local\n'));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Token hygiene (spec §5.2)
// ═══════════════════════════════════════════════════════════════════════════

describe('sync: token never leaks into errors or toasts', () => {
  it('auth/rate-limit/network failures never echo the stored token', async () => {
    const SECRET = 'github_pat_SECRET_do_not_leak_1234567890';
    localStorage.setItem('jekyllPreviewPAT', SECRET);
    try {
      const doc = await makeDoc('x', { github: boundGithubField({ sha: 'sha-1' }) });
      for (const kind of ['auth', 'rate-limit', 'network', 'not-found']) {
        const gh = fakeGitHub({
          fail: {
            putFile: new GitHubError(`GitHub API error: ${kind}`, { status: 400, kind }),
            getFile: new GitHubError(`GitHub API error: ${kind}`, { status: 400, kind }),
          },
        });
        await withSyncEnv({ github: gh }, async ({ events }) => {
          let thrown = null;
          try { await sync.commitDocument(doc.id, {}); } catch (err) { thrown = err; }
          assert.ok(thrown, `commit should fail for kind=${kind}`);
          assert.ok(!String(thrown.message).includes(SECRET), 'thrown message is token-free');
          for (const t of toasts(events)) {
            assert.ok(!String(t.message).includes(SECRET), `toast is token-free (${kind})`);
          }
        });
      }
    } finally {
      localStorage.removeItem('jekyllPreviewPAT');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// statusbar.js
// ═══════════════════════════════════════════════════════════════════════════

describe('statusbar: five-state badge + surfaces', () => {
  function mountBar() {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const bus = new EventTarget();
    const bar = createStatusBar({ mount, bus });
    return { mount, bus, bar, cleanup: () => { bar.destroy(); mount.remove(); } };
  }

  it('renders each of the five states with the right label + dot', () => {
    const { mount, bar, cleanup } = mountBar();
    try {
      const expected = {
        local: 'Local only',
        synced: 'Synced',
        'local-changes': 'Local changes',
        'remote-changed': 'Remote changed',
        conflict: 'Conflict',
      };
      // Binding required so setBinding(null)'s local-forcing doesn't interfere.
      bar.setBinding({ owner: 'o', repo: 'r', branch: 'b', path: 'p.md' });
      for (const [state, label] of Object.entries(expected)) {
        bar.setSyncState(state);
        assert.equal(bar.getState(), state);
        assert.equal(mount.querySelector('.status-badge-label').textContent, label);
        assert.equal(mount.querySelector('.status-dot').getAttribute('data-state'), state);
        assert.equal(mount.querySelector('#status-binding').getAttribute('data-state'), state);
      }
    } finally { cleanup(); }
  });

  it('renders the binding as owner/repo · branch · path; unbound shows placeholder + forces local', () => {
    const { mount, bar, cleanup } = mountBar();
    try {
      bar.setBinding({ owner: 'rsnyder', repo: 'storykit-starter', branch: 'draft', path: '_posts/x.md' });
      bar.setSyncState('synced');
      assert.equal(mount.querySelector('#status-repo').textContent, 'rsnyder/storykit-starter · draft');
      assert.equal(mount.querySelector('#status-path').textContent, '_posts/x.md');
      bar.setBinding(null);
      assert.equal(mount.querySelector('#status-path').textContent, 'no repo binding');
      assert.ok(mount.querySelector('#status-repo').hidden);
      assert.equal(bar.getState(), 'local', 'unbound forces Local only');
    } finally { cleanup(); }
  });

  it('consumes editor:wordcount / editor:cursor / lint:count bus events', () => {
    const { mount, bus, cleanup } = mountBar();
    try {
      bus.dispatchEvent(new CustomEvent('editor:wordcount', { detail: { words: 1842 } }));
      bus.dispatchEvent(new CustomEvent('editor:cursor', { detail: { line: 12, col: 3 } }));
      bus.dispatchEvent(new CustomEvent('lint:count', { detail: { count: 1 } }));
      assert.equal(mount.querySelector('#status-wordcount').textContent, (1842).toLocaleString() + ' words');
      assert.equal(mount.querySelector('#status-cursor').textContent, 'Ln 12, Col 3');
      assert.equal(mount.querySelector('#status-lint').textContent, 'Audit · 1 issue');
      bus.dispatchEvent(new CustomEvent('lint:count', { detail: { count: 2 } }));
      assert.equal(mount.querySelector('#status-lint').textContent, 'Audit · 2 issues');
    } finally { cleanup(); }
  });

  it('consumes sync:status events (state + binding together)', () => {
    const { mount, bus, bar, cleanup } = mountBar();
    try {
      bus.dispatchEvent(new CustomEvent('sync:status', {
        detail: { docId: 'd1', state: 'remote-changed', binding: { owner: 'o', repo: 'r', branch: 'b', path: 'p.md' } },
      }));
      assert.equal(bar.getState(), 'remote-changed');
      assert.equal(mount.querySelector('#status-repo').textContent, 'o/r · b');
      assert.equal(mount.querySelector('.status-badge-label').textContent, 'Remote changed');
    } finally { cleanup(); }
  });

  it('badge click dispatches sync:open-panel on the bus', () => {
    const { mount, bus, cleanup } = mountBar();
    try {
      let opened = 0;
      bus.addEventListener('sync:open-panel', () => { opened += 1; });
      mount.querySelector('#status-binding').click();
      assert.equal(opened, 1);
    } finally { cleanup(); }
  });

  it('destroy detaches bus listeners and empties the mount', () => {
    const { mount, bus, bar } = mountBar();
    bar.destroy();
    assert.equal(mount.children.length, 0);
    // No throw + no effect after destroy.
    bus.dispatchEvent(new CustomEvent('editor:wordcount', { detail: { words: 5 } }));
    mount.remove();
  });
});

// ── parseGitHubFileRef + openFromGitHub (Open an existing repo file) ─────────

describe('sync: parseGitHubFileRef grammar', () => {
  const parse = sync.parseGitHubFileRef;

  it('parses github.com blob/edit/raw URLs (query/hash stripped, path decoded)', () => {
    assert.deepEqual(parse('https://github.com/o/r/blob/main/_posts/2026-01-01-a.md'),
      { owner: 'o', repo: 'r', branch: 'main', path: '_posts/2026-01-01-a.md' });
    assert.deepEqual(parse('https://github.com/o/r/edit/dev/docs/x.md?plain=1#L10'),
      { owner: 'o', repo: 'r', branch: 'dev', path: 'docs/x.md' });
    assert.equal(parse('https://github.com/o/r/blob/main/_posts/with%20space.md').path,
      '_posts/with space.md');
  });

  it('parses raw.githubusercontent URLs including the refs/heads form', () => {
    assert.deepEqual(parse('https://raw.githubusercontent.com/o/r/main/_posts/a.md'),
      { owner: 'o', repo: 'r', branch: 'main', path: '_posts/a.md' });
    assert.deepEqual(parse('https://raw.githubusercontent.com/o/r/refs/heads/dev/_posts/a.md'),
      { owner: 'o', repo: 'r', branch: 'dev', path: '_posts/a.md' });
  });

  it('parses owner/repo/branch/path shorthand and binding-relative bare paths', () => {
    assert.deepEqual(parse('o/r/main/_posts/a.md'),
      { owner: 'o', repo: 'r', branch: 'main', path: '_posts/a.md' });
    assert.deepEqual(parse('_posts/a.md', { owner: 'bo', repo: 'br', branch: 'dev' }),
      { owner: 'bo', repo: 'br', branch: 'dev', path: '_posts/a.md' });
    assert.deepEqual(parse('_posts/a.md', { owner: 'bo', repo: 'br' }).branch, 'main');
  });

  it('rejects non-GitHub URLs, bare paths without a binding, and empties', () => {
    assert.equal(parse('https://example.com/x.md'), null);
    assert.equal(parse('_posts/a.md'), null);
    assert.equal(parse('_posts/a.md', {}), null);
    assert.equal(parse(''), null);
    assert.equal(parse(null), null);
  });
});

describe('sync: openFromGitHub', () => {
  it('fetches, creates a bound + sha-anchored document, and reports Synced', async () => {
    const remote = '---\ntitle: "Remote Post"\n---\n\nBody.\n';
    const gh = fakeGitHub({ files: { '_posts/2026-02-02-remote.md': { content: remote, sha: 'sha-r1' } } });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      const { docId, created } = await sync.openFromGitHub(
        { owner: 'o', repo: 'r', branch: 'main', path: '_posts/2026-02-02-remote.md' });
      assert.equal(created, true);
      const rec = await docs.get(docId);
      assert.equal(rec.title, 'Remote Post', 'title extracted from front matter');
      assert.equal(rec.path, '_posts/2026-02-02-remote.md');
      assert.equal(rec.content, remote);
      assert.equal(rec.github.owner, 'o');
      assert.equal(rec.github.sha, 'sha-r1');
      assert.equal(rec.github.syncedAt, rec.updatedAt, 'syncedAt anchored to updatedAt');
      const status = events.find((e) => e.type === 'sync:status');
      assert.ok(status, 'emits sync:status');
      await docs.remove(docId);
    });
  });

  it('dedupes: a doc already bound to the same repo/branch/path is reused as-is', async () => {
    const gh = fakeGitHub({ files: { [BOUND.path]: { content: 'remote', sha: 'sha-x' } } });
    const rec = await makeDoc('local content', { github: boundGithubField({ sha: 'sha-x' }) });
    await withSyncEnv({ github: gh }, async () => {
      const { docId, created } = await sync.openFromGitHub(
        { owner: BOUND.owner, repo: BOUND.repo, branch: BOUND.branch, path: BOUND.path });
      assert.equal(created, false);
      assert.equal(docId, rec.id);
      const after = await docs.get(rec.id);
      assert.equal(after.content, 'local content', 'existing content is NOT replaced');
    });
    await docs.remove(rec.id);
  });

  it('missing remote file toasts an error and throws (no document created)', async () => {
    const gh = fakeGitHub({ files: {} });
    await withSyncEnv({ github: gh }, async ({ events }) => {
      const before = (await docs.list()).length;
      let threw = false;
      try {
        await sync.openFromGitHub({ owner: 'o', repo: 'r', path: '_posts/none.md' });
      } catch { threw = true; }
      assert.ok(threw, 'throws on 404');
      assert.equal((await docs.list()).length, before, 'no document created');
      const toastEvt = events.find((e) => e.type === 'toast' && e.detail.level === 'error');
      assert.ok(toastEvt, 'error toast emitted');
    });
  });
});
