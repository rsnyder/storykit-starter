// tests/unit/doclist.test.js  (WP-2.5)
//
// Unit tests for editor/doclist.js — the document list panel (FR-DOC.5/6/7).
// Covers the pure helpers (slug/filename/front-matter/template-fill/sync
// heuristic) and the DOM component against a fake in-memory store (list
// render + badges, two-step delete, New Post flow).
window.__SK_NO_AUTOBOOT = true;

import { describe, it, assert } from './runner.js';
import {
  slugify,
  toDateString,
  buildFilename,
  buildDefaultPath,
  extractFrontMatterTitle,
  titleFromFilename,
  fillTemplate,
  deriveSyncStatus,
  createDocList,
} from '../../editor/doclist.js';
import { fallbackTemplate } from '../../editor/viewer-catalog.js';

// ── Pure helpers ────────────────────────────────────────────────────────

describe('doclist: slugify (FR-DOC.6)', () => {
  const cases = [
    ['Hello World', 'hello-world'],
    ['  Hello, World!  ', 'hello-world'],
    ['Multiple   Spaces Here', 'multiple-spaces-here'],
    ['Café de Flore', 'cafe-de-flore'],
    ['Ångström Über Naïve', 'angstrom-uber-naive'],
    ['---Leading and Trailing---', 'leading-and-trailing'],
    ['___under_scores___', 'under-scores'],
    ['Already-Slugged-Title', 'already-slugged-title'],
    ['CAPS LOCK TITLE', 'caps-lock-title'],
    ['Numbers 123 and 456', 'numbers-123-and-456'],
    ['Punctuation: it\'s "great", right?!', 'punctuation-it-s-great-right'],
    ['', 'untitled'],
    ['   ', 'untitled'],
    ['!!!', 'untitled'],
  ];
  for (const [input, expected] of cases) {
    it(`slugify(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(slugify(input), expected);
    });
  }

  it('handles undefined/null input as empty title fallback', () => {
    assert.equal(slugify(undefined), 'untitled');
    assert.equal(slugify(null), 'untitled');
  });
});

describe('doclist: toDateString / filename assembly (FR-DOC.6)', () => {
  it('formats a Date object as yyyy-mm-dd (zero-padded)', () => {
    assert.equal(toDateString(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(toDateString(new Date(2026, 10, 25)), '2026-11-25');
  });

  it('reads a literal yyyy-mm-dd prefix from a string as-is', () => {
    assert.equal(toDateString('2026-07-06'), '2026-07-06');
    assert.equal(toDateString('2026-07-06T00:00:00.000Z'), '2026-07-06');
  });

  it('buildFilename assembles yyyy-mm-dd-slug.md', () => {
    assert.equal(buildFilename('2026-07-06', 'My Essay'), '2026-07-06-my-essay.md');
    assert.equal(buildFilename(new Date(2026, 6, 6), 'My Essay'), '2026-07-06-my-essay.md');
  });

  it('buildFilename falls back to untitled for an empty title', () => {
    assert.equal(buildFilename('2026-07-06', ''), '2026-07-06-untitled.md');
  });

  it('buildDefaultPath prefixes _posts/', () => {
    assert.equal(buildDefaultPath('2026-07-06', 'My Essay'), '_posts/2026-07-06-my-essay.md');
  });
});

describe('doclist: extractFrontMatterTitle', () => {
  it('extracts a bare title value', () => {
    const content = '---\ntitle: My Great Post\ndate: 2026-01-01\n---\n\nBody text.';
    assert.equal(extractFrontMatterTitle(content), 'My Great Post');
  });

  it('extracts and unquotes a double-quoted title', () => {
    const content = '---\ntitle: "Quoted Title: With Colon"\n---\n';
    assert.equal(extractFrontMatterTitle(content), 'Quoted Title: With Colon');
  });

  it('extracts and unquotes a single-quoted title', () => {
    const content = "---\ntitle: 'Single Quoted'\n---\n";
    assert.equal(extractFrontMatterTitle(content), 'Single Quoted');
  });

  it('falls back when there is no front matter block', () => {
    const content = '# Just a heading\n\nNo front matter here.';
    assert.equal(extractFrontMatterTitle(content, 'Fallback Title'), 'Fallback Title');
  });

  it('falls back when front matter has no title key', () => {
    const content = '---\ndate: 2026-01-01\n---\nBody.';
    assert.equal(extractFrontMatterTitle(content, 'Fallback Title'), 'Fallback Title');
  });

  it('falls back when title is present but empty', () => {
    const content = '---\ntitle: \ndate: 2026-01-01\n---\nBody.';
    assert.equal(extractFrontMatterTitle(content, 'Fallback Title'), 'Fallback Title');
  });

  it('uses the default fallback "Untitled" when none is supplied', () => {
    assert.equal(extractFrontMatterTitle('no front matter'), 'Untitled');
  });

  it('titleFromFilename strips a .md extension', () => {
    assert.equal(titleFromFilename('2026-07-06-my-essay.md'), '2026-07-06-my-essay');
    assert.equal(titleFromFilename('Notes.MD'), 'Notes');
    assert.equal(titleFromFilename(''), 'Untitled');
  });
});

describe('doclist: fillTemplate (FR-DOC.6)', () => {
  it('injects title and date into the bundled fallbackTemplate', () => {
    const filled = fillTemplate(fallbackTemplate, { title: 'My New Post', date: '2026-07-06' });
    assert.ok(/^title: My New Post$/m.test(filled), 'title line not injected correctly');
    assert.ok(/^date: 2026-07-06$/m.test(filled), 'date line not injected correctly');
    // Untouched fields still present.
    assert.ok(/^description: $/m.test(filled));
    assert.ok(/^media_subpath: \/assets\/img$/m.test(filled));
  });

  it('only replaces the first title:/date: line', () => {
    const template = 'title: \ndate: 2026-01-01\nimage:\n  path: \n  alt: \n';
    const filled = fillTemplate(template, { title: 'X', date: '2026-02-02' });
    assert.equal(filled, 'title: X\ndate: 2026-02-02\nimage:\n  path: \n  alt: \n');
  });

  it('defaults date to today when omitted', () => {
    const filled = fillTemplate('title: \ndate: 2020-01-01\n', { title: 'X' });
    assert.ok(/^date: \d{4}-\d{2}-\d{2}$/m.test(filled));
  });
});

describe('doclist: deriveSyncStatus heuristic', () => {
  it('unbound doc (github null) is local', () => {
    assert.equal(deriveSyncStatus({ github: null }), 'local');
  });

  it('bound doc with syncedAt >= updatedAt is synced', () => {
    assert.equal(
      deriveSyncStatus({
        updatedAt: '2026-06-01T00:00:00.000Z',
        github: { syncedAt: '2026-06-01T00:00:00.000Z' },
      }),
      'synced'
    );
  });

  it('bound doc with updatedAt after syncedAt is local-changes', () => {
    assert.equal(
      deriveSyncStatus({
        updatedAt: '2026-07-05T00:00:00.000Z',
        github: { syncedAt: '2026-05-01T00:00:00.000Z' },
      }),
      'local-changes'
    );
  });

  it('remoteChanged flag wins regardless of timestamps', () => {
    assert.equal(
      deriveSyncStatus({
        updatedAt: '2026-01-01T00:00:00.000Z',
        github: { syncedAt: '2026-06-01T00:00:00.000Z', remoteChanged: true },
      }),
      'remote-changed'
    );
  });
});

// ── DOM component ───────────────────────────────────────────────────────

function makeFakeStore(seedDocs) {
  let docs = seedDocs.map((d) => ({ ...d }));
  let n = 1000;
  const calls = { remove: [], create: [], update: [], duplicate: [] };
  return {
    calls,
    docs: {
      async list() {
        return docs.map((d) => ({ ...d }));
      },
      async get(id) {
        const rec = docs.find((d) => d.id === id);
        return rec ? { ...rec } : null;
      },
      async create({ title, path, content }) {
        calls.create.push({ title, path, content });
        const rec = {
          id: `new-${n++}`,
          title,
          path: path ?? null,
          content: content ?? '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          github: null,
          revisions: [],
        };
        docs.push(rec);
        return { ...rec };
      },
      async update(id, patch) {
        calls.update.push({ id, patch });
        const rec = docs.find((d) => d.id === id);
        if (!rec) throw new Error('not found');
        Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
        return { ...rec };
      },
      async remove(id) {
        calls.remove.push(id);
        docs = docs.filter((d) => d.id !== id);
      },
      async duplicate(id) {
        calls.duplicate.push(id);
        const rec = docs.find((d) => d.id === id);
        if (!rec) throw new Error('not found');
        const copy = {
          ...rec,
          id: `dup-${n++}`,
          title: `${rec.title} copy`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        docs.push(copy);
        return { ...copy };
      },
    },
  };
}

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
  el.className = 'doclist';
  document.body.appendChild(el);
  return el;
}

describe('doclist: DOM render (FR-DOC.5)', () => {
  it('renders 3 docs sorted by updatedAt desc with correct badges', async () => {
    const store = makeFakeStore([
      {
        id: 'a',
        title: 'Draft A',
        path: null,
        content: 'a',
        updatedAt: '2026-07-01T00:00:00.000Z',
        github: null,
      },
      {
        id: 'b',
        title: 'Essay B',
        path: '_posts/2026-06-01-essay-b.md',
        content: 'b',
        updatedAt: '2026-06-01T00:00:00.000Z',
        github: { owner: 'x', repo: 'y', branch: 'main', sha: 's1', syncedAt: '2026-06-01T00:00:00.000Z' },
      },
      {
        id: 'c',
        title: 'Post C',
        path: '_posts/2026-05-01-post-c.md',
        content: 'c',
        updatedAt: '2026-07-05T00:00:00.000Z',
        github: { owner: 'x', repo: 'y', branch: 'main', sha: 's2', syncedAt: '2026-05-01T00:00:00.000Z' },
      },
    ]);
    const mount = makeMount();
    const api = createDocList({ mount, store, bus: new EventTarget() });
    try {
      await api.refresh();
      const items = mount.querySelectorAll('.dl-item');
      assert.equal(items.length, 3, 'expected 3 rendered items');

      // Sorted by updatedAt desc: C (07-05), A (07-01), B (06-01).
      assert.equal(items[0].dataset.docId, 'c');
      assert.equal(items[1].dataset.docId, 'a');
      assert.equal(items[2].dataset.docId, 'b');

      const badgeFor = (id) => mount.querySelector(`.dl-item[data-doc-id="${id}"] .dl-badge`);
      assert.equal(badgeFor('a').dataset.status, 'local');
      assert.equal(badgeFor('a').textContent, 'Local only');
      assert.equal(badgeFor('b').dataset.status, 'synced');
      assert.equal(badgeFor('b').textContent, 'Synced');
      assert.equal(badgeFor('c').dataset.status, 'local-changes');
      assert.equal(badgeFor('c').textContent, 'Local changes');

      const titleFor = (id) => mount.querySelector(`.dl-item[data-doc-id="${id}"] .dl-title`);
      assert.equal(titleFor('a').textContent, 'Draft A');
      const pathFor = (id) => mount.querySelector(`.dl-item[data-doc-id="${id}"] .dl-path`);
      assert.equal(pathFor('a').textContent, 'unsaved');
      assert.equal(pathFor('b').textContent, '_posts/2026-06-01-essay-b.md');
    } finally {
      api.destroy();
      mount.remove();
    }
  });

  it('shows an empty state with zero documents', async () => {
    const store = makeFakeStore([]);
    const mount = makeMount();
    const api = createDocList({ mount, store });
    try {
      await api.refresh();
      assert.equal(mount.querySelectorAll('.dl-item').length, 0);
      assert.ok(mount.querySelector('.dl-empty'));
    } finally {
      api.destroy();
      mount.remove();
    }
  });

  it('calling onOpen fires when a list item is clicked', async () => {
    const store = makeFakeStore([
      { id: 'a', title: 'Draft A', path: null, content: 'a', updatedAt: '2026-07-01T00:00:00.000Z', github: null },
    ]);
    const mount = makeMount();
    let openedId = null;
    const api = createDocList({ mount, store, onOpen: (id) => { openedId = id; } });
    try {
      await api.refresh();
      mount.querySelector('.dl-open').click();
      assert.equal(openedId, 'a');
    } finally {
      api.destroy();
      mount.remove();
    }
  });
});

describe('doclist: two-step delete (FR-DOC.5)', () => {
  it('does not call store.remove until the confirm step is clicked', async () => {
    const store = makeFakeStore([
      { id: 'a', title: 'Draft A', path: null, content: 'a', updatedAt: '2026-07-01T00:00:00.000Z', github: null },
    ]);
    const mount = makeMount();
    const api = createDocList({ mount, store });
    try {
      await api.refresh();

      const item = mount.querySelector('.dl-item[data-doc-id="a"]');
      const findByText = (text) =>
        [...item.querySelectorAll('button')].find((b) => b.textContent === text);

      findByText('Delete').click();
      assert.equal(store.calls.remove.length, 0, 'remove must not be called on the first click');

      const item2 = mount.querySelector('.dl-item[data-doc-id="a"]');
      const confirmBtn = [...item2.querySelectorAll('button')].find((b) => b.textContent === 'Confirm delete');
      assert.ok(confirmBtn, 'expected a "Confirm delete" button after the first click');

      confirmBtn.click();
      await waitFor(() => store.calls.remove.length === 1);
      assert.deepEqual(store.calls.remove, ['a']);

      await waitFor(() => mount.querySelectorAll('.dl-item').length === 0);
    } finally {
      api.destroy();
      mount.remove();
    }
  });

  it('cancel returns to the plain Delete button without removing', async () => {
    const store = makeFakeStore([
      { id: 'a', title: 'Draft A', path: null, content: 'a', updatedAt: '2026-07-01T00:00:00.000Z', github: null },
    ]);
    const mount = makeMount();
    const api = createDocList({ mount, store });
    try {
      await api.refresh();
      const item = mount.querySelector('.dl-item[data-doc-id="a"]');
      [...item.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();

      const item2 = mount.querySelector('.dl-item[data-doc-id="a"]');
      [...item2.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();

      const item3 = mount.querySelector('.dl-item[data-doc-id="a"]');
      assert.ok([...item3.querySelectorAll('button')].some((b) => b.textContent === 'Delete'));
      assert.equal(store.calls.remove.length, 0);
    } finally {
      api.destroy();
      mount.remove();
    }
  });
});

describe('doclist: New Post flow (FR-DOC.6)', () => {
  it('creates a document via the fake store with template-filled content', async () => {
    const store = makeFakeStore([]);
    const mount = makeMount();
    let openedId = null;
    const api = createDocList({ mount, store, onOpen: (id) => { openedId = id; } });
    try {
      await api.refresh();
      api.openNewPostForm();

      const input = mount.querySelector('.dl-new-input');
      assert.ok(input, 'expected the inline title input to be present');
      input.value = 'My New Post';

      const form = mount.querySelector('.dl-new-form');
      const createBtn = [...form.querySelectorAll('button')].find((b) => b.textContent === 'Create');
      createBtn.click();

      await waitFor(() => store.calls.create.length === 1);
      const created = store.calls.create[0];
      assert.equal(created.title, 'My New Post');
      assert.ok(/^_posts\/\d{4}-\d{2}-\d{2}-my-new-post\.md$/.test(created.path), `unexpected path: ${created.path}`);
      assert.ok(/^title: My New Post$/m.test(created.content));
      assert.ok(/^date: \d{4}-\d{2}-\d{2}$/m.test(created.content));

      await waitFor(() => openedId !== null);
      assert.ok(typeof openedId === 'string' && openedId.length > 0);

      await waitFor(() => mount.querySelectorAll('.dl-item').length === 1);
    } finally {
      api.destroy();
      mount.remove();
    }
  });

  it('falls back to "Untitled draft" when the title is left blank', async () => {
    const store = makeFakeStore([]);
    const mount = makeMount();
    const api = createDocList({ mount, store });
    try {
      await api.refresh();
      api.openNewPostForm();
      const form = mount.querySelector('.dl-new-form');
      const createBtn = [...form.querySelectorAll('button')].find((b) => b.textContent === 'Create');
      createBtn.click();

      await waitFor(() => store.calls.create.length === 1);
      assert.equal(store.calls.create[0].title, 'Untitled draft');
      assert.ok(/^title: Untitled draft$/m.test(store.calls.create[0].content));
    } finally {
      api.destroy();
      mount.remove();
    }
  });

  it('Cancel closes the form without creating a document', async () => {
    const store = makeFakeStore([]);
    const mount = makeMount();
    const api = createDocList({ mount, store });
    try {
      await api.refresh();
      api.openNewPostForm();
      const form = mount.querySelector('.dl-new-form');
      const cancelBtn = [...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
      cancelBtn.click();
      assert.equal(mount.querySelector('.dl-new-form'), null);
      assert.equal(store.calls.create.length, 0);
    } finally {
      api.destroy();
      mount.remove();
    }
  });
});

describe('doclist: bus-driven re-render', () => {
  it('refreshes when doc:saved fires on the bus', async () => {
    const store = makeFakeStore([
      { id: 'a', title: 'Draft A', path: null, content: 'a', updatedAt: '2026-07-01T00:00:00.000Z', github: null },
    ]);
    const bus = new EventTarget();
    const mount = makeMount();
    const api = createDocList({ mount, store, bus });
    try {
      await api.refresh();
      assert.equal(mount.querySelectorAll('.dl-item').length, 1);

      // A second doc appears "server-side" (e.g. via autosave elsewhere);
      // the panel should pick it up once notified, without an explicit
      // refresh() call from the test.
      await store.docs.create({ title: 'Draft B', path: null, content: 'b' });
      bus.dispatchEvent(new CustomEvent('doc:saved', { detail: {} }));

      await waitFor(() => mount.querySelectorAll('.dl-item').length === 2);
    } finally {
      api.destroy();
      mount.remove();
    }
  });
});

describe('doclist: createDocList argument validation', () => {
  it('throws without a mount', () => {
    assert.throws(() => createDocList({ store: makeFakeStore([]) }), /mount is required/);
  });

  it('throws without a store', () => {
    const mount = makeMount();
    try {
      assert.throws(() => createDocList({ mount }), /store/);
    } finally {
      mount.remove();
    }
  });
});
