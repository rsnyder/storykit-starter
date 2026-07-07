/**
 * editor/conflict.js — conflict resolution dialog (WP-5.2)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2, §3 WP-5.2; docs/editor-spec.md
 * FR-GH.4.
 *
 *   resolveConflict({ local, remote, beforeResolve })
 *     → Promise<'mine' | 'remote'>
 *
 *   local, remote:  full document texts (strings).
 *   beforeResolve:  OPTIONAL `() => Promise<any>`. WP-5.1 passes
 *                   `() => store.revisions.snapshot(docId, local, 'pre-conflict')`.
 *
 * HARD INVARIANT (spec FR-GH.4, "snapshotted to revisions before any
 * resolution"): when `beforeResolve` is provided, it MUST be awaited to
 * successful completion before the returned promise resolves with either
 * 'mine' or 'remote'. Enforced here by gating the resolve() call behind
 * `await ensureBeforeResolve()` — see that function below; the ordering is
 * asserted in tests/unit/conflict.test.js with a controllable deferred.
 *
 * CANCEL SEMANTICS (additive — the frozen return type is choice-only, so
 * this is this WP's design decision, made per the plan's explicit
 * invitation to "define cancel semantics"): Esc or the dialog's close (×)
 * button reject the returned promise with a `ConflictCancelled` error
 * (exported below) rather than resolving with a fabricated choice. Callers
 * (WP-5.1) should catch `ConflictCancelled` and treat it as "conflict still
 * unresolved, buffer untouched" — no data was replaced, nothing was
 * committed. Cancel is available even while `beforeResolve` is in flight or
 * has failed (it does not block on the invariant — only a *resolve* does);
 * a pending `beforeResolve` call that later settles after cancel is a no-op
 * (guarded by the `settled` flag below).
 *
 * RETRY SEMANTICS: if `beforeResolve()` throws/rejects, the dialog shows an
 * inline error (role="alert"), re-enables the action buttons, and does NOT
 * resolve or reject — the user may click "Keep mine"/"Take remote" again
 * (retries `beforeResolve()` fresh) or cancel (Esc / ×). Once
 * `beforeResolve()` has completed successfully once, it is not invoked
 * again even if the user changes their mind between the two action buttons
 * before either click lands — see `beforeResolveDone` below.
 *
 * DIFF APPROACH: pinned dependency `diff` (jsdiff) 9.0.0 via esm.sh
 * (`?external=*`, though jsdiff itself ships zero runtime dependencies —
 * the flag is kept for consistency with every other editor pin's strategy
 * comment in editor/index.html). Chosen over a hand-rolled LCS because
 * jsdiff's `diffLines` is a well-tested, single-purpose primitive (no
 * transitive graph to worry about, unlike the CM6/Lezer packages) and a
 * hand-rolled implementation would just be reimplementing Myers diff with
 * more risk of an alignment bug in exactly the code path this dialog exists
 * to make trustworthy. `buildDiffRows()` (exported, additive) turns jsdiff's
 * "chunk" output into row-aligned `{ type, left, right }` records suitable
 * for a two-pane side-by-side render: a removed chunk immediately followed
 * by an added chunk is treated as a paired "changed" block (line `i` of the
 * removed chunk sits next to line `i` of the added chunk); leftover lines on
 * either side render as `added`/`removed` against a blank line on the other
 * pane. This is the same alignment strategy used by GitHub's own
 * side-by-side diff view for the "modified line" case.
 *
 * ── Selectors for WP-5.1/5.3 (driving the dialog from sync.js / e2e) ───────
 *   `.sk-conflict-dialog`                    the dialog root (role="dialog")
 *   `[data-sk-conflict-action="mine"]`       "Keep mine" button
 *   `[data-sk-conflict-action="remote"]`     "Take remote" button
 *   `[data-sk-conflict-action="diff"]`       "View diff" toggle
 *   `.sk-conflict-close`                     the × cancel button
 *   `.sk-conflict-error`                     inline error region (role="alert")
 *   `.sk-conflict-pane-local` / `-remote`    the two scroll-synced diff panes
 * Button label text is exactly "Keep mine", "Take remote", "View diff" per
 * the plan's §3 wording — safe to select on accessible name too.
 */

