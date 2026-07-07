// tests/unit/dnd.test.js  (WP-4.1)
//
// Covers editor/dnd.js: FR-DND.1 block/inline placement + blank-line
// management, FR-DND.5 post-insert hint affordance, FR-DND.6 unrecognized/
// local-file fallbacks (never silently discarded), FR-DND.7 paste
// affordance + expiry. Real cross-origin OS drags can't be automated
// (risk R-7) — every test builds a synthetic `DataTransfer` (or plain
// getData/types stub) and dispatches a real DOM `drop`/`paste` event at a
// coordinate/position resolved via the mounted view itself
// (`view.coordsAtPos`), so placement math is exercised exactly as it runs
// in the browser.

import { describe, it, assert } from './runner.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { dndExtension } from '../../editor/dnd.js';

/* ---------------------------------------------------------------- helpers */

function mountView(doc, extensions = []) {
  const parent = document.createElement('div');
  parent.style.width = '600px';
  parent.style.height = '300px';
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
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

function mkDndView(doc, onNotice) {
  const notices = [];
  const notify = (n) => notices.push(n);
  const { view, destroy } = mountView(doc, dndExtension({ onNotice: onNotice || notify }));
  return { view, destroy, notices };
}

/** A minimal DataTransfer-shaped stub: getData/types, optionally files. */
function stubTransfer({ uriList, text, html, files } = {}) {
  const data = {};
  if (uriList != null) data['text/uri-list'] = uriList;
  if (text != null) data['text/plain'] = text;
  if (html != null) data['text/html'] = html;
  return {
    types: Object.keys(data).concat(files && files.length ? ['Files'] : []),
    files: files || [],
    getData: (type) => data[type] || '',
  };
}

/** Real DataTransfer when available (Chromium supports construction). */
function realTransfer(payload) {
  try {
    const dt = new DataTransfer();
    if (payload.uriList != null) dt.setData('text/uri-list', payload.uriList);
    if (payload.text != null) dt.setData('text/plain', payload.text);
    if (payload.html != null) dt.setData('text/html', payload.html);
    if (payload.files && payload.files.length) {
      for (const file of payload.files) dt.items.add(file);
    }
    return dt;
  } catch {
    return stubTransfer(payload);
  }
}

function dispatchDrop(view, pos, payload) {
  const coords = view.coordsAtPos(pos) || { left: 0, top: 0 };
  const dataTransfer = realTransfer(payload);
  const event = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    clientX: coords.left + 1,
    clientY: coords.top + 1,
  });
  // DragEvent's `dataTransfer` is a read-only accessor in most engines and
  // isn't reliably settable via the constructor init dict — override it
  // directly, matching the pattern this repo's other synthetic-event tests
  // would need for any browser-native event carrying non-constructor state.
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function dispatchPaste(view, payload) {
  const dataTransfer = realTransfer(payload);
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: dataTransfer, configurable: true });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function dispatchDragover(view, pos, types) {
  const coords = view.coordsAtPos(pos) || { left: 0, top: 0 };
  const event = new DragEvent('dragover', {
    bubbles: true,
    cancelable: true,
    clientX: coords.left + 1,
    clientY: coords.top + 1,
  });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, getData: () => '' },
    configurable: true,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function chipEl() {
  return document.querySelector('.sk-dnd-chip');
}

/* ============================================================ FR-DND.1 */

