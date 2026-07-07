// tests/unit/palette.test.js  (WP-6.1)
//
// Covers editor/palette.js: open/close/isOpen, the fuzzy-ish substring
// filter (matchesQuery), ArrowUp/Down navigation + Enter-to-run, when()
// gating (re-evaluated live on every open()), grouping/shortcut rendering,
// and the focus trap (Tab cycling + Escape + backdrop click), all driven
// with the same synthetic-DOM-event technique already established by
// tests/unit/wikidata.test.js and tests/unit/conflict.test.js.

import { describe, it, assert } from './runner.js';
import { createPalette, matchesQuery } from '../../editor/palette.js';

function mkMount() {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
}

function press(el, key, extra = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
}

// ── matchesQuery ─────────────────────────────────────────────────────────

describe('palette: matchesQuery (fuzzy-ish filter)', () => {
  it('an empty query matches everything', () => {
    assert.ok(matchesQuery('', 'Insert link'));
    assert.ok(matchesQuery('   ', 'Insert link'));
  });

  it('matches a literal substring, case-insensitively', () => {
    assert.ok(matchesQuery('link', 'Insert link'));
    assert.ok(matchesQuery('LINK', 'Insert link'));
    assert.ok(matchesQuery('insert', 'Insert link'));
  });

  it('falls back to an in-order character-subsequence match', () => {
    assert.ok(matchesQuery('ivw', 'Insert Viewer'), 'i, v, w appear in that order');
    assert.ok(matchesQuery('nwp', 'New post'));
  });

  it('rejects a query whose characters are out of order or absent', () => {
    assert.ok(!matchesQuery('zzz', 'Insert link'));
    assert.ok(!matchesQuery('kl', 'link')); // 'k' before 'l' — wrong order
  });
});

// ── open / filter / navigate / run ─────────────────────────────────────

describe('palette: open/filter/navigate/run', () => {
  function mkCommands(calls) {
    return [
      { id: 'a', label: 'Bold', group: 'Format', shortcut: '⌘B', run: () => calls.push('a') },
      { id: 'b', label: 'Italic', group: 'Format', run: () => calls.push('b') },
      { id: 'c', label: 'New post', group: 'Document', run: () => calls.push('c') },
    ];
  }

  it('open() renders every command (no query), each with its label; a shortcut hint renders when provided', () => {
    const mount = mkMount();
    const calls = [];
    const p = createPalette({ mount, commands: mkCommands(calls) });
    try {
      p.open();
      assert.ok(p.isOpen());
      const items = mount.querySelectorAll('.sk-palette-item');
      assert.equal(items.length, 3);
      const boldItem = mount.querySelector('[data-sk-palette-id="a"]');
      assert.ok(boldItem);
      assert.equal(boldItem.querySelector('.sk-palette-item-shortcut').textContent, '⌘B');
      const italicItem = mount.querySelector('[data-sk-palette-id="b"]');
      assert.equal(italicItem.querySelector('.sk-palette-item-shortcut'), null, 'no shortcut → no pill');
    } finally {
      p.destroy();
      mount.remove();
    }
  });

  it('typing filters the list to matching entries', () => {
    const mount = mkMount();
    const calls = [];
    const p = createPalette({ mount, commands: mkCommands(calls) });
    try {
      p.open();
      const input = mount.querySelector('.sk-palette-input');
      input.value = 'bold';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const items = mount.querySelectorAll('.sk-palette-item');
      assert.equal(items.length, 1);
      assert.equal(items[0].dataset.skPaletteId, 'a');
    } finally {
      p.destroy();
      mount.remove();
    }
  });

  it('a query matching nothing shows an empty state, not a stale list', () => {
    const mount = mkMount();
    const calls = [];
    const p = createPalette({ mount, commands: mkCommands(calls) });
    try {
      p.open();
      const input = mount.querySelector('.sk-palette-input');
      input.value = 'zzz-no-match';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      assert.equal(mount.querySelectorAll('.sk-palette-item').length, 0);
      assert.ok(mount.querySelector('.sk-palette-empty'));
    } finally {
      p.destroy();
      mount.remove();
    }
  });

  it('ArrowDown/ArrowUp move the active item and Enter runs it, closing the palette', () => {
    const mount = mkMount();
    const calls = [];
    const p = createPalette({ mount, commands: mkCommands(calls) });
    try {
      p.open();
      const input = mount.querySelector('.sk-palette-input');
      press(input, 'ArrowDown'); // a -> b
      const active = mount.querySelector('.sk-palette-item.is-active');
      assert.equal(active.dataset.skPaletteId, 'b');
      press(input, 'Enter');
      assert.deepEqual(calls, ['b']);
      assert.ok(!p.isOpen(), 'palette closes after running a command');
    } finally {
      p.destroy();
      mount.remove();
    }
  });

  it('ArrowUp from the first item wraps to the last', () => {
    const mount = mkMount();
    const calls = [];
    const p = createPalette({ mount, commands: mkCommands(calls) });
    try {
      p.open();
      const input = mount.querySelector('.sk-palette-input');
      press(input, 'ArrowUp');
      const active = mount.querySelector('.sk-palette-item.is-active');
      assert.equal(active.dataset.skPaletteId, 'c', 'wrapped to the last (3rd) entry');
    } finally {
      p.destroy();
      mount.remove();
    }
  });

  it('clicking an item runs it and closes the palette', () => {
    const mount = mkMount();
    const calls = [];
    const p = createPalette({ mount, commands: mkCommands(calls) });
    try {
      p.open();
      mount.querySelector('[data-sk-palette-id="c"]').click();
      assert.deepEqual(calls, ['c']);
      assert.ok(!p.isOpen());
    } finally {
      p.destroy();
      mount.remove();
    }
  });

  it('groups render as headers, and an empty group after filtering is omitted', () => {
    const mount = mkMount();
    const calls = [];
    const p = createPalette({ mount, commands: mkCommands(calls) });
    try {
      p.open();
      const groups = Array.from(mount.querySelectorAll('.sk-palette-group-label')).map((g) => g.textContent);
      assert.deepEqual(groups, ['Format', 'Document']);

      const input = mount.querySelector('.sk-palette-input');
      input.value = 'new post';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const groupsAfter = Array.from(mount.querySelectorAll('.sk-palette-group-label')).map((g) => g.textContent);
      assert.deepEqual(groupsAfter, ['Document'], '"Format" group header omitted once empty');
    } finally {
      p.destroy();
      mount.remove();
    }
  });

  it('re-open() resets the filter text and active index', () => {
    const mount = mkMount();
    const calls = [];
    const p = createPalette({ mount, commands: mkCommands(calls) });
    try {
      p.open();
      const input = mount.querySelector('.sk-palette-input');
      input.value = 'italic';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      p.close();
      p.open();
      assert.equal(mount.querySelector('.sk-palette-input').value, '');
      assert.equal(mount.querySelectorAll('.sk-palette-item').length, 3);
    } finally {
      p.destroy();
      mount.remove();
    }
  });
});