import { diffLines } from 'diff';

/** Rejection reason for the cancel path (Esc / × / outside-click is
 * intentionally NOT wired to cancel — a conflict dialog is too consequential
 * to dismiss by a stray click; Esc and the explicit × button are the two
 * deliberate cancel affordances). */
export class ConflictCancelled extends Error {
  constructor(message = 'Conflict resolution was cancelled.') {
    super(message);
    this.name = 'ConflictCancelled';
  }
}

/** Tunable/inspectable internals, exposed for tests (mirrors editor/github.js
 * and editor/wikidata.js's `_internal` pattern) — not part of the frozen
 * contract. */
export const _internal = { diffLines };

// ── injected styles (own stylesheet, --sk-* tokens with hermetic fallbacks,
//    mirrors editor/wikidata.js's ensureStyles precedent) ──────────────────
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'sk-conflict-styles';
  style.textContent = `
.sk-conflict-backdrop {
  position: fixed; inset: 0; z-index: 10050;
  background: var(--sk-backdrop, rgba(15, 18, 22, .45));
  display: flex; align-items: center; justify-content: center;
  padding: var(--sk-space-3, 24px);
}
.sk-conflict-dialog {
  width: min(920px, 100%);
  max-height: min(720px, 90vh);
  display: flex; flex-direction: column; min-height: 0;
  background: var(--sk-surface, #fff); color: var(--sk-text, #1f2328);
  border: 1px solid var(--sk-border, #d8dee4); border-radius: var(--sk-radius-lg, 10px);
  box-shadow: var(--sk-shadow-2, 0 8px 24px rgba(31, 35, 40, .18));
  font: var(--sk-fs-base, 14px)/1.5 var(--sk-font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
  padding: var(--sk-space-3, 24px);
}
.sk-conflict-dialog:focus { outline: none; }
.sk-conflict-dialog button:focus-visible,
.sk-conflict-pane:focus-visible {
  outline: 2px solid var(--sk-focus, #0969da); outline-offset: 1px;
}
.sk-conflict-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sk-space-2, 16px); }
.sk-conflict-title {
  margin: 0; font-size: var(--sk-fs-lg, 18px); font-weight: 600;
  font-family: var(--sk-font-heading, var(--sk-font-sans, sans-serif));
}
.sk-conflict-close {
  flex: none; border: none; background: transparent; color: var(--sk-text-muted, #57606a);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 4px 8px; border-radius: var(--sk-radius-sm, 4px);
}
.sk-conflict-close:hover { background: var(--sk-bg-sunken, #f6f8fa); }
.sk-conflict-desc { color: var(--sk-text-muted, #57606a); margin: var(--sk-space-1, 8px) 0 0; }
.sk-conflict-error {
  margin-top: var(--sk-space-1, 8px); padding: 8px 12px; border-radius: var(--sk-radius, 6px);
  background: var(--sk-bg-sunken, #f6f8fa); color: var(--sk-danger, #b3261e); font-size: var(--sk-fs-sm, 13px);
}
.sk-conflict-actions { display: flex; gap: var(--sk-space-1, 8px); margin-top: var(--sk-space-2, 16px); flex-wrap: wrap; }
.sk-conflict-action {
  padding: 8px 14px; border-radius: var(--sk-radius, 6px); border: 1px solid var(--sk-border-strong, #c2c9d1);
  background: var(--sk-bg, #fff); color: var(--sk-text, #1f2328); font: inherit; cursor: pointer;
}
.sk-conflict-action:hover { background: var(--sk-bg-sunken, #f6f8fa); }
.sk-conflict-action:disabled { opacity: .6; cursor: not-allowed; }
.sk-conflict-action-primary {
  background: var(--sk-accent, #0056b2); border-color: var(--sk-accent, #0056b2); color: var(--sk-accent-contrast, #fff);
}
.sk-conflict-action-primary:hover { background: var(--sk-accent-hover, #00408a); }
.sk-conflict-action-ghost { background: transparent; }
.sk-conflict-action-ghost[aria-expanded="true"] { background: var(--sk-selection, rgba(9, 105, 218, .14)); }
.sk-conflict-hint { margin: var(--sk-space-1, 8px) 0 0; color: var(--sk-text-faint, #6e7781); font-size: var(--sk-fs-xs, 12px); }
.sk-conflict-diff {
  margin-top: var(--sk-space-2, 16px); border-top: 1px solid var(--sk-border, #d8dee4);
  padding-top: var(--sk-space-2, 16px); min-height: 0; display: flex; flex-direction: column; flex: 1 1 auto;
}
.sk-conflict-diff-legend { display: flex; gap: var(--sk-space-2, 16px); font-size: var(--sk-fs-xs, 12px); color: var(--sk-text-muted, #57606a); margin-bottom: var(--sk-space-1, 8px); }
.sk-legend-item { display: flex; align-items: center; gap: 4px; }
.sk-legend-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.sk-conflict-diff-panes {
  display: flex; gap: 1px; border: 1px solid var(--sk-border, #d8dee4); border-radius: var(--sk-radius, 6px);
  overflow: hidden; flex: 1 1 auto; min-height: 0; background: var(--sk-border, #d8dee4);
}
.sk-conflict-pane { flex: 1 1 50%; min-width: 0; overflow: auto; max-height: 320px; background: var(--sk-surface, #fff); }
.sk-conflict-diffline {
  display: flex; font: var(--sk-fs-sm, 13px)/1.5 var(--sk-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: pre;
}
.sk-conflict-linenum {
  flex: 0 0 auto; width: 40px; text-align: right; padding: 0 8px; color: var(--sk-text-faint, #6e7781);
  user-select: none; background: var(--sk-bg-sunken, #f6f8fa);
}
.sk-conflict-linecode { flex: 1 1 auto; padding: 0 8px; }
.sk-diff-removed { background: color-mix(in srgb, var(--sk-danger, #b3261e) 16%, transparent); }
.sk-diff-added { background: color-mix(in srgb, var(--sk-success, #0a7d2c) 16%, transparent); }
.sk-diff-changed-old { background: color-mix(in srgb, var(--sk-warning, #9a6700) 18%, transparent); }
.sk-diff-changed-new { background: color-mix(in srgb, var(--sk-warning, #9a6700) 18%, transparent); }
.sk-diff-empty .sk-conflict-linecode { background: var(--sk-skeleton-a, #eaeef2); }
.sk-conflict-diff-empty-msg { padding: var(--sk-space-2, 16px); color: var(--sk-text-faint, #6e7781); }
@media (max-width: 640px) {
  .sk-conflict-diff-panes { flex-direction: column; }
  .sk-conflict-pane { max-height: 200px; }
}
`;
  document.head.appendChild(style);
}