describe('dnd: Commons drop — own-line placement + blank-line management', () => {
  it('mid-paragraph drop inserts the tag as a new block after the whole line', () => {
    const { view, destroy } = mkDndView('Some prose text here.\nSecond paragraph.');
    const pos = 5; // inside the first line
    dispatchDrop(view, pos, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.equal(
      view.state.doc.toString(),
      'Some prose text here.\n\n{% include embed/image.html src="wc:Foo.jpg" %}\n\nSecond paragraph.'
    );
    destroy();
  });

  it('drop at the very start of the document omits the leading blank line', () => {
    const { view, destroy } = mkDndView('\nParagraph A');
    dispatchDrop(view, 0, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.equal(
      view.state.doc.toString(),
      '{% include embed/image.html src="wc:Foo.jpg" %}\n\nParagraph A'
    );
    destroy();
  });

  it('drop at the very end of the document omits the trailing blank line', () => {
    const { view, destroy } = mkDndView('Paragraph A');
    dispatchDrop(view, view.state.doc.length, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.equal(
      view.state.doc.toString(),
      'Paragraph A\n\n{% include embed/image.html src="wc:Foo.jpg" %}'
    );
    destroy();
  });

  it('collapses an already-blank multi-line gap to exactly one blank line on each side', () => {
    const { view, destroy } = mkDndView('Paragraph A\n\n\n\nParagraph B');
    // Land on one of the interior blank lines.
    const blankLinePos = view.state.doc.line(3).from;
    dispatchDrop(view, blankLinePos, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.equal(
      view.state.doc.toString(),
      'Paragraph A\n\n{% include embed/image.html src="wc:Foo.jpg" %}\n\nParagraph B'
    );
    destroy();
  });

  it('dropping into a single-blank-line paragraph gap does not double the blank lines', () => {
    const { view, destroy } = mkDndView('Paragraph A\n\nParagraph B');
    const blankLinePos = view.state.doc.line(2).from;
    dispatchDrop(view, blankLinePos, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.equal(
      view.state.doc.toString(),
      'Paragraph A\n\n{% include embed/image.html src="wc:Foo.jpg" %}\n\nParagraph B'
    );
    destroy();
  });
});

describe('dnd: YouTube / Maps drops', () => {
  it('YouTube URL with a start param produces a own-line tag with start=', () => {
    const { view, destroy } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s' });
    assert.equal(
      view.state.doc.toString(),
      '{% include embed/youtube.html vid="dQw4w9WgXcQ" start="90" %}'
    );
    destroy();
  });

  it('Google Maps @lat,lng,zoom URL produces a center/zoom tag', () => {
    const { view, destroy } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://www.google.com/maps/@51.5,-0.12,15z' });
    assert.equal(
      view.state.doc.toString(),
      '{% include embed/map.html center="51.5, -0.12" zoom="15" %}'
    );
    destroy();
  });

  it('maps.app.goo.gl short link fires onNotice and inserts nothing', () => {
    const { view, destroy, notices } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://maps.app.goo.gl/abc123' });
    assert.equal(view.state.doc.toString(), '');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, 'warning');
    assert.ok(/maps\.app\.goo\.gl/i.test(notices[0].message) || /shortened/i.test(notices[0].message));
    destroy();
  });
});

describe('dnd: link fallback (FR-DND.6) — inline, not a block', () => {
  it('an unrecognized http(s) URL inserts a markdown link inline at the drop position', () => {
    const { view, destroy } = mkDndView('Check this out: HERE please');
    const pos = 'Check this out: '.length; // right before "HERE"
    dispatchDrop(view, pos, { uriList: 'https://example.com/some/page' });
    assert.equal(
      view.state.doc.toString(),
      'Check this out: [example.com](https://example.com/some/page)HERE please'
    );
    destroy();
  });
});

describe('dnd: unknown / plain-text drops (FR-DND.6)', () => {
  it('an unrecognized non-http(s) URL-shaped drop fires onNotice and inserts nothing', () => {
    const { view, destroy, notices } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'ftp://files.example.com/archive.zip' });
    assert.equal(view.state.doc.toString(), '');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, 'warning');
    destroy();
  });

  it('a plain-text (non-URL) drag falls through to normal text insertion, no notice', () => {
    const { view, destroy, notices } = mkDndView('');
    dispatchDrop(view, 0, { text: 'just some dragged prose' });
    // Not handled by us: preventDefault() was never called, so CM6's own
    // default drop-to-insert-text behaviour applies.
    assert.equal(view.state.doc.toString(), 'just some dragged prose');
    assert.equal(notices.length, 0);
    destroy();
  });

  it('a local image file drop fires onNotice and inserts nothing', () => {
    const { view, destroy, notices } = mkDndView('');
    const file = new File(['data'], 'photo.jpg', { type: 'image/jpeg' });
    dispatchDrop(view, 0, { files: [file] });
    assert.equal(view.state.doc.toString(), '');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, 'warning');
    assert.ok(/local image/i.test(notices[0].message));
    destroy();
  });
});

