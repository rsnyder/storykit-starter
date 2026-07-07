// tests/unit/preview.test.js  (WP-3.3)
//
// Unit tests for editor/preview.js — the preview pane (docs/editor-plan.md
// §1.2, docs/editor-spec.md FR-PRE.1/3/5). Covers the pure helpers
// (nearestAnchor / resolveScrollRestore mapping table, render-token
// staleness, debounce coalescing) and the DOM component
// (renderDiagnosticsPanel from a canned array; createPreviewPane wired
// against injected fake buildContext/renderPost — per the file's
// documented test-seam choice, a real skrender render is explicitly out of
// scope here, that's WP-3.4's e2e job).
window.__SK_NO_AUTOBOOT = true;

import { describe, it, assert } from './runner.js';
import { bus } from '../../editor/app.js';
import {
  nearestAnchor,
  resolveScrollRestore,
  createRenderToken,
  debounce,
  renderDiagnosticsPanel,
  createPreviewPane,
} from '../../editor/preview.js';

// ── test helpers ────────────────────────────────────────────────────────

async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('waitFor: condition not met before timeout');
}

function makeMount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** A promise + external resolve/reject, for controlling async ordering. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ═════════════════════════════════════════════════════════════════════════
// nearestAnchor (FR-PRE.3) — mapping table
// ═════════════════════════════════════════════════════════════════════════

describe('preview: nearestAnchor (FR-PRE.3 scroll capture)', () => {
  const headings = [
    { id: 'intro', top: 0 },
    { id: 'section-a', top: 100 },
    { id: 'section-b', top: 300 },
  ];

  it('exact hit — scrollY equal to a heading top returns that heading', () => {
    assert.equal(nearestAnchor(headings, 100), 'section-a');
    assert.equal(nearestAnchor(headings, 0), 'intro');
  });

  it('between headings — returns the nearest one above scrollY', () => {
    assert.equal(nearestAnchor(headings, 150), 'section-a');
    assert.equal(nearestAnchor(headings, 299), 'section-a');
  });

  it('above first — scrollY before the first heading returns null', () => {
    const shifted = [{ id: 'intro', top: 50 }, { id: 'section-a', top: 200 }];
    assert.equal(nearestAnchor(shifted, 10), null);
  });

  it('past last — scrollY beyond the last heading returns the last heading', () => {
    assert.equal(nearestAnchor(headings, 10000), 'section-b');
  });

  it('empty headings list returns null', () => {
    assert.equal(nearestAnchor([], 500), null);
  });

  it('non-array input returns null defensively', () => {
    assert.equal(nearestAnchor(null, 500), null);
    assert.equal(nearestAnchor(undefined, 500), null);
  });
});