// ── diff → row alignment ─────────────────────────────────────────────────

/** Splits jsdiff chunk text into lines, dropping the artefact empty string
 * left by a trailing newline (so "a\nb\n" → ['a','b'], not ['a','b','']). */
function splitLines(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Turns `diffLines(local, remote)` output into row-aligned records for a
 * side-by-side render. A removed chunk immediately followed by an added
 * chunk is paired line-by-line as 'changed'; leftover lines on the longer
 * side (or an unpaired removed/added chunk) render against a blank `null`
 * on the other side.
 * @param {string} local
 * @param {string} remote
 * @returns {Array<{ type: 'same'|'added'|'removed'|'changed', left: string|null, right: string|null }>}
 */
export function buildDiffRows(local, remote) {
  const parts = diffLines(local ?? '', remote ?? '');
  const rows = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (const line of splitLines(part.value)) rows.push({ type: 'same', left: line, right: line });
      i += 1;
      continue;
    }
    let removedLines = [];
    let addedLines = [];
    if (part.removed) {
      removedLines = splitLines(part.value);
      i += 1;
      if (i < parts.length && parts[i].added) {
        addedLines = splitLines(parts[i].value);
        i += 1;
      }
    } else {
      addedLines = splitLines(part.value);
      i += 1;
    }
    const max = Math.max(removedLines.length, addedLines.length);
    for (let j = 0; j < max; j++) {
      const l = j < removedLines.length ? removedLines[j] : undefined;
      const r = j < addedLines.length ? addedLines[j] : undefined;
      if (l !== undefined && r !== undefined) rows.push({ type: 'changed', left: l, right: r });
      else if (l !== undefined) rows.push({ type: 'removed', left: l, right: null });
      else rows.push({ type: 'added', left: null, right: r });
    }
  }
  return rows;
}

