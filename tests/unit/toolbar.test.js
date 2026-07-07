// tests/unit/toolbar.test.js  (WP-6.1)
//
// Covers editor/toolbar.js: the pure `buildViewerSnippet()` helper (required
// attrs present, placeholder offsets, the embed/image.html required-attr-less
// fallback), `insertViewerTag()`'s CM6 insertion + the Tab-jump-between-
// placeholders extension, `insertListItem()`, and `createToolbar()`'s button
// wiring + the Insert-viewer dropdown (open/filter-free select, keyboard nav).

import { describe, it, assert } from './runner.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
  createToolbar, buildViewerSnippet, insertViewerTag, insertListItem,
  viewerSnippetExtension, VIEWER_KEYS, VIEWER_LABELS,
} from '../../editor/toolbar.js';
import { catalog } from '../../editor/viewer-catalog.js';

// ── helpers ─────────────────────────────────────────────────────────────

function mountView(doc, pos = 0, extraExtensions = []) {
  const parent = document.createElement('div');
  parent.style.width = '600px';
  parent.style.height = '300px';
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: extraExtensions,
    }),
    parent,
  });
  return {
    view,
    destroy() {
      view.destroy();
      parent.remove();
    },
  };
}

// ── buildViewerSnippet ─────────────────────────────────────────────────

describe('toolbar: buildViewerSnippet (pure)', () => {
  it('returns null for an unknown catalog key', () => {
    assert.equal(buildViewerSnippet('embed/nope.html'), null);
  });

  it('every one of the six catalog entries produces at least one placeholder', () => {
    for (const key of VIEWER_KEYS) {
      const snippet = buildViewerSnippet(key);
      assert.ok(snippet, `expected a snippet for ${key}`);
      assert.ok(snippet.placeholders.length >= 1, `${key} should have >=1 placeholder`);
      assert.ok(snippet.tag.startsWith(`{% include ${key}`), snippet.tag);
      assert.ok(snippet.tag.endsWith(' %}'), snippet.tag);
    }
  });

  it('uses every attr marked required:true (embed/map.html: center)', () => {
    const snippet = buildViewerSnippet('embed/map.html');
    assert.deepEqual(snippet.attrs, ['center']);
    assert.equal(snippet.tag, '{% include embed/map.html center="" %}');
    // Cursor sits between the two quotes of center="".
    const [pos] = snippet.placeholders;
    assert.equal(snippet.tag.slice(pos - 1, pos + 1), '""');
  });

  it('multi-required-attr tag gets one placeholder per attr, in catalog order (embed/image-compare.html)', () => {
    const snippet = buildViewerSnippet('embed/image-compare.html');
    assert.deepEqual(snippet.attrs, ['before', 'after']);
    assert.equal(snippet.tag, '{% include embed/image-compare.html before="" after="" %}');
    assert.equal(snippet.placeholders.length, 2);
    const [p1, p2] = snippet.placeholders;
    assert.ok(p1 < p2, 'placeholders should be in left-to-right document order');
    assert.equal(snippet.tag.slice(p1 - 1, p1 + 1), '""');
    assert.equal(snippet.tag.slice(p2 - 1, p2 + 1), '""');
  });

  it('embed/image.html has no required:true attr in the catalog — falls back to its first listed attr (src)', () => {
    // Sanity-check the premise: the catalog really has zero required attrs here
    // (the "src or manifest" requirement is a disjunction the schema can't
    // express as a single flag — see toolbar.js's header note).
    const required = Object.entries(catalog['embed/image.html'].attrs).filter(([, a]) => a.required);
    assert.equal(required.length, 0, 'premise check: image.html has no required:true attrs');

    const snippet = buildViewerSnippet('embed/image.html');
    assert.deepEqual(snippet.attrs, ['src']);
    assert.equal(snippet.tag, '{% include embed/image.html src="" %}');
  });

  it('VIEWER_LABELS covers exactly the six catalog embeds VIEWER_KEYS lists', () => {
    assert.equal(VIEWER_KEYS.length, 6);
    for (const key of VIEWER_KEYS) {
      assert.ok(VIEWER_LABELS[key], `expected a label for ${key}`);
      assert.ok(catalog[key], `${key} should be a real catalog entry`);
    }
  });
});

// ── insertViewerTag ──────────────────────────────────────────────────────

