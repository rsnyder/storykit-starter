// tests/unit/wikidata.test.js  (WP-4.2)
//
// Unit tests for editor/wikidata.js — search/lookup against the Wikidata
// action API (hermetic: `globalThis.fetch` is stubbed per test, saved/
// restored, never touches the live network — per docs/editor-plan.md §0.5),
// the ⌘⇧K search popup, the [text](Qnnnn) hover card, and the
// createEntityResolver() glue for the WP-2.4 entity-label resolver hook.
//
// QID hygiene: store.test.js already exercises the shared entityCache
// (a real IndexedDB store, module-singleton across every test file loaded
// on this page) with Q42/Q7/Q8/Q999999999; lang-storykit.test.js uses
// Q1035/Q1783171/Q192017/Q1/Q2/Q9 in local (non-persisted) resolver mocks.
// This file sticks to a private Q5010xx/Q5011xx range for anything that
// touches entityCache, to avoid cross-file collisions — except the popup
// insertion test, which intentionally reuses Q1035 (Charles Darwin) because
// that's the example value named in this WP's brief; it never touches
// entityCache (search results aren't cached), so there's no collision risk.

import { describe, it, assert } from './runner.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import * as wikidata from '../../editor/wikidata.js';
import { entityCache } from '../../editor/store.js';
import { storykit } from '../../editor/lang-storykit.js';

// ── test helpers ────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal Response-alike — wikidata.js only reads .ok/.status/.json(). */
function fakeResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

/** Runs `fn` with globalThis.fetch replaced by `stub`, always restoring the
 * original afterward (even on throw). `stub` receives (url, opts, calls).
 * Mirrors tests/unit/github.test.js's helper of the same name/shape. */
async function withStubFetch(stub, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return stub(url, opts, calls);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Mounts a real, attached EditorView (needed for coordsAtPos / focus /
 * dispatch to behave like the real editor) and optionally records every
 * transaction dispatched to it, so tests can inspect StateEffects without
 * monkey-patching `view.dispatch`. */
function mountView(doc, pos = 0, extraExtensions = []) {
  const seenTransactions = [];
  const parent = document.createElement('div');
  parent.style.height = '300px';
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: [
        EditorView.updateListener.of((u) => { seenTransactions.push(...u.transactions); }),
        ...extraExtensions,
      ],
    }),
    parent,
  });
  return {
    view,
    seenTransactions,
    destroy() {
      view.destroy();
      parent.remove();
    },
  };
}

/** Closes any popup left open by a test (defensive; most tests already do
 * this in a `finally`, but a failed assertion could skip it). */
function closeAnyPopup() {
  document.querySelector('.sk-wd-close')?.click();
}

// ── searchEntities ───────────────────────────────────────────────────────

describe('wikidata: searchEntities', () => {
  it('GETs wbsearchentities with the frozen query params and maps results to {qid,label,description}', async () => {
    await withStubFetch(
      (url) => {
        assert.ok(url.startsWith('https://www.wikidata.org/w/api.php?action=wbsearchentities'), url);
        assert.ok(url.includes('search=darwin'), url);
        assert.ok(url.includes('language=en'), url);
        assert.ok(url.includes('format=json'), url);
        assert.ok(url.includes('origin=*'), url);
        assert.ok(url.includes('limit=8'), url);
        return fakeResponse({
          status: 200,
          body: {
            search: [
              { id: 'Q1035', label: 'Charles Darwin', description: 'English naturalist' },
              { id: 'Q123', label: 'no description here' },
            ],
          },
        });
      },
      async () => {
        const results = await wikidata.searchEntities('darwin');
        assert.deepEqual(results, [
          { qid: 'Q1035', label: 'Charles Darwin', description: 'English naturalist' },
          { qid: 'Q123', label: 'no description here', description: '' },
        ]);
      }
    );
  });

  it('returns [] for a blank query without touching the network', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 200, body: { search: [] } }),
      async (calls) => {
        assert.deepEqual(await wikidata.searchEntities('   '), []);
        assert.equal(calls.length, 0, 'a blank query must not fetch');
      }
    );
  });

  it('a non-OK HTTP response rejects', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 503 }),
      async () => {
        await assert.rejects(wikidata.searchEntities('x'));
      }
    );
  });

  it('rejects (AbortError) when the caller\'s AbortController fires mid-flight — the earlier controller\'s signal is left aborted for the caller to check', async () => {
    let capturedSignal = null;
    globalThis._wd_original_fetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      capturedSignal = opts.signal;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    try {
      const controller = new AbortController();
      const promise = wikidata.searchEntities('darwin', { signal: controller.signal });
      controller.abort();
      let caught;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'expected the search promise to reject');
      assert.equal(caught.name, 'AbortError');
      assert.ok(controller.signal.aborted, 'the earlier AbortController fired');
      assert.equal(capturedSignal, controller.signal, 'the signal was actually forwarded to fetch');
    } finally {
      globalThis.fetch = globalThis._wd_original_fetch;
      delete globalThis._wd_original_fetch;
    }
  });
});