function statusWordFor(type, side) {
  if (type === 'removed') return 'Removed';
  if (type === 'added') return 'Added';
  if (type === 'changed') return side === 'local' ? 'Changed, previous version' : 'Changed, new version';
  return null;
}

function classFor(type, side) {
  if (type === 'removed') return 'sk-diff-removed';
  if (type === 'added') return 'sk-diff-added';
  if (type === 'changed') return side === 'local' ? 'sk-diff-changed-old' : 'sk-diff-changed-new';
  return null;
}

/** Renders one scrollable diff pane ('local' or 'remote') from row-aligned
 * data — class names `.sk-conflict-pane-local` / `.sk-conflict-pane-remote`
 * are part of the documented selector surface for WP-5.1/5.3. */
function renderPane(rows, side, label) {
  const pane = document.createElement('div');
  pane.className = `sk-conflict-pane sk-conflict-pane-${side}`;
  pane.tabIndex = 0;
  pane.setAttribute('role', 'group');
  pane.setAttribute('aria-label', label);

  let lineNo = 0;
  for (const row of rows) {
    const content = side === 'local' ? row.left : row.right;
    const line = document.createElement('div');
    line.className = 'sk-conflict-diffline';

    const num = document.createElement('span');
    num.className = 'sk-conflict-linenum';
    num.setAttribute('aria-hidden', 'true');

    const code = document.createElement('span');
    code.className = 'sk-conflict-linecode';

    if (content === null) {
      line.classList.add('sk-diff-empty');
      line.setAttribute('aria-hidden', 'true');
    } else {
      lineNo += 1;
      num.textContent = String(lineNo);
      code.textContent = content;
      const cls = classFor(row.type, side);
      if (cls) line.classList.add(cls);
      const status = statusWordFor(row.type, side);
      line.setAttribute('aria-label', status ? `${status}: ${content || '(blank line)'}` : (content || '(blank line)'));
      num.setAttribute('aria-hidden', 'true');
      code.setAttribute('aria-hidden', 'true');
    }

    line.append(num, code);
    pane.appendChild(line);
  }

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'sk-conflict-diff-empty-msg';
    empty.textContent = 'No differences.';
    pane.appendChild(empty);
  }

  return pane;
}

/** Builds the two-pane, scroll-synced diff view. */
function buildDiffPanes(local, remote) {
  const rows = buildDiffRows(local, remote);
  const wrap = document.createElement('div');
  wrap.className = 'sk-conflict-diff-panes';

  const leftPane = renderPane(rows, 'local', 'Local version (yours)');
  const rightPane = renderPane(rows, 'remote', 'Remote version (from GitHub)');
  wrap.append(leftPane, rightPane);

  let syncing = false;
  function mirror(from, to) {
    return () => {
      if (syncing) return;
      syncing = true;
      to.scrollTop = from.scrollTop;
      to.scrollLeft = from.scrollLeft;
      syncing = false;
    };
  }
  leftPane.addEventListener('scroll', mirror(leftPane, rightPane));
  rightPane.addEventListener('scroll', mirror(rightPane, leftPane));

  return wrap;
}