describe('toolbar: insertViewerTag (CM6 insertion)', () => {
  it('inserts the tag on its own line, blank-line surrounded, cursor in the first placeholder', () => {
    const { view, destroy } = mountView('Some prose.\nMore prose.', 11, [viewerSnippetExtension()]);
    try {
      const ok = insertViewerTag(view, 'embed/map.html');
      assert.equal(ok, true);
      assert.equal(
        view.state.doc.toString(),
        'Some prose.\n\n{% include embed/map.html center="" %}\n\nMore prose.'
      );
      const head = view.state.selection.main.head;
      assert.equal(view.state.sliceDoc(head - 1, head + 1), '""', 'cursor between the placeholder quotes');
    } finally {
      destroy();
    }
  });

  it('omits leading/trailing blank lines at document boundaries', () => {
    const { view, destroy } = mountView('', 0, [viewerSnippetExtension()]);
    try {
      insertViewerTag(view, 'embed/youtube.html');
      assert.equal(view.state.doc.toString(), '{% include embed/youtube.html vid="" %}');
    } finally {
      destroy();
    }
  });

  it('an unknown key is a no-op (returns false, doc untouched)', () => {
    const { view, destroy } = mountView('unchanged', 0);
    try {
      const ok = insertViewerTag(view, 'embed/nope.html');
      assert.equal(ok, false);
      assert.equal(view.state.doc.toString(), 'unchanged');
    } finally {
      destroy();
    }
  });

  it('Tab jumps to the next placeholder for a multi-placeholder snippet, then falls through to normal Tab afterward', () => {
    const { view, destroy } = mountView('', 0, [viewerSnippetExtension()]);
    try {
      insertViewerTag(view, 'embed/image-compare.html');
      const firstHead = view.state.selection.main.head;
      assert.equal(view.state.sliceDoc(firstHead - 8, firstHead + 1), 'before=""');

      // Dispatch a real Tab keydown at the view's DOM — exercises the actual
      // keymap binding, not just calling the run() function directly.
      const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(evt);

      const secondHead = view.state.selection.main.head;
      assert.ok(secondHead !== firstHead, 'Tab should have moved the cursor to the next placeholder');
      assert.equal(view.state.sliceDoc(secondHead - 7, secondHead + 1), 'after=""');

      // A further Tab has no more placeholders queued — the extension's own
      // binding returns false, so it doesn't consume the event.
      const before = view.state.doc.toString();
      const evt2 = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(evt2);
      // Selection may or may not move (depends on whatever falls through),
      // but the DOCUMENT must be unaffected by our own extension a second time.
      assert.equal(view.state.doc.toString(), before);
    } finally {
      destroy();
    }
  });

  it('a single-placeholder snippet leaves nothing for Tab to jump to (Tab is a no-op for this extension)', () => {
    const { view, destroy } = mountView('', 0, [viewerSnippetExtension()]);
    try {
      insertViewerTag(view, 'embed/map.html');
      const headBefore = view.state.selection.main.head;
      const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(evt);
      assert.equal(view.state.selection.main.head, headBefore, 'no second placeholder to jump to');
    } finally {
      destroy();
    }
  });
});

// ── insertListItem ────────────────────────────────────────────────────────

describe('toolbar: insertListItem', () => {
  it('inserts a "- " bullet at the start of the current line', () => {
    const { view, destroy } = mountView('hello world', 3);
    try {
      insertListItem(view);
      assert.equal(view.state.doc.toString(), '- hello world');
      assert.equal(view.state.selection.main.head, 5); // 3 + 2 (marker length)
    } finally {
      destroy();
    }
  });

  it('is a no-op on a line that already looks like a list item', () => {
    for (const line of ['- item', '* item', '+ item', '1. item', '2) item']) {
      const { view, destroy } = mountView(line, 2);
      try {
        insertListItem(view);
        assert.equal(view.state.doc.toString(), line, `expected no change for "${line}"`);
      } finally {
        destroy();
      }
    }
  });

  it('operates on the current line only, leaving the rest of a multi-line doc untouched', () => {
    const { view, destroy } = mountView('first\nsecond\nthird', 'first\n'.length + 2);
    try {
      insertListItem(view);
      assert.equal(view.state.doc.toString(), 'first\n- second\nthird');
    } finally {
      destroy();
    }
  });
});

// ── createToolbar ──────────────────────────────────────────────────────────