// ── getEntities ──────────────────────────────────────────────────────────

describe('wikidata: getEntities (cache-first, batched)', () => {
  it('serves cached qids without refetching and batches only the misses into a single request', async () => {
    await entityCache.put('Q501001', {
      label: 'Cached One', description: 'd1', wikidataUrl: 'https://www.wikidata.org/wiki/Q501001',
    });
    await entityCache.put('Q501002', {
      label: 'Cached Two', description: 'd2', wikidataUrl: 'https://www.wikidata.org/wiki/Q501002',
    });

    await withStubFetch(
      (url) => {
        assert.ok(url.includes('ids=Q501003|Q501004'), url);
        assert.ok(!url.includes('Q501001') && !url.includes('Q501002'), 'cached qids must not be refetched');
        return fakeResponse({
          status: 200,
          body: {
            entities: {
              Q501003: { labels: { en: { value: 'Three' } }, descriptions: { en: { value: 'd3' } }, claims: {} },
              Q501004: { labels: { en: { value: 'Four' } }, descriptions: { en: { value: 'd4' } }, claims: {} },
            },
          },
        });
      },
      async (calls) => {
        const result = await wikidata.getEntities(['Q501001', 'Q501002', 'Q501003', 'Q501004']);
        assert.equal(calls.length, 1, 'exactly one fetch for the two missing qids');
        assert.equal(result.Q501001.label, 'Cached One');
        assert.equal(result.Q501002.label, 'Cached Two');
        assert.equal(result.Q501003.label, 'Three');
        assert.equal(result.Q501004.label, 'Four');
      }
    );

    // put() was called for the newly-fetched entities (now readable from the cache):
    assert.deepEqual(await entityCache.get('Q501003'), {
      label: 'Three', description: 'd3', wikidataUrl: 'https://www.wikidata.org/wiki/Q501003',
    });
  });

  it('builds the P18 Commons thumbnail URL with the storykit.js mwImage / skrender.js md5 scheme', async () => {
    // Ground truth computed independently via the system `md5` tool (NOT
    // re-derived from this repo's own md5() — see the header note in
    // editor/wikidata.js): `printf '%s' "Example.jpg" | md5`
    //   → a91fe217e45a700fc2dab0cc476f01c7
    // so the thumb path is .../thumb/a/a9/Example.jpg/120px-Example.jpg
    // ("Example.jpg" is also a real Commons file; this is its genuine
    // thumbnail path).
    const expectedThumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/120px-Example.jpg';
    await withStubFetch(
      (url) => {
        assert.ok(url.includes('ids=Q501010'), url);
        assert.ok(url.includes('props=labels|descriptions|claims'), url);
        return fakeResponse({
          status: 200,
          body: {
            entities: {
              Q501010: {
                labels: { en: { value: 'Example entity' } },
                descriptions: { en: { value: 'a test entity' } },
                claims: { P18: [{ mainsnak: { datavalue: { value: 'Example.jpg' } } }] },
              },
            },
          },
        });
      },
      async () => {
        const result = await wikidata.getEntities(['Q501010']);
        assert.equal(result.Q501010.thumbnail, expectedThumb);
        assert.equal(result.Q501010.wikidataUrl, 'https://www.wikidata.org/wiki/Q501010');
      }
    );
  });

  it('a missing/unresolvable qid is simply absent from the result (never throws)', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 200, body: { entities: { Q501099: { missing: '' } } } }),
      async () => {
        const result = await wikidata.getEntities(['Q501099']);
        assert.ok(!('Q501099' in result));
      }
    );
  });

  it('a network failure leaves the affected qids absent rather than throwing (offline degradation)', async () => {
    await withStubFetch(
      () => { throw new TypeError('Failed to fetch'); },
      async () => {
        const result = await wikidata.getEntities(['Q501098']);
        assert.deepEqual(result, {});
      }
    );
  });

  it('ignores malformed qids (non-Qnnn shapes) rather than sending them to the API', async () => {
    await withStubFetch(
      (url) => {
        assert.ok(!url.includes('not-a-qid'));
        return fakeResponse({ status: 200, body: { entities: {} } });
      },
      async () => {
        const result = await wikidata.getEntities(['not-a-qid', 'Q501097']);
        assert.deepEqual(Object.keys(result), []);
      }
    );
  });
});