// ── focus trap helpers ───────────────────────────────────────────────────

function getFocusableEls(root) {
  const selector = 'button:not([disabled]), [href], input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(selector)).filter((el) => {
    if (el.hidden) return false;
    if (el.closest('[hidden]')) return false;
    return true;
  });
}

// ── the dialog itself ────────────────────────────────────────────────────

function openConflictDialog({ local, remote, beforeResolve, resolve, reject }) {
  ensureStyles();
  const previouslyFocused = document.activeElement;

  const backdrop = document.createElement('div');
  backdrop.className = 'sk-conflict-backdrop';

  const dialog = document.createElement('div');
  dialog.className = 'sk-conflict-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'sk-conflict-title');
  dialog.setAttribute('aria-describedby', 'sk-conflict-desc');
  dialog.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'sk-conflict-header';

  const title = document.createElement('h2');
  title.id = 'sk-conflict-title';
  title.className = 'sk-conflict-title';
  title.textContent = 'This file changed on GitHub since your last sync';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sk-conflict-close';
  closeBtn.setAttribute('aria-label', 'Cancel');
  closeBtn.textContent = '×';

  header.append(title, closeBtn);

  const desc = document.createElement('p');
  desc.id = 'sk-conflict-desc';
  desc.className = 'sk-conflict-desc';
  desc.textContent = 'Someone — possibly you, from another device — saved a newer '
    + 'version of this file on GitHub since you last synced. Pick which version to keep, '
    + 'or look at what changed first.';

  const errorBox = document.createElement('div');
  errorBox.className = 'sk-conflict-error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'sk-conflict-actions';

  const mineBtn = document.createElement('button');
  mineBtn.type = 'button';
  mineBtn.className = 'sk-conflict-action sk-conflict-action-primary';
  mineBtn.dataset.skConflictAction = 'mine';
  mineBtn.textContent = 'Keep mine';

  const remoteBtn = document.createElement('button');
  remoteBtn.type = 'button';
  remoteBtn.className = 'sk-conflict-action';
  remoteBtn.dataset.skConflictAction = 'remote';
  remoteBtn.textContent = 'Take remote';

  const diffBtn = document.createElement('button');
  diffBtn.type = 'button';
  diffBtn.className = 'sk-conflict-action sk-conflict-action-ghost';
  diffBtn.dataset.skConflictAction = 'diff';
  diffBtn.setAttribute('aria-expanded', 'false');
  diffBtn.setAttribute('aria-controls', 'sk-conflict-diff-section');
  diffBtn.textContent = 'View diff';

  actions.append(mineBtn, remoteBtn, diffBtn);

  const hint = document.createElement('p');
  hint.className = 'sk-conflict-hint';
  hint.textContent = beforeResolve
    ? 'Your current local text is snapshotted automatically before either choice takes '
      + 'effect, so it is always recoverable from Revisions — including if you choose '
      + '"Take remote", which discards the local buffer.'
    : 'Choosing "Take remote" replaces your local buffer with the GitHub version.';

  const diffSection = document.createElement('div');
  diffSection.id = 'sk-conflict-diff-section';
  diffSection.className = 'sk-conflict-diff';
  diffSection.hidden = true;

  const legend = document.createElement('div');
  legend.className = 'sk-conflict-diff-legend';
  legend.innerHTML = ''
    + '<span class="sk-legend-item"><span class="sk-legend-swatch sk-diff-removed" aria-hidden="true"></span>Removed</span>'
    + '<span class="sk-legend-item"><span class="sk-legend-swatch sk-diff-added" aria-hidden="true"></span>Added</span>'
    + '<span class="sk-legend-item"><span class="sk-legend-swatch sk-diff-changed-old" aria-hidden="true"></span>Changed</span>';

  const panes = buildDiffPanes(local, remote);
  diffSection.append(legend, panes);

  dialog.append(header, desc, errorBox, actions, hint, diffSection);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  let settled = false;
  let busy = false;
  let beforeResolveDone = !beforeResolve;

  function setBusy(v) {
    busy = v;
    mineBtn.disabled = v;
    remoteBtn.disabled = v;
    dialog.setAttribute('aria-busy', v ? 'true' : 'false');
  }

  function showError(err) {
    const message = err && err.message ? err.message : String(err);
    errorBox.textContent = `Couldn't save your local snapshot: ${message}. You can try again or cancel.`;
    errorBox.hidden = false;
  }
  function hideError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function cleanup() {
    document.removeEventListener('keydown', onKeydown, true);
    backdrop.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
  }

  function doResolve(action) {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(action);
  }

  function doCancel() {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new ConflictCancelled());
  }

  async function ensureBeforeResolve() {
    if (beforeResolveDone) return;
    await beforeResolve();
    beforeResolveDone = true;
  }

  async function chooseAction(action) {
    if (settled || busy) return;
    hideError();
    setBusy(true);
    try {
      await ensureBeforeResolve();
    } catch (err) {
      if (settled) return; // cancelled while beforeResolve was in flight
      setBusy(false);
      showError(err);
      return;
    }
    if (settled) return; // cancelled between the await settling and here
    setBusy(false);
    doResolve(action);
  }

  mineBtn.addEventListener('click', () => chooseAction('mine'));
  remoteBtn.addEventListener('click', () => chooseAction('remote'));
  closeBtn.addEventListener('click', () => doCancel());

  diffBtn.addEventListener('click', () => {
    const expanded = diffBtn.getAttribute('aria-expanded') === 'true';
    diffBtn.setAttribute('aria-expanded', String(!expanded));
    diffSection.hidden = expanded;
  });

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      doCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    // Full manual control (matches editor/wikidata.js's popup precedent)
    // rather than relying on the browser's native tab-order advancement:
    // that native behaviour only fires for trusted input, so a trap that
    // depends on it silently breaks under synthetic/programmatic Tab
    // events (as used by this module's own unit tests, and by some
    // automation tooling) even though it would appear to work by hand.
    const focusables = getFocusableEls(dialog);
    if (!focusables.length) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const currentIdx = focusables.indexOf(document.activeElement);
    let nextIdx;
    if (currentIdx === -1) {
      // Focus is on the dialog container (initial state) or somewhere
      // outside the trap — enter it at the first control (or last, if
      // arriving via Shift+Tab).
      nextIdx = e.shiftKey ? focusables.length - 1 : 0;
    } else {
      nextIdx = e.shiftKey
        ? (currentIdx - 1 + focusables.length) % focusables.length
        : (currentIdx + 1) % focusables.length;
    }
    focusables[nextIdx].focus();
  }
  document.addEventListener('keydown', onKeydown, true);

  // Safe default initial focus: the dialog container itself (tabindex=-1),
  // not either consequential action button — avoids a stray Enter/Space
  // committing to "Keep mine"/"Take remote" before the author has read the
  // dialog. Tab from here enters the trap at the first focusable control.
  dialog.focus({ preventScroll: true });
}

/**
 * Three-choice conflict dialog + read-only side-by-side diff (FR-GH.4).
 * @param {{ local: string, remote: string, beforeResolve?: () => Promise<any> }} args
 * @returns {Promise<'mine' | 'remote'>} rejects with ConflictCancelled on
 *   Esc / the dialog's × button.
 */
export async function resolveConflict({ local = '', remote = '', beforeResolve } = {}) {
  return new Promise((resolve, reject) => {
    openConflictDialog({ local, remote, beforeResolve, resolve, reject });
  });
}