describe('toolbar: createToolbar (DOM + action dispatch)', () => {
  function mkMount() {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    return mount;
  }

  it('renders one button per §7 action plus the Insert-viewer dropdown, all with aria-labels', () => {
    const mount = mkMount();
    const handle = createToolbar({ mount, actions: {} });
    try {
      assert.ok(mount.querySelector('.sk-toolbar'), 'toolbar root rendered');
      for (const action of ['bold', 'italic', 'link', 'heading', 'list', 'insert-viewer', 'link-entity']) {
        const btn = mount.querySelector(`[data-sk-toolbar-action="${action}"]`);
        assert.ok(btn, `expected a button for action "${action}"`);
        assert.ok(btn.getAttribute('aria-label'), `${action} button should have an aria-label`);
      }
    } finally {
      handle.destroy();
      mount.remove();
    }
  });

  it('dispatches the provided zero-arg action callbacks on click', () => {
    const mount = mkMount();
    const calls = [];
    const actions = {
      bold: () => calls.push('bold'),
      italic: () => calls.push('italic'),
      link: () => calls.push('link'),
      heading: () => calls.push('heading'),
      list: () => calls.push('list'),
      linkEntity: () => calls.push('linkEntity'),
    };
    const handle = createToolbar({ mount, actions });
    try {
      mount.querySelector('[data-sk-toolbar-action="bold"]').click();
      mount.querySelector('[data-sk-toolbar-action="italic"]').click();
      mount.querySelector('[data-sk-toolbar-action="link"]').click();
      mount.querySelector('[data-sk-toolbar-action="heading"]').click();
      mount.querySelector('[data-sk-toolbar-action="list"]').click();
      mount.querySelector('[data-sk-toolbar-action="link-entity"]').click();
      assert.deepEqual(calls, ['bold', 'italic', 'link', 'heading', 'list', 'linkEntity']);
    } finally {
      handle.destroy();
      mount.remove();
    }
  });

  it('a missing action callback is a harmless no-op (defensive)', () => {
    const mount = mkMount();
    const handle = createToolbar({ mount, actions: {} });
    try {
      mount.querySelector('[data-sk-toolbar-action="bold"]').click(); // must not throw
      assert.ok(true, 'click on an unwired action did not throw');
    } finally {
      handle.destroy();
      mount.remove();
    }
  });

  it('Insert-viewer dropdown opens on click, lists all six embeds, and picking one calls actions.insertViewer(key)', () => {
    const mount = mkMount();
    const picks = [];
    const handle = createToolbar({ mount, actions: { insertViewer: (key) => picks.push(key) } });
    try {
      const trigger = mount.querySelector('[data-sk-toolbar-action="insert-viewer"]');
      trigger.click();
      const menu = document.querySelector('.sk-toolbar-viewer-menu');
      assert.ok(menu, 'dropdown menu opened');
      const items = menu.querySelectorAll('[data-sk-viewer-key]');
      assert.equal(items.length, VIEWER_KEYS.length);

      const mapItem = menu.querySelector('[data-sk-viewer-key="embed/map.html"]');
      assert.ok(mapItem);
      mapItem.click();

      assert.deepEqual(picks, ['embed/map.html']);
      assert.equal(document.querySelector('.sk-toolbar-viewer-menu'), null, 'menu closes after a pick');
    } finally {
      handle.destroy();
      mount.remove();
    }
  });

  it('Escape closes the dropdown and returns focus to the trigger', () => {
    const mount = mkMount();
    const handle = createToolbar({ mount, actions: {} });
    try {
      const trigger = mount.querySelector('[data-sk-toolbar-action="insert-viewer"]');
      trigger.click();
      const firstItem = document.querySelector('[data-sk-viewer-key]');
      firstItem.focus();
      firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(document.querySelector('.sk-toolbar-viewer-menu'), null);
      assert.equal(document.activeElement, trigger);
    } finally {
      handle.destroy();
      mount.remove();
    }
  });

  it('destroy() closes any open dropdown and clears the mount', () => {
    const mount = mkMount();
    const handle = createToolbar({ mount, actions: {} });
    mount.querySelector('[data-sk-toolbar-action="insert-viewer"]').click();
    assert.ok(document.querySelector('.sk-toolbar-viewer-menu'));
    handle.destroy();
    assert.equal(document.querySelector('.sk-toolbar-viewer-menu'), null);
    assert.equal(mount.children.length, 0);
    mount.remove();
  });
});