// ── linkEntityCommand: ⌘⇧K search popup ─────────────────────────────────

describe('wikidata: linkEntityCommand popup', () => {
  it('opens prefilled with the selection, live-searches (debounced), and Enter on the active result inserts [selectedText](Qid) (FR-WD.1)', async () => {
    await withStubFetch(
      () => fakeResponse({
        status: 200,
        body: {
          search: [
            { id: 'Q1035', label: 'Charles Darwin', description: 'English naturalist' },
            { id: 'Q999999', label: 'decoy', description: 'x' },
          ],
        },
      }),
      async () => {
        const { view, destroy } = mountView('the Darwin theory', 0);
        try {
          const handled = wikidata.linkEntityCommand(view);
          assert.equal(handled, true, 'command reports itself handled');

          const popup = document.querySelector('.sk-wd-popup');
          assert.ok(popup, 'popup opened');
          assert.equal(popup.getAttribute('role'), 'dialog');

          // Selection is set AFTER opening (coordsAtPos needs a mounted
          // view either way); linkEntityCommand reads whatever selection
          // is current at call time, so re-invoke with "Darwin" selected.
          view.dispatch({ selection: { anchor: 4, head: 10 } }); // "Darwin"
          wikidata.linkEntityCommand(view);

          const input = document.querySelector('.sk-wd-input');
          assert.equal(input.value, 'Darwin', 'prefilled with the selection');

          await sleep(wikidata._internal.debounceMs + 150);
          const options = document.querySelectorAll('.sk-wd-result');
          assert.ok(options.length >= 2, `expected ≥2 results, got ${options.length}`);

          // Exercise ArrowDown/ArrowUp navigation, landing back on the
          // first (Darwin) result, then Enter to select it.
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

          assert.equal(view.state.doc.toString(), 'the [Darwin](Q1035) theory');
          assert.ok(!document.querySelector('.sk-wd-popup'), 'popup closes after selection');
          assert.equal(document.activeElement, view.contentDOM, 'focus returns to the editor');
        } finally {
          closeAnyPopup();
          destroy();
        }
      }
    );
  });

  it('with no selection, inserts [label](Qid) using the chosen entity\'s label (FR-WD.2)', async () => {
    await withStubFetch(
      () => fakeResponse({
        status: 200,
        body: { search: [{ id: 'Q501050', label: 'Some Entity', description: 'x' }] },
      }),
      async () => {
        const { view, destroy } = mountView('prefix ', 7);
        try {
          wikidata.linkEntityCommand(view);
          const input = document.querySelector('.sk-wd-input');
          assert.equal(input.value, '', 'no prefill without a selection');

          input.value = 'some';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(wikidata._internal.debounceMs + 150);
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

          assert.equal(view.state.doc.toString(), 'prefix [Some Entity](Q501050)');
        } finally {
          closeAnyPopup();
          destroy();
        }
      }
    );
  });

  it('accepts a manually-typed Qnnnn entry, validated by shape, even with no matching search result (FR-WD.4)', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 200, body: { search: [] } }),
      async () => {
        const { view, destroy } = mountView('', 0);
        try {
          wikidata.linkEntityCommand(view);
          const input = document.querySelector('.sk-wd-input');
          input.value = 'q778899'; // lower-case — shape validation is case-insensitive
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(wikidata._internal.debounceMs + 150);

          const manual = document.querySelector('.sk-wd-result.is-manual');
          assert.ok(manual, 'manual-entry option rendered');
          assert.equal(manual.dataset.qid, 'Q778899', 'normalized to uppercase');

          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          assert.equal(view.state.doc.toString(), '[Q778899](Q778899)');
        } finally {
          closeAnyPopup();
          destroy();
        }
      }
    );
  });

  it('shows an inline offline notice on a search fetch rejection, and keeps the popup open for manual entry (FR-WD.4)', async () => {
    await withStubFetch(
      () => { throw new TypeError('Failed to fetch'); },
      async () => {
        const { view, destroy } = mountView('', 0);
        try {
          wikidata.linkEntityCommand(view);
          const input = document.querySelector('.sk-wd-input');
          input.value = 'unreachable';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(wikidata._internal.debounceMs + 150);

          const notice = document.querySelector('.sk-wd-notice');
          assert.ok(notice && !notice.hidden, 'offline notice shown');
          assert.ok(/offline|unavailable/i.test(notice.textContent), notice.textContent);
          assert.ok(document.querySelector('.sk-wd-popup'), 'popup stays open (manual entry still works)');
        } finally {
          closeAnyPopup();
          destroy();
        }
      }
    );
  });

  it('Escape closes the popup and returns focus to the editor', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 200, body: { search: [] } }),
      async () => {
        const { view, destroy } = mountView('hello', 0);
        try {
          wikidata.linkEntityCommand(view);
          assert.ok(document.querySelector('.sk-wd-popup'));
          const input = document.querySelector('.sk-wd-input');
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          assert.ok(!document.querySelector('.sk-wd-popup'), 'Escape closes the popup');
          assert.equal(document.activeElement, view.contentDOM, 'focus returns to the editor');
        } finally {
          destroy();
        }
      }
    );
  });

  it('Tab from the input moves to the close button and Shift+Tab moves back (focus trap)', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 200, body: { search: [] } }),
      async () => {
        const { view, destroy } = mountView('hello', 0);
        try {
          wikidata.linkEntityCommand(view);
          const input = document.querySelector('.sk-wd-input');
          const closeBtn = document.querySelector('.sk-wd-close');
          assert.equal(document.activeElement, input, 'input focused on open');

          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
          assert.equal(document.activeElement, closeBtn, 'Tab moves to the close button');

          closeBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
          assert.equal(document.activeElement, input, 'Shift+Tab traps focus back to the input');
        } finally {
          closeAnyPopup();
          destroy();
        }
      }
    );
  });

  it('coalesces rapid typing into a single debounced search request (FR-WD.4: ≥300ms)', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 200, body: { search: [] } }),
      async (calls) => {
        const { view, destroy } = mountView('', 0);
        try {
          wikidata.linkEntityCommand(view);
          const input = document.querySelector('.sk-wd-input');
          for (const partial of ['d', 'da', 'dar']) {
            input.value = partial;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(50); // well under the debounce window
          }
          await sleep(wikidata._internal.debounceMs + 150);
          assert.equal(calls.length, 1, `expected exactly 1 fetch call from 3 rapid keystrokes, got ${calls.length}`);
        } finally {
          closeAnyPopup();
          destroy();
        }
      }
    );
  });

  it('a newer search aborts an in-flight earlier one', async () => {
    const calls = [];
    globalThis._wd_original_fetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      calls.push({ url, signal: opts.signal });
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
        // Deliberately never resolves otherwise — simulates a slow network
        // so the first request is still in flight when the second fires.
      });
    };
    try {
      const { view, destroy } = mountView('', 0);
      try {
        wikidata.linkEntityCommand(view);
        const input = document.querySelector('.sk-wd-input');
        input.value = 'alpha';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(wikidata._internal.debounceMs + 100);
        assert.equal(calls.length, 1);

        input.value = 'alphabeta';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(wikidata._internal.debounceMs + 100);
        assert.equal(calls.length, 2);
        assert.ok(calls[0].signal.aborted, 'the earlier AbortController fired when superseded');
      } finally {
        closeAnyPopup();
        destroy();
      }
    } finally {
      globalThis.fetch = globalThis._wd_original_fetch;
      delete globalThis._wd_original_fetch;
    }
  });
});