describe('preview: resolveScrollRestore (missing-after-rerender fallback)', () => {
  const newHeadings = [
    { id: 'intro', top: 0 },
    { id: 'section-a', top: 120 },
  ];

  it('anchor still present — restores to its new top', () => {
    assert.equal(resolveScrollRestore('section-a', newHeadings), 120);
  });

  it('anchor missing after re-render — falls back to top (0)', () => {
    assert.equal(resolveScrollRestore('section-removed', newHeadings), 0);
  });

  it('no anchor recorded — falls back to top (0)', () => {
    assert.equal(resolveScrollRestore(null, newHeadings), 0);
    assert.equal(resolveScrollRestore(undefined, newHeadings), 0);
  });

  it('non-array headings falls back to top (0)', () => {
    assert.equal(resolveScrollRestore('section-a', null), 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Render-token staleness (concurrency helper, extracted for direct testing)
// ═════════════════════════════════════════════════════════════════════════

describe('preview: createRenderToken (render staleness)', () => {
  it('the most recently drawn token is current', () => {
    const t = createRenderToken();
    const a = t.next();
    assert.ok(t.isCurrent(a));
  });

  it('an older token is no longer current once a newer one is drawn', () => {
    const t = createRenderToken();
    const a = t.next();
    const b = t.next();
    assert.ok(!t.isCurrent(a), 'older token a should be stale');
    assert.ok(t.isCurrent(b), 'newest token b should be current');
  });

  it('tokens increase monotonically across many draws', () => {
    const t = createRenderToken();
    let last = t.next();
    for (let i = 0; i < 20; i++) {
      const next = t.next();
      assert.ok(next > last);
      last = next;
    }
    assert.ok(t.isCurrent(last));
  });
});

// ═════════════════════════════════════════════════════════════════════════
// debounce coalescing
// ═════════════════════════════════════════════════════════════════════════

describe('preview: debounce coalescing', () => {
  it('coalesces rapid calls into a single trailing invocation with the last args', async () => {
    const calls = [];
    const scheduled = debounce((v) => calls.push(v), 20);
    scheduled('first');
    scheduled('second');
    scheduled('third');
    assert.equal(calls.length, 0, 'must not fire synchronously');
    await waitFor(() => calls.length === 1);
    assert.deepEqual(calls, ['third']);
  });

  it('separate bursts each produce their own invocation', async () => {
    const calls = [];
    const scheduled = debounce((v) => calls.push(v), 15);
    scheduled('a');
    await waitFor(() => calls.length === 1);
    scheduled('b');
    await waitFor(() => calls.length === 2);
    assert.deepEqual(calls, ['a', 'b']);
  });

  it('cancel() drops a pending invocation', async () => {
    const calls = [];
    const scheduled = debounce((v) => calls.push(v), 15);
    scheduled('x');
    scheduled.cancel();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(calls.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// renderDiagnosticsPanel — DOM from a canned diagnostics array
// ═════════════════════════════════════════════════════════════════════════

describe('preview: renderDiagnosticsPanel (FR-PRE.5)', () => {
  it('info-only diagnostics start collapsed', () => {
    const panel = renderDiagnosticsPanel([
      { level: 'info', stage: 'layout', message: 'post → default' },
    ]);
    assert.equal(panel.dataset.collapsed, 'true');
    assert.equal(panel.querySelector('.pv-diagnostics-toggle').getAttribute('aria-expanded'), 'false');
  });

  it('empty diagnostics array also starts collapsed and is marked empty', () => {
    const panel = renderDiagnosticsPanel([]);
    assert.equal(panel.dataset.collapsed, 'true');
    assert.ok(panel.classList.contains('pv-diagnostics-empty'));
  });

  it('a warning diagnostic starts the panel expanded', () => {
    const panel = renderDiagnosticsPanel([
      { level: 'warn', stage: 'layout', message: "Layout 'post' produced no output" },
    ]);
    assert.equal(panel.dataset.collapsed, 'false');
    assert.equal(panel.querySelector('.pv-diagnostics-toggle').getAttribute('aria-expanded'), 'true');
  });

  it('an error diagnostic starts the panel expanded and its summary mentions the count', () => {
    const panel = renderDiagnosticsPanel([
      { level: 'error', stage: 'fetch', message: 'boom' },
      { level: 'warn', stage: 'layout', message: 'meh' },
    ]);
    assert.equal(panel.dataset.collapsed, 'false');
    assert.ok(/1 error/.test(panel.querySelector('.pv-diagnostics-toggle').textContent));
  });

  it('toggle button flips data-collapsed on click', () => {
    const panel = renderDiagnosticsPanel([{ level: 'warn', stage: 'liquid', message: 'oops' }]);
    document.body.appendChild(panel);
    try {
      const toggle = panel.querySelector('.pv-diagnostics-toggle');
      assert.equal(panel.dataset.collapsed, 'false');
      toggle.click();
      assert.equal(panel.dataset.collapsed, 'true');
      toggle.click();
      assert.equal(panel.dataset.collapsed, 'false');
    } finally {
      panel.remove();
    }
  });

  it('renders one <li> per diagnostic, styled by level', () => {
    const panel = renderDiagnosticsPanel([
      { level: 'error', stage: 'liquid', message: 'e1' },
      { level: 'warn', stage: 'layout', message: 'w1' },
      { level: 'info', stage: 'layout', message: 'i1' },
    ]);
    const items = panel.querySelectorAll('.pv-diag');
    assert.equal(items.length, 3);
    assert.ok(items[0].classList.contains('pv-diag-error'));
    assert.ok(items[1].classList.contains('pv-diag-warn'));
    assert.ok(items[2].classList.contains('pv-diag-info'));
  });

  it('entries with a numeric line render a clickable "Line N" button that invokes onGotoLine', () => {
    let got = null;
    const panel = renderDiagnosticsPanel([
      { level: 'warn', stage: 'liquid', message: 'bad tag', line: 42 },
      { level: 'info', stage: 'layout', message: 'no line here' },
    ], { onGotoLine: (line) => { got = line; } });

    const gotoButtons = panel.querySelectorAll('.pv-diag-goto');
    assert.equal(gotoButtons.length, 1, 'only the line-bearing entry gets a goto button');
    assert.equal(gotoButtons[0].textContent, 'Line 42');
    gotoButtons[0].click();
    assert.equal(got, 42);
  });

  it('line 0 (falsy but finite) still renders a goto button', () => {
    const panel = renderDiagnosticsPanel([{ level: 'warn', stage: 'liquid', message: 'x', line: 0 }]);
    assert.equal(panel.querySelectorAll('.pv-diag-goto').length, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// createPreviewPane — DOM component wired against injected fakes
// ═════════════════════════════════════════════════════════════════════════

describe('preview: createPreviewPane argument validation', () => {
  it('throws without a mount', () => {
    assert.throws(() => createPreviewPane({}), /mount is required/);
    assert.throws(() => createPreviewPane(), /mount is required/);
  });
});

describe('preview: createPreviewPane render() happy path', () => {
  it('writes renderPost html into the iframe srcdoc and injects styles once', async () => {
    const mount = makeMount();
    const pane = createPreviewPane({
      mount,
      buildContext: async ({ binding }) => ({ config: {}, binding }),
      renderPost: async ({ content }) => ({
        html: `<html><body>${content}</body></html>`,
        diagnostics: [{ level: 'info', stage: 'layout', message: 'post → default' }],
      }),
    });
    try {
      await pane.render({ content: 'hello world', path: '_posts/x.md', binding: null });
      const iframe = mount.querySelector('iframe.pv-frame');
      assert.ok(iframe, 'expected an iframe.pv-frame to be mounted');
      assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts allow-same-origin allow-popups allow-forms allow-modals');
      assert.ok(iframe.srcdoc.includes('hello world'));
      assert.ok(document.getElementById('sk-preview-styles'), 'expected the idempotent style tag to be injected');
      assert.equal(mount.querySelectorAll('#sk-preview-styles').length, 0, 'style belongs on <head>, not duplicated into mount');
    } finally {
      pane.destroy();
      mount.remove();
    }
  });

  it('merges context.diagnostics ahead of renderPost diagnostics', async () => {
    const mount = makeMount();
    const pane = createPreviewPane({
      mount,
      buildContext: async () => ({ diagnostics: [{ level: 'warn', stage: 'fetch', message: 'stale cache' }] }),
      renderPost: async () => ({
        html: '<html><body>ok</body></html>',
        diagnostics: [{ level: 'info', stage: 'layout', message: 'post → default' }],
      }),
    });
    try {
      await pane.render({ content: 'x', path: 'p.md', binding: null });
      const items = mount.querySelectorAll('.pv-diag');
      assert.equal(items.length, 2);
      assert.ok(items[0].classList.contains('pv-diag-warn'));
      assert.ok(items[1].classList.contains('pv-diag-info'));
    } finally {
      pane.destroy();
      mount.remove();
    }
  });

  it('clicking a line-bearing diagnostic emits preview:goto-line on the shared bus', async () => {
    const mount = makeMount();
    const pane = createPreviewPane({
      mount,
      buildContext: async () => ({}),
      renderPost: async () => ({
        html: '<html><body>x</body></html>',
        diagnostics: [{ level: 'warn', stage: 'liquid', message: 'bad tag', line: 7 }],
      }),
    });
    try {
      await pane.render({ content: 'x', path: 'p.md', binding: null });
      const gotEvent = new Promise((resolve) => {
        bus.addEventListener('preview:goto-line', (e) => resolve(e.detail), { once: true });
      });
      mount.querySelector('.pv-diag-goto').click();
      const detail = await gotEvent;
      assert.deepEqual(detail, { line: 7 });
    } finally {
      pane.destroy();
      mount.remove();
    }
  });
});

describe('preview: createPreviewPane never a blank iframe (FR-PRE.5)', () => {
  it('a buildContext rejection writes a styled inline error document, not a blank iframe', async () => {
    const mount = makeMount();
    const pane = createPreviewPane({
      mount,
      buildContext: async () => { throw new Error('context boom'); },
      renderPost: async () => { throw new Error('should not be reached'); },
    });
    try {
      await pane.render({ content: 'x', path: 'p.md', binding: null });
      const iframe = mount.querySelector('iframe.pv-frame');
      assert.ok(iframe.srcdoc.includes('context boom'));
      assert.ok(iframe.srcdoc.includes('Preview failed to render'));
      assert.ok(iframe.srcdoc.trim().length > 0, 'iframe must never be blank');
      const errorItems = mount.querySelectorAll('.pv-diag-error');
      assert.equal(errorItems.length, 1);
      assert.ok(mount.querySelector('.pv-diagnostics').dataset.collapsed === 'false', 'panel expands on error');
    } finally {
      pane.destroy();
      mount.remove();
    }
  });

  it('a renderPost rejection also produces the inline error document', async () => {
    const mount = makeMount();
    const pane = createPreviewPane({
      mount,
      buildContext: async () => ({}),
      renderPost: async () => { throw new Error('liquid explode'); },
    });
    try {
      await pane.render({ content: 'x', path: 'p.md', binding: null });
      const iframe = mount.querySelector('iframe.pv-frame');
      assert.ok(iframe.srcdoc.includes('liquid explode'));
    } finally {
      pane.destroy();
      mount.remove();
    }
  });
});

describe('preview: render() concurrency — stale completions never interleave', () => {
  it('a slow first render() is discarded when a second render() finishes first', async () => {
    const mount = makeMount();
    const defs = [];
    const pane = createPreviewPane({
      mount,
      buildContext: async () => ({}),
      renderPost: async ({ content }) => {
        const d = deferred();
        defs.push(d);
        const resolvedContent = await d.promise;
        return { html: `<html><body>${resolvedContent}</body></html>`, diagnostics: [] };
      },
    });
    try {
      const p1 = pane.render({ content: 'first', path: 'p.md', binding: null });
      await waitFor(() => defs.length === 1);
      const p2 = pane.render({ content: 'second', path: 'p.md', binding: null });
      await waitFor(() => defs.length === 2);

      // Resolve the SECOND (newer) render's promise first — simulates a fast
      // completion overtaking a slower, now-stale in-flight render.
      defs[1].resolve('second');
      await p2;
      const iframe = mount.querySelector('iframe.pv-frame');
      assert.ok(iframe.srcdoc.includes('second'), 'newer render should have won');

      // Now resolve the STALE first render — it must be silently discarded.
      defs[0].resolve('first');
      await p1;
      assert.ok(iframe.srcdoc.includes('second'), 'stale first render must not overwrite the newer content');
      assert.ok(!iframe.srcdoc.includes('>first<'), 'stale content must never reach the iframe');
    } finally {
      pane.destroy();
      mount.remove();
    }
  });
});

describe('preview: schedule() debounces render() calls', () => {
  it('coalesces rapid schedule() calls into a single render() with the last args', async () => {
    const mount = makeMount();
    const seen = [];
    const pane = createPreviewPane({
      mount,
      debounceMs: 20,
      buildContext: async () => ({}),
      renderPost: async ({ content }) => {
        seen.push(content);
        return { html: `<html><body>${content}</body></html>`, diagnostics: [] };
      },
    });
    try {
      pane.schedule({ content: 'a', path: 'p.md', binding: null });
      pane.schedule({ content: 'b', path: 'p.md', binding: null });
      pane.schedule({ content: 'c', path: 'p.md', binding: null });
      assert.equal(seen.length, 0, 'must not render synchronously');
      await waitFor(() => seen.length === 1);
      assert.deepEqual(seen, ['c']);
    } finally {
      pane.destroy();
      mount.remove();
    }
  });

  it('destroy() cancels a pending scheduled render', async () => {
    const mount = makeMount();
    let called = false;
    const pane = createPreviewPane({
      mount,
      debounceMs: 15,
      buildContext: async () => ({}),
      renderPost: async () => { called = true; return { html: '<html></html>', diagnostics: [] }; },
    });
    pane.schedule({ content: 'x', path: 'p.md', binding: null });
    pane.destroy();
    mount.remove();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(!called, 'renderPost must not run after destroy()');
  });
});
