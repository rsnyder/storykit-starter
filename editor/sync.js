/**
 * editor/sync.js — GitHub sync workflows + status machine (WP-5.1)
 *
 * Implements FR-GH.2/3/5/6: bind a document to {owner,repo,branch,path}
 * (creating the branch if needed), commit the buffer with SHA bookkeeping,
 * pull the remote file, and a passive remote-changed check on open — all
 * surfacing state via the `sync:status` bus event and network outcomes via
 * `toast`. Conflict handling (FR-GH.4) delegates the three-choice decision to
 * conflict.js's frozen `resolveConflict`; sync.js never auto-merges.
 *
 * ── THE M5 DATA-LOSS INVARIANT ──────────────────────────────────────────────
 * Every buffer-replacing path snapshots the *local* content to revisions with
 * a FORCED reason BEFORE the buffer is touched (store.revisions.snapshot
 * bypasses the 10-min throttle for 'pre-pull'/'pre-conflict'). Concretely:
 *   - pullDocument (changed remote): revisions.snapshot(id, local, 'pre-pull')
 *     runs to completion, THEN the store content + live buffer are replaced.
 *   - commitDocument conflict → 'remote': the snapshot is taken inside the
 *     `beforeResolve` callback that resolveConflict MUST await before returning
 *     a resolution (the frozen cross-WP glue — see below), so it completes
 *     before we replace anything.
 *   - bindDocument adopt-remote: same `beforeResolve` snapshot (or a direct
 *     'pre-conflict' snapshot for the empty-local fast path).
 * Ordering (snapshot-before-replace), not mere existence, is unit-tested.
 *
 * ── CONFLICT beforeResolve GLUE (cross-WP contract with WP-5.2) ─────────────
 * `resolveConflict({ local, remote, beforeResolve })` — the dialog MUST await
 * `beforeResolve()` to completion before ANY resolution ('mine'/'remote') can
 * execute. sync.js always supplies:
 *     beforeResolve: () => store.revisions.snapshot(docId, local, 'pre-conflict')
 * This is the single place the local snapshot is guaranteed for the conflict
 * path, for BOTH choices (spec FR-GH.4: "local version snapshotted before any
 * resolution"). Documented identically in editor/conflict.js. The as-built
 * dialog can also CANCEL (Esc/×): it rejects with its `ConflictCancelled`
 * error — sync.js aborts the operation, leaving all local state unchanged
 * (see isConflictCancelled below).
 *
 * ── TEST SEAM (additive, not part of any frozen contract) ───────────────────
 * `_deps` holds the collaborators sync.js calls. Tests swap `_deps.github`
 * (a fake GitHub client) and `_deps.resolveConflict` (to script 'mine'/'remote'
 * without the real dialog, which is a parallel WP), and may wrap
 * `_deps.store.{docs,revisions}` methods to record ordering. `_deps.emit`
 * defaults to a bus dispatch; `_deps.bridge` is the app's live-editor bridge
 * (getLocalContent / replaceBuffer), null in tests so the store update is the
 * only observable buffer replacement.
 */

import * as githubModule from './github.js';
import * as storeModule from './store.js';
import { resolveConflict as resolveConflictDefault } from './conflict.js';
import { deriveSyncStatus } from './doclist.js';
import { bus } from './app.js';

/** Default emit → bus dispatch (bus is referenced lazily, dodging the app.js↔sync.js import cycle). */
function busEmit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

/**
 * Injectable collaborators. Defaults are the real modules; tests overwrite
 * fields in place (and restore them). Not a frozen contract surface.
 */
export const _deps = {
  github: githubModule,
  store: storeModule,
  resolveConflict: resolveConflictDefault,
  emit: busEmit,
  /** @type {{ getLocalContent(docId:string):string|null, replaceBuffer(docId:string,content:string):void }|null} */
  bridge: null,
};

/**
 * Register the app's live-editor bridge so sync can read the freshest buffer
 * of the OPEN document and push replacements back into the mounted editor
 * without clobbering the store (see app.js's implementation). Additive.
 * @param {{ getLocalContent(docId:string):string|null, replaceBuffer(docId:string,content:string):void }|null} bridge
 */
