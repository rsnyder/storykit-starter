// tests/unit/conflict.test.js  (WP-5.2)
//
// Unit tests for editor/conflict.js — the three-choice conflict dialog +
// read-only side-by-side diff (FR-GH.4). Covers: each resolution path's
// return value, the beforeResolve-ordering invariant (via a controllable
// deferred), beforeResolve rejection + retry, cancel semantics
// (ConflictCancelled), diff-row alignment for a known input pair, the focus
// trap + Esc, and the ARIA surface. No network, no store.js dependency —
// `beforeResolve` is always a plain test-supplied callback here (WP-5.1
// wires the real store.revisions.snapshot() call at integration time).

import { describe, it, assert } from './runner.js';
import { resolveConflict, ConflictCancelled, buildDiffRows } from '../../editor/conflict.js';

// ── helpers ──────────────────────────────────────────────────────────────

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise the test can resolve/reject on its own schedule. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function dialogEl() {
  return document.querySelector('.sk-conflict-dialog');
}

function dispatchTab(shift = false) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));
}

function dispatchEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

// ── resolution paths ─────────────────────────────────────────────────────

describe('conflict.js: resolveConflict — resolution paths', () => {
  it('"Keep mine" resolves with \'mine\' and removes the dialog', async () => {
    const p = resolveConflict({ local: 'a\nb\n', remote: 'a\nc\n' });
    const dialog = dialogEl();
    assert.ok(dialog, 'dialog should be mounted synchronously');
    dialog.querySelector('[data-sk-conflict-action="mine"]').click();
    const result = await p;
    assert.equal(result, 'mine');
    assert.ok(!dialogEl(), 'dialog should be removed after resolving');
  });

  it('"Take remote" resolves with \'remote\'', async () => {
    const p = resolveConflict({ local: 'a', remote: 'b' });
    const dialog = dialogEl();
    dialog.querySelector('[data-sk-conflict-action="remote"]').click();
    const result = await p;
    assert.equal(result, 'remote');
    assert.ok(!dialogEl());
  });

  it('action buttons carry the exact spec wording and selectors', async () => {
    const p = resolveConflict({ local: 'a', remote: 'b' });
    const dialog = dialogEl();
    const mine = dialog.querySelector('[data-sk-conflict-action="mine"]');
    const remote = dialog.querySelector('[data-sk-conflict-action="remote"]');
    const diff = dialog.querySelector('[data-sk-conflict-action="diff"]');
    assert.equal(mine.textContent, 'Keep mine');
    assert.equal(remote.textContent, 'Take remote');
    assert.equal(diff.textContent, 'View diff');
    dialog.querySelector('.sk-conflict-close').click();
    await assert.rejects(() => p, ConflictCancelled);
  });
});

// ── beforeResolve invariant ──────────────────────────────────────────────

describe('conflict.js: beforeResolve HARD INVARIANT (awaited before resolving)', () => {
  it('resolve() fires strictly after a controllable beforeResolve settles', async () => {
    const d = deferred();
    let callCount = 0;
    const beforeResolve = () => { callCount += 1; return d.promise; };

    const p = resolveConflict({ local: 'x', remote: 'y', beforeResolve });
    dialogEl().querySelector('[data-sk-conflict-action="remote"]').click();

    await sleep(0); // let the click handler call beforeResolve()
    assert.equal(callCount, 1, 'beforeResolve should be invoked once the action is chosen');

    let settled = false;
    p.then(() => { settled = true; });
    await sleep(0);
    assert.ok(!settled, 'the outer promise must not resolve while beforeResolve is pending');
    assert.ok(dialogEl(), 'dialog stays open while beforeResolve is pending');

    d.resolve('snapshot-ok');
    const result = await p;
    assert.equal(result, 'remote');
    assert.ok(settled);
  });

  it('a beforeResolve rejection blocks resolution, shows an error, and retry succeeds', async () => {
    let attempt = 0;
    const beforeResolve = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('snapshot write failed')) : Promise.resolve();
    };

    const p = resolveConflict({ local: 'a', remote: 'b', beforeResolve });
    const dialog = dialogEl();
    const mineBtn = dialog.querySelector('[data-sk-conflict-action="mine"]');

    mineBtn.click();
    await sleep(0);
    await sleep(0);

    const errorBox = dialog.querySelector('.sk-conflict-error');
    assert.ok(!errorBox.hidden, 'error region should be shown on beforeResolve failure');
    assert.ok(errorBox.textContent.includes('snapshot write failed'), 'error message should surface the failure');
    assert.ok(!mineBtn.disabled, 'action buttons re-enabled after failure so the user can retry');
    assert.ok(dialogEl(), 'dialog must not resolve/close on failure');

    // Retry: same button, beforeResolve now succeeds.
    mineBtn.click();
    const result = await p;
    assert.equal(result, 'mine');
    assert.equal(attempt, 2, 'beforeResolve is retried fresh, not resolved from a cached rejection');
    assert.ok(!dialogEl());
  });

  it('when beforeResolve is omitted, resolution proceeds without it', async () => {
    const p = resolveConflict({ local: 'a', remote: 'b' });
    dialogEl().querySelector('[data-sk-conflict-action="mine"]').click();
    assert.equal(await p, 'mine');
  });
});