/* ============================================================ §7 chip */

describe('dnd: drag-over chip', () => {
  it('shows a generic "Drop to insert" chip on dragover when a URL-ish flavor is present', () => {
    const { view, destroy } = mkDndView('hello world');
    dispatchDragover(view, 3, ['text/uri-list', 'text/plain']);
    const el = chipEl();
    assert.ok(el, 'chip element should exist');
    assert.equal(el.style.display, 'block');
    assert.equal(el.textContent, 'Drop to insert');
    destroy();
  });
});

/* ============================================================ FR-DND.5 */

describe('dnd: post-insert hint affordance', () => {
  it('selects the inserted tag and shows Add caption / Add id actions', () => {
    const { view, destroy } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    const tag = '{% include embed/image.html src="wc:Foo.jpg" %}';
    assert.equal(view.state.selection.main.from, 0);
    assert.equal(view.state.selection.main.to, tag.length);

    const hint = view.dom.querySelector('.sk-dnd-hint');
    assert.ok(hint, 'hint widget should be rendered');
    const buttons = Array.from(hint.querySelectorAll('.sk-dnd-hint-btn')).map((b) => b.textContent);
    assert.deepEqual(buttons, ['Add caption', 'Add id']);
    destroy();
  });

  it('clicking "Add caption" inserts caption="" with the cursor between the quotes', () => {
    const { view, destroy } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    const btn = view.dom.querySelector('.sk-dnd-hint-btn');
    btn.click();
    assert.equal(
      view.state.doc.toString(),
      '{% include embed/image.html src="wc:Foo.jpg" caption="" %}'
    );
    const head = view.state.selection.main.head;
    assert.equal(view.state.sliceDoc(head - 1, head + 1), '""');
    // Hint dismisses itself after acting.
    assert.equal(view.dom.querySelector('.sk-dnd-hint'), null);
    destroy();
  });

  it('clicking "Add id" inserts id="" with the cursor between the quotes', () => {
    const { view, destroy } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    const buttons = view.dom.querySelectorAll('.sk-dnd-hint-btn');
    buttons[1].click(); // "Add id"
    assert.equal(
      view.state.doc.toString(),
      '{% include embed/youtube.html vid="dQw4w9WgXcQ" id="" %}'
    );
    destroy();
  });

  it('dismisses on Escape', () => {
    const { view, destroy } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.ok(view.dom.querySelector('.sk-dnd-hint'));
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(view.dom.querySelector('.sk-dnd-hint'), null);
    destroy();
  });

  it('dismisses on any other edit', () => {
    const { view, destroy } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.ok(view.dom.querySelector('.sk-dnd-hint'));
    view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: 'x' } });
    assert.equal(view.dom.querySelector('.sk-dnd-hint'), null);
    destroy();
  });

  it('dismisses when the selection moves elsewhere without an edit', () => {
    const { view, destroy } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.ok(view.dom.querySelector('.sk-dnd-hint'));
    view.dispatch({ selection: { anchor: 0 } });
    assert.equal(view.dom.querySelector('.sk-dnd-hint'), null);
    destroy();
  });

  it('the link fallback kind does not show a hint', () => {
    const { view, destroy } = mkDndView('');
    dispatchDrop(view, 0, { uriList: 'https://example.com/some/page' });
    assert.equal(view.dom.querySelector('.sk-dnd-hint'), null);
    destroy();
  });
});

/* ============================================================ FR-DND.7 */