export function setEditorBridge(bridge) {
  _deps.bridge = bridge || null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function basename(path) {
  return String(path || '').split('/').pop() || 'file';
}

/** Binding shape the status surfaces consume, or null when unbound. */
function bindingOf(record) {
  const gh = record && record.github;
  if (!gh || !gh.owner || !gh.repo) return null;
  return { owner: gh.owner, repo: gh.repo, branch: gh.branch, path: record.path };
}

/**
 * The freshest local content for `docId`: the live editor buffer when this doc
 * is the open one (bridge), else the stored content. This is what we snapshot
 * and what we push to GitHub, so un-flushed keystrokes are never lost/ignored.
 */
function localContentOf(record) {
  const live = _deps.bridge && typeof _deps.bridge.getLocalContent === 'function'
    ? _deps.bridge.getLocalContent(record.id)
    : null;
  return typeof live === 'string' ? live : (record.content || '');
}

/** Push replacement content into the live editor for the open doc (no-op otherwise). */
function pushToOpenBuffer(docId, content) {
  if (_deps.bridge && typeof _deps.bridge.replaceBuffer === 'function') {
    _deps.bridge.replaceBuffer(docId, content);
  }
}

/** Emit `sync:status` for a record; `stateOverride` forces a badge (e.g. transient 'conflict'). */
function emitStatus(record, stateOverride) {
  const state = stateOverride || deriveSyncStatus(record);
  _deps.emit('sync:status', { docId: record.id, state, binding: bindingOf(record) });
}

function toast(message, level = 'success') {
  _deps.emit('toast', { message, level });
}

/**
 * Map a GitHubError to an actionable toast (spec FR-GH.6: network state → toasts,
 * never alerts). Token is never echoed — github.js guarantees error messages are
 * token-free, and we compose only from `kind`. Returns nothing; caller rethrows.
 */
function toastGitHubError(err) {
  const kind = err && err.kind;
  if (kind === 'auth') {
    toast('GitHub rejected the request — your access token is missing or invalid. Open the sync panel → Setup to add one.', 'error');
  } else if (kind === 'rate-limit') {
    toast('GitHub API rate limit reached. Adding a personal access token (sync panel → Setup) raises the limit substantially.', 'warning');
  } else if (kind === 'not-found') {
    toast('Not found — check the repository owner/name, branch, and file path in the sync panel.', 'error');
  } else if (kind === 'network') {
    toast('Network error talking to GitHub. Check your connection and try again.', 'error');
  } else {
    toast(`GitHub error: ${(err && err.message) || 'unknown failure'}`, 'error');
  }
}

/** True for a GitHubError (avoids importing the class identity across test fakes). */
function isGitHubError(err) {
  return err && (err.name === 'GitHubError' || err instanceof _deps.github.GitHubError);
}

/**
 * True when resolveConflict rejected because the author cancelled the dialog
 * (Esc / ×). WP-5.2's as-built conflict.js rejects with its exported
 * `ConflictCancelled` class; detected here BY NAME so sync.js takes no import
 * on a WP-5.2 export (keeps the seam test-fakeable and the modules decoupled).
 * Cancel semantics: abort the operation, local state untouched. Any snapshot
 * already taken via beforeResolve is harmless — it's just extra history.
 */
function isConflictCancelled(err) {
  return !!(err && err.name === 'ConflictCancelled');
}

// ── bindDocument (FR-GH.2) ───────────────────────────────────────────────────

/**
 * Bind `docId` to {owner,repo,branch,path}. Validates repo access, ensures the
 * branch exists (creating it from the default branch head when missing), and
 * probes the target path: a missing file leaves sha null (first commit
 * creates); an existing file records its sha and, when its content differs from
 * a non-empty local buffer, surfaces an adopt-remote vs push-mine choice via
 * resolveConflict (snapshot-before-resolution honored through beforeResolve).
 *
 * @param {string} docId
 * @param {{ owner: string, repo: string, branch: string, path: string }} binding
 * @returns {Promise<object>} the updated document record
 */
export async function bindDocument(docId, { owner, repo, branch, path } = {}) {
  const record = await _deps.store.docs.get(docId);
  if (!record) throw new Error(`bindDocument: no document with id "${docId}"`);
  if (!owner || !repo || !branch || !path) {
    throw new Error('bindDocument: owner, repo, branch, and path are all required');
  }

  try {
    // 1. Validate repo access (also gives us the default branch for creation).
    const repoInfo = await _deps.github.getRepo({ owner, repo });
    const defaultBranch = (repoInfo && repoInfo.default_branch) || 'main';

    // 2. Ensure the branch exists; create from the default head if it doesn't.
    const branches = await _deps.github.listBranches({ owner, repo });
    const exists = Array.isArray(branches) && branches.some((b) => b && b.name === branch);
    if (!exists) {
      const head = await _deps.github.getBranchHead({ owner, repo, branch: defaultBranch });
      await _deps.github.createBranch({ owner, repo, name: branch, fromSha: head.sha });
      toast(`Created branch “${branch}” from ${defaultBranch}.`, 'success');
    }

    // 3. Probe the target path.
    const probe = await _deps.github.getFile({ owner, repo, ref: branch, path });

    if (probe === null || probe === 'not-modified') {
      // No remote file yet — first commit will create it. Badge is forced to
      // 'local-changes' (deriveSyncStatus would misread syncedAt:null as
      // synced): there IS local work the remote doesn't have yet.
      const saved = await _deps.store.docs.update(docId, {
        path,
        github: { owner, repo, branch, sha: null, syncedAt: null },
      });
      emitStatus(saved, 'local-changes');
      toast(`Bound to ${owner}/${repo} · ${branch}. Commit to create ${basename(path)}.`, 'success');
      return saved;
    }

    // Existing remote file.
    const remoteContent = probe.content;
    const remoteSha = probe.sha;
    const local = localContentOf(record);

    if (local === remoteContent) {
      // Already in sync — adopt the sha (syncedAt anchored, see updateAnchored).
      const saved = await updateAnchored(docId, { path },
        { owner, repo, branch, sha: remoteSha, etag: probe.etag });
      emitStatus(saved);
      toast(`Bound to ${owner}/${repo} · ${branch} — already in sync.`, 'success');
      return saved;
    }

    if (local.trim() === '') {
      // Nothing local to lose — adopt remote. Snapshot first anyway (invariant).
      await _deps.store.revisions.snapshot(docId, local, 'pre-conflict');
      pushToOpenBuffer(docId, remoteContent);
      const saved = await updateAnchored(docId, { path, content: remoteContent },
        { owner, repo, branch, sha: remoteSha, etag: probe.etag });
      emitStatus(saved);
      toast(`Bound to ${owner}/${repo} · ${branch} — loaded ${basename(path)} from the repo.`, 'success');
      return saved;
    }

    // Non-empty local differs from remote → adopt-remote vs push-mine choice.
    emitStatus(record, 'conflict');
    const choice = await _deps.resolveConflict({
      local,
      remote: remoteContent,
      beforeResolve: () => _deps.store.revisions.snapshot(docId, local, 'pre-conflict'),
    });

    if (choice === 'remote') {
      // Snapshot already taken by beforeResolve. Replace buffer + adopt sha.
      pushToOpenBuffer(docId, remoteContent);
      const saved = await updateAnchored(docId, { path, content: remoteContent },
        { owner, repo, branch, sha: remoteSha, etag: probe.etag });
      emitStatus(saved);
      toast(`Loaded ${basename(path)} from the repo (your version is in local history).`, 'success');
      return saved;
    }

    // 'mine' — keep local; record the remote sha so a later commit overwrites.
    // syncedAt stays null → the badge reads "Local changes" until committed.
    const saved = await _deps.store.docs.update(docId, {
      path,
      github: { owner, repo, branch, sha: remoteSha, syncedAt: null },
    });
    emitStatus(saved, 'local-changes');
    toast(`Bound to ${owner}/${repo} · ${branch}. Commit to overwrite ${basename(path)}.`, 'success');
    return saved;
  } catch (err) {
    if (isConflictCancelled(err)) {
      // Author backed out of the adopt-remote/push-mine choice: no binding is
      // recorded, local state untouched. Restore the derived badge from the
      // transient 'conflict'.
      emitStatus(record);
      toast('Connect cancelled — nothing was changed.', 'warning');
      throw err;
    }
    if (isGitHubError(err)) toastGitHubError(err);
    else toast(`Couldn’t bind: ${(err && err.message) || err}`, 'error');
    throw err;
  }
}

// ── commitDocument (FR-GH.3) ─────────────────────────────────────────────────

/**
 * Commit the buffer to the bound branch. On a SHA-mismatch conflict, fetch the
 * remote, snapshot local (via beforeResolve), and let resolveConflict decide:
 * 'mine' force-puts with the remote's current sha; 'remote' replaces the buffer
 * with the remote content and adopts its sha. Never auto-merges.
 *
 * @param {string} docId
 * @param {{ message?: string }} [opts]
 * @returns {Promise<object>} the updated document record
 */
export async function commitDocument(docId, { message } = {}) {
  const record = await _deps.store.docs.get(docId);
  if (!record) throw new Error(`commitDocument: no document with id "${docId}"`);
  const gh = record.github;
  if (!gh || !gh.owner) {
    toast('This document isn’t connected to GitHub yet. Open the sync panel to bind it first.', 'error');
    throw new Error('commitDocument: document is not bound');
  }

  const { owner, repo, branch } = gh;
  const path = record.path;
  const local = localContentOf(record);
  const commitMessage = (message && message.trim()) || `Update ${basename(path)}`;

  try {
    const result = await _deps.github.putFile({
      owner, repo, branch, path,
      content: local,
      message: commitMessage,
      sha: gh.sha || undefined,
    });
    const saved = await finishSync(docId, {
      owner, repo, branch, sha: result.sha, content: local,
    });
    toast(`Committed ${basename(path)} to ${branch}.`, 'success');
    return saved;
  } catch (err) {
    if (isGitHubError(err) && err.kind === 'conflict') {
      return handleCommitConflict(docId, { owner, repo, branch, path, local, message: commitMessage });
    }
    if (isGitHubError(err)) toastGitHubError(err);
    else toast(`Commit failed: ${(err && err.message) || err}`, 'error');
    throw err;
  }
}

/**
 * FR-GH.4 conflict flow for commit. The remote is fetched, local is snapshotted
 * inside beforeResolve (awaited by resolveConflict before any resolution), then
 * the choice is applied. Force-put on 'mine' uses the REMOTE's current sha.
 */
async function handleCommitConflict(docId, { owner, repo, branch, path, local, message }) {
  const record = await _deps.store.docs.get(docId);
  emitStatus(record, 'conflict');

  const remote = await _deps.github.getFile({ owner, repo, ref: branch, path });
  const remoteContent = remote && remote !== 'not-modified' ? remote.content : '';
  const remoteSha = remote && remote !== 'not-modified' ? remote.sha : undefined;
  const remoteEtag = remote && remote !== 'not-modified' ? remote.etag : undefined;

  let choice;
  try {
    choice = await _deps.resolveConflict({
      local,
      remote: remoteContent,
      beforeResolve: () => _deps.store.revisions.snapshot(docId, local, 'pre-conflict'),
    });
  } catch (err) {
    if (isConflictCancelled(err)) {
      // Cancel = abort the commit. Local buffer/store/sha untouched; restore
      // the derived badge (the record still has the stale sha → 'local-changes'
      // family). Any beforeResolve snapshot already taken stays — extra history.
      emitStatus(record);
      toast('Commit cancelled — your local version and the remote are both unchanged.', 'warning');
    }
    throw err;
  }

  if (choice === 'remote') {
    // Snapshot already taken via beforeResolve. Replace buffer + adopt sha.
    pushToOpenBuffer(docId, remoteContent);
    const saved = await finishSync(docId, {
      owner, repo, branch, sha: remoteSha, content: remoteContent, etag: remoteEtag,
    });
    toast('Took the remote version. Your local version is saved in local history.', 'success');
    return saved;
  }

  // 'mine' — force-put with the remote's current sha so the write is accepted.
  try {
    const forced = await _deps.github.putFile({
      owner, repo, branch, path, content: local, message, sha: remoteSha,
    });
    const saved = await finishSync(docId, {
      owner, repo, branch, sha: forced.sha, content: local,
    });
    toast(`Overwrote ${basename(path)} on ${branch} with your version.`, 'success');
    return saved;
  } catch (err) {
    if (isGitHubError(err)) toastGitHubError(err);
    else toast(`Commit failed: ${(err && err.message) || err}`, 'error');
    throw err;
  }
}

// ── pullDocument (FR-GH.5) ───────────────────────────────────────────────────

/**
 * Fetch the bound file and replace the buffer when it differs — snapshotting
 * local FIRST (reason 'pre-pull'). An unchanged remote is a no-op beyond
 * refreshing the sync stamp; a missing remote is reported without touching
 * local (never auto-destroy author work).
 *
 * @param {string} docId
 * @returns {Promise<object|null>} the updated record, or null when nothing changed / not found
 */
export async function pullDocument(docId) {
  const record = await _deps.store.docs.get(docId);
  if (!record) throw new Error(`pullDocument: no document with id "${docId}"`);
  const gh = record.github;
  if (!gh || !gh.owner) {
    toast('This document isn’t connected to GitHub yet. Bind it in the sync panel first.', 'error');
    throw new Error('pullDocument: document is not bound');
  }

  const { owner, repo, branch } = gh;
  const path = record.path;

  try {
    const res = await _deps.github.getFile({ owner, repo, ref: branch, path });
    if (res === null) {
      toast(`No file at ${path} on ${branch} yet — nothing to pull.`, 'warning');
      return null;
    }
    if (res === 'not-modified') {
      return null;
    }

    const remoteContent = res.content;
    const remoteSha = res.sha;
    const local = localContentOf(record);

    if (remoteContent === local) {
      // Content identical — just refresh the sha/stamp and clear any flag.
      const saved = await finishSync(docId, {
        owner, repo, branch, sha: remoteSha, content: local, etag: res.etag,
      });
      toast('Already up to date with GitHub.', 'success');
      return saved;
    }

    // Changed — INVARIANT: snapshot local BEFORE replacing anything.
    await _deps.store.revisions.snapshot(docId, local, 'pre-pull');
    pushToOpenBuffer(docId, remoteContent);
    const saved = await finishSync(docId, {
      owner, repo, branch, sha: remoteSha, content: remoteContent, etag: res.etag,
    });
    toast(`Pulled the latest ${basename(path)} from ${branch}.`, 'success');
    return saved;
  } catch (err) {
    if (isGitHubError(err)) toastGitHubError(err);
    else toast(`Pull failed: ${(err && err.message) || err}`, 'error');
    throw err;
  }
}

// ── checkRemote (FR-GH.5, passive) ───────────────────────────────────────────

/**
 * Passive remote-change probe, called on document open. Cheap: sends
 * If-None-Match with any stored etag so an unchanged remote returns 304. Sets
 * (or clears) `github.remoteChanged` and emits `sync:status` for the banner —
 * NEVER replaces the buffer. Best-effort: swallows errors (only auth/rate-limit
 * get a quiet toast) so opening a document never fails on a flaky network.
 *
 * Note: to avoid corrupting the time-based sync badge, this only WRITES the
 * record when `remoteChanged` actually flips value; an unchanged remote makes
 * no store write (so `updatedAt` — hence the "Synced" badge — stays put).
 *
 * @param {string} docId
 * @returns {Promise<'changed'|'unchanged'|'skipped'>}
 */
export async function checkRemote(docId) {
  const record = await _deps.store.docs.get(docId);
  const gh = record && record.github;
  if (!gh || !gh.owner) return 'skipped';

  try {
    const res = await _deps.github.getFile({
      owner: gh.owner, repo: gh.repo, ref: gh.branch, path: record.path, etag: gh.etag,
    });

    if (res === 'not-modified') {
      if (gh.remoteChanged) {
        const saved = await _deps.store.docs.update(docId, { github: { ...gh, remoteChanged: false } });
        emitStatus(saved);
      }
      return 'unchanged';
    }
    if (res === null) return 'unchanged'; // remote gone — leave local intact

    const changed = res.sha !== gh.sha;
    if (changed && !gh.remoteChanged) {
      const saved = await _deps.store.docs.update(docId, { github: { ...gh, remoteChanged: true } });
      emitStatus(saved);
      return 'changed';
    }
    if (!changed && gh.remoteChanged) {
      const saved = await _deps.store.docs.update(docId, { github: { ...gh, remoteChanged: false } });
      emitStatus(saved);
    }
    return changed ? 'changed' : 'unchanged';
  } catch (err) {
    if (isGitHubError(err) && (err.kind === 'auth' || err.kind === 'rate-limit')) {
      toastGitHubError(err);
    }
    // Otherwise silent — a passive check must not disrupt opening a document.
    return 'skipped';
  }
}

// ── shared "sync succeeded" bookkeeping ──────────────────────────────────────

/**
 * Two-phase anchored update (integration reconciliation of a timestamp race):
 * patch the updatedAt-bumping fields first, then write the github metadata in
 * a github-ONLY patch — which store.docs.update deliberately does NOT bump —
 * with `syncedAt` anchored to the record's exact `updatedAt`. This makes the
 * dirty heuristic (`updatedAt > github.syncedAt`) exact instead of depending
 * on the millisecond ordering of two separately-taken timestamps.
 * @param {string} docId
 * @param {object} fields  updatedAt-bumping fields (content/path/…); may be {}
 * @param {object} github  github metadata WITHOUT syncedAt (anchored here)
 */
async function updateAnchored(docId, fields, github) {
  const bumped = Object.keys(fields).length
    ? await _deps.store.docs.update(docId, fields)
    : await _deps.store.docs.get(docId);
  return _deps.store.docs.update(docId, {
    github: { ...github, syncedAt: bumped.updatedAt },
  });
}

/**
 * Record a successful sync: persist content + github {sha, syncedAt} and clear
 * the remote-changed flag, then emit the resulting status. syncedAt is anchored
 * to the record's updatedAt via updateAnchored, so the time-based badge reads
 * "Synced" immediately and deterministically (updatedAt ≯ syncedAt).
 */
async function finishSync(docId, { owner, repo, branch, sha, content, etag }) {
  const github = { owner, repo, branch, sha, remoteChanged: false };
  if (etag) github.etag = etag;
  const fields = {};
  if (typeof content === 'string') fields.content = content;
  const saved = await updateAnchored(docId, fields, github);
  emitStatus(saved);
  return saved;
}