// ── cancel semantics ─────────────────────────────────────────────────────

describe('conflict.js: cancel semantics', () => {
  it('Escape rejects with ConflictCancelled, removes the dialog, and restores prior focus', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'opener';
    document.body.appendChild(trigger);
    trigger.focus();

    const p = resolveConflict({ local: 'a', remote: 'b' });
    assert.ok(dialogEl());
    dispatchEscape();

    await assert.rejects(() => p, ConflictCancelled);
    assert.ok(!dialogEl(), 'dialog removed on cancel');
    assert.equal(document.activeElement, trigger, 'focus restored to the element that opened the dialog');
    trigger.remove();
  });

  it('the × close button also cancels with ConflictCancelled', async () => {
    const p = resolveConflict({ local: 'a', remote: 'b' });
    dialogEl().querySelector('.sk-conflict-close').click();
    await assert.rejects(() => p, ConflictCancelled);
    assert.ok(!dialogEl());
  });

  it('rejects specifically with a ConflictCancelled instance (not a generic Error)', async () => {
    const p = resolveConflict({ local: 'a', remote: 'b' });
    dispatchEscape();
    try {
      await p;
      assert.ok(false, 'expected the promise to reject');
    } catch (err) {
      assert.ok(err instanceof ConflictCancelled);
      assert.equal(err.name, 'ConflictCancelled');
    }
  });

  it('cancel is available even while a beforeResolve call is still pending', async () => {
    const d = deferred();
    const p = resolveConflict({ local: 'a', remote: 'b', beforeResolve: () => d.promise });
    dialogEl().querySelector('[data-sk-conflict-action="mine"]').click();
    await sleep(0);
    assert.ok(dialogEl(), 'still open, beforeResolve pending');
    dispatchEscape();
    await assert.rejects(() => p, ConflictCancelled);
    assert.ok(!dialogEl());
    // The abandoned beforeResolve settling later must not throw/resolve anything.
    d.resolve();
    await sleep(0);
  });
});

// ── diff rendering ───────────────────────────────────────────────────────

describe('conflict.js: buildDiffRows (line alignment for the side-by-side view)', () => {
  it('marks unchanged, changed, and added lines for a known input pair', () => {
    const local = 'line1\nline2\nline3\n';
    const remote = 'line1\nCHANGED\nline3\nline4\n';
    const rows = buildDiffRows(local, remote);

    assert.equal(rows[0].type, 'same');
    assert.equal(rows[0].left, 'line1');
    assert.equal(rows[0].right, 'line1');

    const changed = rows.find((r) => r.type === 'changed');
    assert.ok(changed, 'line2 -> CHANGED should be reported as a changed pair, not remove+add');
    assert.equal(changed.left, 'line2');
    assert.equal(changed.right, 'CHANGED');

    assert.ok(rows.some((r) => r.type === 'same' && r.left === 'line3' && r.right === 'line3'));

    const added = rows.find((r) => r.type === 'added');
    assert.ok(added, 'line4 only exists in remote');
    assert.equal(added.left, null);
    assert.equal(added.right, 'line4');
  });

  it('marks a pure removal with a null right side', () => {
    const rows = buildDiffRows('keep\nremoveme\n', 'keep\n');
    const removed = rows.find((r) => r.type === 'removed');
    assert.ok(removed);
    assert.equal(removed.left, 'removeme');
    assert.equal(removed.right, null);
    assert.ok(!rows.some((r) => r.type === 'added'));
  });

  it('identical documents produce only \'same\' rows', () => {
    const text = 'a\nb\nc\n';
    const rows = buildDiffRows(text, text);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.type === 'same' && r.left === r.right));
  });
});

// ── focus trap + Esc ─────────────────────────────────────────────────────

describe('conflict.js: focus trap + Esc', () => {
  it('Tab cycles through the dialog\'s controls and wraps; Shift+Tab wraps backward', async () => {
    const p = resolveConflict({ local: 'a', remote: 'b' });
    const dialog = dialogEl();
    const closeBtn = dialog.querySelector('.sk-conflict-close');
    const mineBtn = dialog.querySelector('[data-sk-conflict-action="mine"]');
    const remoteBtn = dialog.querySelector('[data-sk-conflict-action="remote"]');
    const diffBtn = dialog.querySelector('[data-sk-conflict-action="diff"]');

    assert.equal(document.activeElement, dialog, 'initial focus lands on the dialog container');

    dispatchTab();
    assert.equal(document.activeElement, closeBtn, 'Tab from the container enters the trap at the first control');

    dispatchTab();
    assert.equal(document.activeElement, mineBtn);
    dispatchTab();
    assert.equal(document.activeElement, remoteBtn);
    dispatchTab();
    assert.equal(document.activeElement, diffBtn, 'diff toggle is the last control while the diff section is collapsed');

    dispatchTab();
    assert.equal(document.activeElement, closeBtn, 'Tab from the last control wraps to the first');

    dispatchTab(true);
    assert.equal(document.activeElement, diffBtn, 'Shift+Tab from the first control wraps to the last');

    closeBtn.click();
    await assert.rejects(() => p, ConflictCancelled);
  });

  it('Esc cancels regardless of which control currently has focus', async () => {
    const p = resolveConflict({ local: 'a', remote: 'b' });
    dialogEl().querySelector('[data-sk-conflict-action="remote"]').focus();
    dispatchEscape();
    await assert.rejects(() => p, ConflictCancelled);
  });
});