// ── when() gating ─────────────────────────────────────────────────────────

describe('palette: when() gating', () => {
  it('an entry whose when() returns false is omitted from that open(), and reappears once when() flips true', () => {
    const mount = mkMount();
    let bound = false;
    const commands = [
      { id: 'always', label: 'Always here', group: 'G', run: () => {} },
      { id: 'gated', label: 'Commit', group: 'G', when: () => bound, run: () => {} },
    ];
    const p = createPalette({ mount, commands });
    try {
      p.open();
      assert.equal(mount.querySelectorAll('.sk-palette-item').length, 1);
      assert.ok(mount.querySelector('[data-sk-palette-id="always"]'));
      assert.equal(mount.querySelector('[data-sk-palette-id="gated"]'), null);
      p.close();

      bound = true;
      p.open();
      assert.equal(mount.querySelectorAll('.sk-palette-item').length, 2);
      assert.ok(mount.querySelector('[data-sk-palette-id="gated"]'));
    } finally {
      p.destroy();
      mount.remove();
    }
  });
});

// ── focus trap ────────────────────────────────────────────────────────────

describe('palette: focus trap + Escape', () => {
  it('focuses the input on open(); Escape closes and returns focus to the previously-focused element', () => {
    const mount = mkMount();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const p = createPalette({ mount, commands: [{ id: 'x', label: 'X', group: 'G', run: () => {} }] });
    try {
      p.open();
      assert.equal(document.activeElement, mount.querySelector('.sk-palette-input'));
      press(document.activeElement, 'Escape');
      assert.ok(!p.isOpen());
      assert.equal(document.activeElement, trigger);
    } finally {
      p.destroy();
      mount.remove();
      trigger.remove();
    }
  });

  it('clicking the backdrop (outside the dialog) closes the palette', () => {
    const mount = mkMount();
    const p = createPalette({ mount, commands: [{ id: 'x', label: 'X', group: 'G', run: () => {} }] });
    try {
      p.open();
      const backdrop = mount.querySelector('.sk-palette-backdrop');
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      assert.ok(!p.isOpen());
    } finally {
      p.destroy();
      mount.remove();
    }
  });

  it('destroy() while open leaves no palette DOM behind', () => {
    const mount = mkMount();
    const p = createPalette({ mount, commands: [{ id: 'x', label: 'X', group: 'G', run: () => {} }] });
    p.open();
    p.destroy();
    assert.equal(mount.querySelector('.sk-palette-backdrop'), null);
    mount.remove();
  });
});