// ── qidHoverExtension / buildEntityCardDom ──────────────────────────────

describe('wikidata: hover card (FR-WD.3)', () => {
  it('renders synchronously from cache (loading skeleton first) without ever calling fetch', async () => {
    await entityCache.put('Q501030', {
      label: 'Cached Hover Entity', description: 'from cache', wikidataUrl: 'https://www.wikidata.org/wiki/Q501030',
    });
    await withStubFetch(
      () => fakeResponse({ status: 200, body: { entities: {} } }),
      async (calls) => {
        const { dom, ready } = wikidata.buildEntityCardDom('Q501030');
        assert.ok(dom.querySelector('.sk-wd-hover-loading'), 'loading state shown synchronously (never blocks)');
        await ready;
        assert.equal(calls.length, 0, 'a cached qid must not trigger a fetch');
        assert.equal(dom.querySelector('.sk-wd-hover-label').textContent, 'Cached Hover Entity');
        assert.equal(dom.querySelector('.sk-wd-hover-desc').textContent, 'from cache');
        const link = dom.querySelector('.sk-wd-hover-link');
        assert.ok(link, '"Open on Wikidata" link present');
        assert.equal(link.getAttribute('href'), 'https://www.wikidata.org/wiki/Q501030');
        assert.equal(link.target, '_blank');
      }
    );
  });

  it('shows a thumbnail image when the cached entity has one', async () => {
    await entityCache.put('Q501032', {
      label: 'With Thumb', description: '', thumbnail: 'https://upload.wikimedia.org/x.jpg',
      wikidataUrl: 'https://www.wikidata.org/wiki/Q501032',
    });
    await withStubFetch(
      () => { throw new Error('must not fetch — Q501032 is cached'); },
      async () => {
        const { dom, ready } = wikidata.buildEntityCardDom('Q501032');
        await ready;
        const img = dom.querySelector('.sk-wd-thumb');
        assert.ok(img, 'thumbnail rendered');
        assert.equal(img.getAttribute('src'), 'https://upload.wikimedia.org/x.jpg');
      }
    );
  });

  it('shows an offline notice when the fetch rejects for an uncached qid', async () => {
    await withStubFetch(
      () => { throw new TypeError('Failed to fetch'); },
      async () => {
        const { dom, ready } = wikidata.buildEntityCardDom('Q501031');
        await ready;
        assert.ok(dom.querySelector('.sk-wd-hover-notice'), 'offline notice rendered');
      }
    );
  });

  it('qidHoverExtension() returns a composable CM6 extension array', () => {
    const ext = wikidata.qidHoverExtension();
    assert.ok(Array.isArray(ext) && ext.length >= 1);
    // Must compose cleanly into a real EditorState (no foreign-extension throw).
    const { destroy } = mountView('[x](Q1)', 0, ext);
    destroy();
  });
});