// ── ARIA surface ─────────────────────────────────────────────────────────

describe('conflict.js: accessibility roles/attributes', () => {
  it('dialog, error region, and diff toggle expose the expected ARIA', async () => {
    const p = resolveConflict({ local: 'a\nb\n', remote: 'a\nc\n' });
    const dialog = dialogEl();

    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.ok(dialog.getAttribute('aria-labelledby'));
    assert.ok(document.getElementById(dialog.getAttribute('aria-labelledby')));
    assert.ok(dialog.getAttribute('aria-describedby'));
    assert.ok(document.getElementById(dialog.getAttribute('aria-describedby')));

    const errorBox = dialog.querySelector('.sk-conflict-error');
    assert.equal(errorBox.getAttribute('role'), 'alert');
    assert.ok(errorBox.hidden, 'no error shown before any failed attempt');

    const diffBtn = dialog.querySelector('[data-sk-conflict-action="diff"]');
    assert.equal(diffBtn.getAttribute('aria-expanded'), 'false');
    assert.ok(dialog.querySelector('#sk-conflict-diff-section').hidden);

    diffBtn.click();
    assert.equal(diffBtn.getAttribute('aria-expanded'), 'true');
    assert.ok(!dialog.querySelector('#sk-conflict-diff-section').hidden);

    const localPane = dialog.querySelector('.sk-conflict-pane-local');
    const remotePane = dialog.querySelector('.sk-conflict-pane-remote');
    assert.ok(localPane && remotePane, 'both diff panes render once expanded');
    assert.equal(localPane.getAttribute('role'), 'group');
    assert.equal(remotePane.getAttribute('role'), 'group');

    dialog.querySelector('.sk-conflict-close').click();
    await assert.rejects(() => p, ConflictCancelled);
  });

  it('diff lines announce status via visually-hidden text, not aria-label (WP-6.3 axe fix)', async () => {
    // aria-label is PROHIBITED on role-less divs (axe aria-prohibited-attr);
    // the change status is real (visually hidden) text content instead.
    const p = resolveConflict({
      local: 'same\nlocal only\n',
      remote: 'same\nremote only\n',
    });
    const dialog = dialogEl();
    dialog.querySelector('[data-sk-conflict-action="diff"]').click();

    const lines = [...dialog.querySelectorAll('.sk-conflict-diffline')];
    assert.ok(lines.length > 0, 'diff lines rendered');
    for (const line of lines) {
      assert.equal(line.getAttribute('aria-label'), null,
        'no diffline carries a (prohibited) aria-label');
    }
    const changedOld = dialog.querySelector('.sk-diff-changed-old .sk-conflict-sr-status');
    const changedNew = dialog.querySelector('.sk-diff-changed-new .sk-conflict-sr-status');
    assert.ok(changedOld, 'changed local line carries the SR status prefix');
    assert.ok(changedNew, 'changed remote line carries the SR status prefix');
    assert.equal(changedOld.textContent, 'Changed, previous version: ');
    assert.equal(changedNew.textContent, 'Changed, new version: ');
    // Unchanged lines have no prefix; their code text is readable content.
    const sameLine = lines.find((l) => !l.className.includes('sk-diff-'));
    assert.ok(sameLine.querySelector('.sk-conflict-sr-status') === null);
    assert.equal(sameLine.querySelector('.sk-conflict-linecode').getAttribute('aria-hidden'), null,
      'code text is no longer aria-hidden');

    dialog.querySelector('.sk-conflict-close').click();
    await assert.rejects(() => p, ConflictCancelled);
  });

  it('diff panes stay scroll-synced', async () => {
    const local = Array.from({ length: 40 }, (_, i) => `local line ${i}`).join('\n') + '\n';
    const remote = Array.from({ length: 40 }, (_, i) => `remote line ${i}`).join('\n') + '\n';
    const p = resolveConflict({ local, remote });
    const dialog = dialogEl();
    dialog.querySelector('[data-sk-conflict-action="diff"]').click();
    const localPane = dialog.querySelector('.sk-conflict-pane-local');
    const remotePane = dialog.querySelector('.sk-conflict-pane-remote');

    localPane.scrollTop = 50;
    localPane.dispatchEvent(new Event('scroll'));
    await sleep(0);
    assert.equal(remotePane.scrollTop, localPane.scrollTop);

    dialog.querySelector('.sk-conflict-close').click();
    await assert.rejects(() => p, ConflictCancelled);
  });
});