describe('dnd: paste affordance', () => {
  it('inserts the raw pasted text unchanged and shows "Paste as StoryKit tag?"', () => {
    const { view, destroy } = mkDndView('');
    dispatchPaste(view, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg', text: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.equal(view.state.doc.toString(), 'https://commons.wikimedia.org/wiki/File:Foo.jpg');
    const affordance = view.dom.querySelector('.sk-dnd-paste-btn');
    assert.ok(affordance, 'paste affordance button should be rendered');
    assert.equal(affordance.textContent, 'Paste as StoryKit tag?');
    destroy();
  });

  it('clicking the affordance replaces the pasted range with the tag and shows the post-insert hint', () => {
    const { view, destroy } = mkDndView('prefix ');
    view.dispatch({ selection: { anchor: 'prefix '.length } });
    dispatchPaste(view, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg', text: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    view.dom.querySelector('.sk-dnd-paste-btn').click();
    assert.equal(
      view.state.doc.toString(),
      'prefix {% include embed/image.html src="wc:Foo.jpg" %}'
    );
    assert.equal(view.dom.querySelector('.sk-dnd-paste-btn'), null);
    assert.ok(view.dom.querySelector('.sk-dnd-hint'), 'transforming should chain into the post-insert hint');
    destroy();
  });

  it('expires after the timeout and clears the affordance', async () => {
    const { view, destroy } = mkDndView('');
    dispatchPaste(view, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg', text: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.ok(view.dom.querySelector('.sk-dnd-paste-btn'));
    await new Promise((resolve) => setTimeout(resolve, 8300));
    assert.equal(view.dom.querySelector('.sk-dnd-paste-btn'), null);
    destroy();
  }, { timeout: 9000 });

  it('an edit elsewhere in the document dismisses the affordance immediately', () => {
    const { view, destroy } = mkDndView('AAAA\n\nBBBB');
    view.dispatch({ selection: { anchor: 0 } });
    dispatchPaste(view, { uriList: 'https://commons.wikimedia.org/wiki/File:Foo.jpg', text: 'https://commons.wikimedia.org/wiki/File:Foo.jpg' });
    assert.ok(view.dom.querySelector('.sk-dnd-paste-btn'));
    // Edit far away from the pasted range.
    view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: '!' } });
    assert.equal(view.dom.querySelector('.sk-dnd-paste-btn'), null);
    destroy();
  });

  it('an edit inside the pasted range keeps the affordance alive at its remapped position', () => {
    const pastedUrl = 'https://commons.wikimedia.org/wiki/File:Foo.jpg';
    const { view, destroy } = mkDndView('');
    dispatchPaste(view, { uriList: pastedUrl, text: pastedUrl });
    assert.ok(view.dom.querySelector('.sk-dnd-paste-btn'));
    // Type one extra character in the middle of the pasted range.
    view.dispatch({ changes: { from: 5, to: 5, insert: 'X' } });
    assert.ok(
      view.dom.querySelector('.sk-dnd-paste-btn'),
      'in-range edit should not dismiss the affordance'
    );
    destroy();
  });

  it('maps-short paste fires onNotice but still inserts the raw text (no affordance)', () => {
    const { view, destroy, notices } = mkDndView('');
    dispatchPaste(view, { uriList: 'https://maps.app.goo.gl/abc123', text: 'https://maps.app.goo.gl/abc123' });
    assert.equal(view.state.doc.toString(), 'https://maps.app.goo.gl/abc123');
    assert.equal(notices.length, 1);
    assert.equal(view.dom.querySelector('.sk-dnd-paste-btn'), null);
    destroy();
  });

  it('a local image file paste fires onNotice and inserts nothing', () => {
    const { view, destroy, notices } = mkDndView('');
    const file = new File(['data'], 'shot.png', { type: 'image/png' });
    dispatchPaste(view, { files: [file] });
    assert.equal(view.state.doc.toString(), '');
    assert.equal(notices.length, 1);
    assert.ok(/local image/i.test(notices[0].message));
    destroy();
  });

  it('plain-text paste (no URL) does not trigger the affordance and lets default paste proceed', () => {
    const { view, destroy, notices } = mkDndView('');
    dispatchPaste(view, { text: 'just some ordinary pasted prose' });
    assert.equal(view.dom.querySelector('.sk-dnd-paste-btn'), null);
    assert.equal(notices.length, 0);
    destroy();
  });
});