// ── createEntityResolver: WP-2.4 resolver-hook glue ─────────────────────

describe('wikidata: createEntityResolver (resolver-glue for lang-storykit.js)', () => {
  it('resolver() is a synchronous miss on first call and queues the qid; prime(view) fetches it and dispatches storykit.refreshEntities', async () => {
    await withStubFetch(
      () => fakeResponse({
        status: 200,
        body: {
          entities: {
            Q501020: {
              labels: { en: { value: 'Resolver Entity' } },
              descriptions: { en: { value: 'desc' } },
              claims: {},
            },
          },
        },
      }),
      async () => {
        const { resolver, prime } = wikidata.createEntityResolver();
        const { view, seenTransactions, destroy } = mountView('[x](Q501020)', 0);
        try {
          assert.equal(resolver('Q501020'), null, 'first call is a synchronous cache miss');

          await prime(view);

          const info = resolver('Q501020');
          assert.ok(info && info.label === 'Resolver Entity', 'resolved from the session cache after prime()');

          const sawRefresh = seenTransactions.some((tr) =>
            tr.effects.some((e) => e.is(storykit.refreshEntities))
          );
          assert.ok(sawRefresh, 'prime() dispatched storykit.refreshEntities on the view');
        } finally {
          destroy();
        }
      }
    );
  });

  it('a qid that resolves to nothing is cached as a negative result (no infinite requeue)', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 200, body: { entities: {} } }),
      async () => {
        const { resolver, prime } = wikidata.createEntityResolver();
        assert.equal(resolver('Q501021'), null);
        await prime();
        // Still null, but now served synchronously from the session cache —
        // a second resolver() call must NOT re-trigger a fetch.
        await withStubFetch(
          () => { throw new Error('must not refetch an already-resolved-negative qid'); },
          async () => {
            assert.equal(resolver('Q501021'), null);
            await Promise.resolve(); // flush any stray microtask flush
          }
        );
      }
    );
  });

  it('an invalid qid shape is ignored (never queued)', () => {
    const { resolver } = wikidata.createEntityResolver();
    assert.equal(resolver('not-a-qid'), null);
    assert.equal(resolver(''), null);
    assert.equal(resolver(null), null);
  });
});
