// tests/unit/context.test.js  (WP-3.2)
//
// Unit tests for editor/context.js — the skrender context builder + repo
// cache (docs/editor-plan.md §1.2, docs/editor-spec.md FR-PRE.2/FR-PRE.4).
//
// Hermeticity: `globalThis.fetch` is stubbed per test (saved/restored), so no
// test ever touches api.github.com, raw.githubusercontent.com, or the Chirpy
// CDN. editor/github.js is exercised THROUGH its real implementation (its
// fetch is the same stubbed global), which keeps the bound-mode tests honest
// about the wire protocol (If-None-Match headers, 304/404 handling).
//
// Cache isolation: the repoCache lives in the shared "storykit-editor"
// IndexedDB, which persists across tests within one page load. Bound-mode
// tests therefore use a UNIQUE owner per test (o-fresh, o-stale, …) so keys
// never collide. Unbound-mode keys are fixed ('unbound/storykit-starter/
// main/…'), so those tests clear the 'unbound/' key prefix first via a
// direct idb connection (same pattern store.test.js documents; initStore()
// runs first so the direct connection never races the schema upgrade).

import { openDB } from 'idb';
import { describe, it, assert } from './runner.js';
import { buildContext } from '../../editor/context.js';
import { initStore, repoCache } from '../../editor/store.js';

const DB_NAME = 'storykit-editor';
const DB_VERSION = 1;

const FRESHNESS_MS = 5 * 60 * 1000; // mirror of context.js's constant
const STALE_AGE_MS = FRESHNESS_MS + 60 * 1000; // comfortably stale
const CHIRPY_CDN = 'https://cdn.jsdelivr.net/gh/cotes2020/jekyll-theme-chirpy@';
const RAW_STARTER = 'https://raw.githubusercontent.com/rsnyder/storykit-starter/main/';

// ── test helpers ────────────────────────────────────────────────────────

/** Minimal Response-alike (same shape github.test.js uses). */
function fakeResponse({ status, headers = {}, body = '' } = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (lower.has(String(k).toLowerCase()) ? lower.get(String(k).toLowerCase()) : null) },
    async json() { return text ? JSON.parse(text) : null; },
    async text() { return text; },
    clone() { return fakeResponse({ status, headers, body: text }); },
  };
}

/** UTF-8-safe base64 (to build GitHub Contents API payloads). */
function b64encodeUtf8(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
}

/** A 200 GitHub Contents API response carrying `content`. */
function apiFileResponse(content, { etag = 'W/"etag"' } = {}) {
  return fakeResponse({
    status: 200,
    headers: { etag },
    body: { content: b64encodeUtf8(content), encoding: 'base64', sha: 'sha1' },
  });
}

/** Runs `fn` with globalThis.fetch replaced by `stub`, always restoring. */
async function withStubFetch(stub, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return stub(String(url), opts, calls);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Seeds fresh cache entries for the three files buildContext itself resolves
 * (_config.yml, locales, origin), so bound-mode tests can call buildContext
 * with ZERO network noise and focus their stubs on the path under test.
 */
async function seedContextBasics({ owner, repo = 'r', branch = 'main', at = Date.now(), configYaml = 'title: seeded' }) {
  const rows = [
    ['_config.yml', configYaml],
    ['_data/locales/en.yml', 'post: {seeded: true}'],
    ['_data/origin/default.yml', 'seeded: true'],
  ];
  for (const [path, content] of rows) {
    await repoCache.put(
      repoCache.makeKey({ owner, repo, ref: branch, path }),
      { etag: 'W/"seed"', content, fetchedAt: at, source: 'github' },
    );
  }
}

/** Deletes every repoCache row whose key starts with `prefix`. */
async function clearRepoCachePrefix(prefix) {
  await initStore(); // make sure the schema exists before a direct connection
  const db = await openDB(DB_NAME, DB_VERSION);
  const tx = db.transaction('repoCache', 'readwrite');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if (String(cursor.key).startsWith(prefix)) await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
  db.close();
}

// ── context shape ────────────────────────────────────────────────────────

describe('context: produced shape (skrender contract + additive fields)', () => {
  it('bound context carries every contracted field, the WP-1.2 deltas, and diagnostics', async () => {
    const owner = 'o-shape';
    await seedContextBasics({ owner, configYaml: 'url: https://ex.io\nbaseurl: /b\ntitle: Shape' });
    await withStubFetch(
      () => { throw new TypeError('unexpected network'); },
      async (calls) => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        assert.equal(calls.length, 0, 'fully seeded context should build with zero network');
        assert.equal(typeof ctx.config, 'object');
        assert.equal(ctx.config.title, 'Shape');
        assert.equal(ctx.assetOrigin, 'https://ex.io');
        assert.equal(ctx.baseurl, '/b');
        assert.equal(ctx.rawContentBase, 'https://raw.githubusercontent.com/o-shape/r/main/');
        assert.equal(typeof ctx.resolveFile, 'function');
        assert.ok(ctx.layouts instanceof Map && ctx.layouts.size === 0);
        assert.ok(ctx.includes instanceof Map && ctx.includes.size === 0);
        assert.ok(Array.isArray(ctx.diagnostics), 'additive diagnostics array present');
        assert.ok('origin' in ctx, 'origin present when _data/origin/default.yml resolves');
        assert.deepEqual(ctx.origin, { default: { seeded: true } });
        assert.deepEqual(ctx.locales, { en: { post: { seeded: true } } });
      }
    );
  });
});

// ── resolveFile chain: cache states ──────────────────────────────────────

describe('context: resolveFile cache chain', () => {
  it('cache hit (fresh) serves from repoCache with no network call', async () => {
    const owner = 'o-fresh';
    await seedContextBasics({ owner });
    await repoCache.put(
      repoCache.makeKey({ owner, repo: 'r', ref: 'main', path: '_posts/a.md' }),
      { etag: 'W/"a1"', content: 'FRESH CONTENT', fetchedAt: Date.now(), source: 'github' },
    );
    await withStubFetch(
      () => { throw new TypeError('unexpected network'); },
      async (calls) => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        const text = await ctx.resolveFile('_posts/a.md');
        assert.equal(text, 'FRESH CONTENT');
        assert.equal(calls.length, 0, 'fresh hit must not touch the network');
      }
    );
  });

  it('cache hit (stale) revalidates with If-None-Match; 304 serves cache and refreshes fetchedAt', async () => {
    const owner = 'o-stale';
    const staleAt = Date.now() - STALE_AGE_MS;
    const key = repoCache.makeKey({ owner, repo: 'r', ref: 'main', path: '_posts/s.md' });
    await seedContextBasics({ owner });
    await repoCache.put(key, { etag: 'W/"e9"', content: 'STALE-BUT-VALID', fetchedAt: staleAt, source: 'github' });
    await withStubFetch(
      (url, opts) => {
        assert.ok(url.startsWith('https://api.github.com/repos/o-stale/r/contents/_posts/s.md'),
          `revalidation should hit the Contents API, got ${url}`);
        assert.equal(opts.headers['If-None-Match'], 'W/"e9"', 'must send the cached ETag');
        return fakeResponse({ status: 304 });
      },
      async (calls) => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        const text = await ctx.resolveFile('_posts/s.md');
        assert.equal(text, 'STALE-BUT-VALID');
        assert.equal(calls.length, 1, 'exactly one revalidation request');
        const row = await repoCache.get(key);
        assert.ok(row.fetchedAt > staleAt, '304 must refresh fetchedAt');
        assert.equal(row.content, 'STALE-BUT-VALID', 'content untouched by 304');
      }
    );
  });

  it('cache miss fetches from GitHub and stores content+etag in repoCache', async () => {
    const owner = 'o-miss';
    const key = repoCache.makeKey({ owner, repo: 'r', ref: 'main', path: '_posts/new.md' });
    await seedContextBasics({ owner });
    await withStubFetch(
      (url) => {
        assert.ok(url.includes('api.github.com/repos/o-miss/r/contents/_posts/new.md'));
        return apiFileResponse('BRAND NEW', { etag: 'W/"n1"' });
      },
      async (calls) => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        const text = await ctx.resolveFile('_posts/new.md');
        assert.equal(text, 'BRAND NEW');
        assert.equal(calls.length, 1);
        const row = await repoCache.get(key);
        assert.equal(row.content, 'BRAND NEW');
        assert.equal(row.etag, 'W/"n1"');
        assert.equal(row.source, 'github');
      }
    );
  });

  it('a miss everywhere (repo 404 + gem 404) is cached as a negative entry and never refetched while fresh', async () => {
    const owner = 'o-neg';
    const key = repoCache.makeKey({ owner, repo: 'r', ref: 'main', path: '_includes/nope.html' });
    await seedContextBasics({ owner });
    await withStubFetch(
      (url) => {
        if (url.includes('api.github.com')) return fakeResponse({ status: 404, body: { message: 'Not Found' } });
        if (url.startsWith(CHIRPY_CDN)) return fakeResponse({ status: 404 });
        throw new TypeError(`unrouted: ${url}`);
      },
      async (calls) => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        assert.equal(await ctx.resolveFile('_includes/nope.html'), null);
        assert.equal(calls.length, 2, 'one repo probe + one gem probe');
        const row = await repoCache.get(key);
        assert.ok(row, 'negative entry must be cached');
        assert.equal(row.content, null);

        // A brand-new context (fresh per-render memo) must serve the negative
        // entry from cache — zero additional requests.
        const ctx2 = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        assert.equal(await ctx2.resolveFile('_includes/nope.html'), null);
        assert.equal(calls.length, 2, 'negative entry served from cache, no refetch');
      }
    );
  });

  it('a repo 404 falls back to the Chirpy gem CDN and caches the gem copy', async () => {
    const owner = 'o-gemfall';
    await seedContextBasics({ owner });
    await withStubFetch(
      (url) => {
        if (url.includes('api.github.com')) return fakeResponse({ status: 404, body: { message: 'Not Found' } });
        if (url.startsWith(CHIRPY_CDN)) {
          assert.ok(url.includes('jekyll-theme-chirpy@v7.5.0/_includes/refactor-content.html'),
            `gem URL must pin CHIRPY_VERSION, got ${url}`);
          return fakeResponse({ status: 200, body: 'GEM INCLUDE BODY' });
        }
        throw new TypeError(`unrouted: ${url}`);
      },
      async () => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        assert.equal(await ctx.resolveFile('_includes/refactor-content.html'), 'GEM INCLUDE BODY');
        const row = await repoCache.get(
          repoCache.makeKey({ owner, repo: 'r', ref: 'main', path: '_includes/refactor-content.html' })
        );
        assert.equal(row.content, 'GEM INCLUDE BODY');
        assert.equal(row.source, 'gem');
      }
    );
  });

  it('gem-only seed paths (e.g. _layouts/default.html) skip the GitHub probe entirely', async () => {
    const owner = 'o-gemseed';
    await seedContextBasics({ owner });
    await withStubFetch(
      (url) => {
        assert.ok(!url.includes('api.github.com'), `gem-only path must not probe GitHub: ${url}`);
        assert.ok(url.startsWith(CHIRPY_CDN));
        return fakeResponse({ status: 200, body: '<html>DEFAULT LAYOUT</html>' });
      },
      async (calls) => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        assert.equal(await ctx.resolveFile('_layouts/default.html'), '<html>DEFAULT LAYOUT</html>');
        assert.equal(calls.length, 1, 'exactly one CDN request, zero GitHub requests');
      }
    );
  });

  it('per-render memoization: repeated resolveFile of one path costs one cache/network pass', async () => {
    const owner = 'o-memo';
    await seedContextBasics({ owner });
    await withStubFetch(
      () => apiFileResponse('MEMOIZED'),
      async (calls) => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        // Fire concurrently — a non-memoized resolver would fetch twice.
        const [a, b] = await Promise.all([
          ctx.resolveFile('_posts/memo.md'),
          ctx.resolveFile('_posts/memo.md'),
        ]);
        assert.equal(a, 'MEMOIZED');
        assert.equal(b, 'MEMOIZED');
        assert.equal(calls.length, 1, 'memoized wrapper must dedupe concurrent lookups');
      }
    );
  });
});

// ── offline behaviour ─────────────────────────────────────────────────────

describe('context: offline / network failure (FR-PRE.5)', () => {
  it('serves the stale cached entry when offline and pushes a stale-cache diagnostic', async () => {
    const owner = 'o-offstale';
    const staleAt = Date.now() - STALE_AGE_MS;
    await seedContextBasics({ owner });
    await repoCache.put(
      repoCache.makeKey({ owner, repo: 'r', ref: 'main', path: '_posts/o.md' }),
      { etag: 'W/"o1"', content: 'LAST KNOWN GOOD', fetchedAt: staleAt, source: 'github' },
    );
    await withStubFetch(
      () => { throw new TypeError('Failed to fetch'); },
      async () => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        const text = await ctx.resolveFile('_posts/o.md');
        assert.equal(text, 'LAST KNOWN GOOD', 'stale cache must be served offline');
        const diag = ctx.diagnostics.find((d) => d.message.startsWith('offline: serving stale cache from'));
        assert.ok(diag, `expected a stale-cache diagnostic, got ${JSON.stringify(ctx.diagnostics)}`);
        assert.equal(diag.level, 'warn');
        assert.equal(diag.stage, 'fetch');
      }
    );
  });

  it('returns null when offline and cold, surfacing "context incomplete" via diagnostics', async () => {
    const owner = 'o-offcold';
    await seedContextBasics({ owner });
    await withStubFetch(
      () => { throw new TypeError('Failed to fetch'); },
      async () => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        const text = await ctx.resolveFile('_posts/never-seen.md');
        assert.equal(text, null, 'cold offline miss must resolve to null, never throw');
        assert.ok(
          ctx.diagnostics.some((d) => d.level === 'warn' && d.message.startsWith('offline: context incomplete')),
          `expected an incomplete-context diagnostic, got ${JSON.stringify(ctx.diagnostics)}`
        );
      }
    );
  });

  it('buildContext itself survives a fully offline cold start (config {} + warning, no throw)', async () => {
    await clearRepoCachePrefix('unbound/');
    await withStubFetch(
      () => { throw new TypeError('Failed to fetch'); },
      async () => {
        const ctx = await buildContext({ binding: null });
        assert.deepEqual(ctx.config, {}, 'config degrades to {} offline-cold');
        assert.equal(ctx.locales, null);
        assert.ok(!('origin' in ctx), 'origin omitted when unresolvable');
        assert.ok(ctx.diagnostics.length > 0, 'offline warnings pre-populated by buildContext');
      }
    );
  });
});

// ── unbound mode ──────────────────────────────────────────────────────────

describe('context: unbound mode (binding=null, FR-PRE.4)', () => {
  it('serves starter files from raw.githubusercontent and gem files from the Chirpy CDN', async () => {
    await clearRepoCachePrefix('unbound/');
    await withStubFetch(
      (url) => {
        if (url === `${RAW_STARTER}_config.yml`) {
          return fakeResponse({
            status: 200,
            headers: { etag: 'W/"cfg"' },
            body: 'url: https://rsnyder.github.io\nbaseurl: /storykit-starter\nlang: en\ntitle: StoryKit',
          });
        }
        if (url === `${RAW_STARTER}_includes/embed/image.html`) {
          return fakeResponse({ status: 200, body: 'IMAGE EMBED SOURCE' });
        }
        if (url.startsWith(CHIRPY_CDN)) {
          if (url.endsWith('/_data/locales/en.yml')) return fakeResponse({ status: 200, body: 'post: {written_by: By}' });
          if (url.endsWith('/_data/origin/default.yml')) return fakeResponse({ status: 200, body: 'cors: true' });
          if (url.endsWith('/_layouts/default.html')) return fakeResponse({ status: 200, body: 'GEM DEFAULT LAYOUT' });
          return fakeResponse({ status: 404 });
        }
        throw new TypeError(`unrouted: ${url}`);
      },
      async () => {
        const ctx = await buildContext({ binding: null });
        assert.equal(ctx.assetOrigin, 'https://rsnyder.github.io', 'assetOrigin derived from fetched _config.yml');
        assert.equal(ctx.baseurl, '/storykit-starter', 'baseurl derived from fetched _config.yml');
        assert.equal(ctx.rawContentBase, RAW_STARTER, 'unbound rawContentBase is the starter raw base');
        assert.deepEqual(ctx.locales, { en: { post: { written_by: 'By' } } });
        assert.deepEqual(ctx.origin, { default: { cors: true } });
        assert.equal(await ctx.resolveFile('_includes/embed/image.html'), 'IMAGE EMBED SOURCE');
        assert.equal(await ctx.resolveFile('_layouts/default.html'), 'GEM DEFAULT LAYOUT');
      }
    );
  });

  it('HERMETIC: unbound buildContext + one resolveFile performs zero api.github.com requests', async () => {
    await clearRepoCachePrefix('unbound/');
    await withStubFetch(
      (url) => {
        if (url.startsWith(RAW_STARTER)) return fakeResponse({ status: 200, body: 'raw body' });
        if (url.startsWith(CHIRPY_CDN)) return fakeResponse({ status: 200, body: 'gem body' });
        throw new TypeError(`unrouted: ${url}`);
      },
      async (calls) => {
        const ctx = await buildContext({ binding: null });
        await ctx.resolveFile('_includes/embed/youtube.html');
        assert.ok(calls.length > 0, 'sanity: something was fetched');
        const githubCalls = calls.filter((c) => c.url.includes('api.github.com'));
        assert.equal(githubCalls.length, 0,
          `unbound mode must never hit api.github.com; saw: ${githubCalls.map((c) => c.url).join(', ')}`);
      }
    );
  });

  it('caches unbound entries under the "unbound" pseudo-binding key', async () => {
    await clearRepoCachePrefix('unbound/');
    await withStubFetch(
      (url) => {
        if (url.startsWith(RAW_STARTER)) return fakeResponse({ status: 200, body: 'starter file' });
        if (url.startsWith(CHIRPY_CDN)) return fakeResponse({ status: 200, body: 'gem file' });
        throw new TypeError(`unrouted: ${url}`);
      },
      async () => {
        const ctx = await buildContext({ binding: null });
        await ctx.resolveFile('_tabs/about.md');
        const row = await repoCache.get(
          repoCache.makeKey({ owner: 'unbound', repo: 'storykit-starter', ref: 'main', path: '_tabs/about.md' })
        );
        assert.ok(row, 'entry must live under the unbound pseudo-binding namespace');
        assert.equal(row.content, 'starter file');
      }
    );
  });
});

// ── config / locales / origin parsing ─────────────────────────────────────

describe('context: config / locales / origin parsing', () => {
  it('parses _config.yml, _data/locales/<lang>.yml, and _data/origin/default.yml (bound)', async () => {
    const owner = 'o-parse';
    await withStubFetch(
      (url) => {
        if (url.includes('api.github.com') && url.includes('_config.yml')) {
          return apiFileResponse('url: https://ex.io\nbaseurl: /b\nlang: en\ntitle: Parsed\ndefaults:\n  - scope: {type: posts}\n    values: {layout: post}');
        }
        if (url.startsWith(CHIRPY_CDN)) {
          if (url.endsWith('/_data/locales/en.yml')) return fakeResponse({ status: 200, body: 'post:\n  written_by: By\n  updated: Updated' });
          if (url.endsWith('/_data/origin/default.yml')) return fakeResponse({ status: 200, body: 'webfonts: https://fonts.example/css' });
          return fakeResponse({ status: 404 });
        }
        throw new TypeError(`unrouted: ${url}`);
      },
      async () => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        assert.equal(ctx.config.title, 'Parsed');
        assert.equal(ctx.config.defaults[0].values.layout, 'post');
        assert.equal(ctx.assetOrigin, 'https://ex.io');
        assert.equal(ctx.baseurl, '/b');
        assert.equal(ctx.locales.en.post.written_by, 'By');
        assert.deepEqual(ctx.origin, { default: { webfonts: 'https://fonts.example/css' } });
      }
    );
  });

  it('falls back to _data/locales/en.yml when config.lang has no locale file', async () => {
    const owner = 'o-lang';
    await withStubFetch(
      (url) => {
        if (url.includes('api.github.com')) {
          if (url.includes('_config.yml')) return apiFileResponse('lang: fr\ntitle: French');
          if (url.includes('_data/locales/fr.yml')) return fakeResponse({ status: 404, body: { message: 'Not Found' } });
          return fakeResponse({ status: 404, body: { message: 'Not Found' } });
        }
        if (url.startsWith(CHIRPY_CDN)) {
          if (url.endsWith('/_data/locales/fr.yml')) return fakeResponse({ status: 404 });
          if (url.endsWith('/_data/locales/en.yml')) return fakeResponse({ status: 200, body: 'post: {written_by: By}' });
          if (url.endsWith('/_data/origin/default.yml')) return fakeResponse({ status: 200, body: 'x: y' });
          return fakeResponse({ status: 404 });
        }
        throw new TypeError(`unrouted: ${url}`);
      },
      async () => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'main' } });
        assert.deepEqual(ctx.locales, { en: { post: { written_by: 'By' } } }, 'en fallback locales (keyed under en, the language actually loaded)');
      }
    );
  });
});

// ── branch awareness ──────────────────────────────────────────────────────

describe('context: makeKey branch-awareness', () => {
  it('the same path on different branches yields distinct cache entries', async () => {
    const owner = 'o-branch';
    // Seed the basics for BOTH branches plus a 'main' copy of the post.
    await seedContextBasics({ owner, branch: 'main' });
    await seedContextBasics({ owner, branch: 'dev' });
    const mainKey = repoCache.makeKey({ owner, repo: 'r', ref: 'main', path: '_posts/p.md' });
    const devKey = repoCache.makeKey({ owner, repo: 'r', ref: 'dev', path: '_posts/p.md' });
    assert.ok(mainKey !== devKey, 'makeKey must incorporate the branch');
    await repoCache.put(mainKey, { etag: 'W/"m"', content: 'MAIN COPY', fetchedAt: Date.now(), source: 'github' });

    await withStubFetch(
      (url) => {
        assert.ok(url.includes('ref=dev'), `dev-branch context must fetch ref=dev, got ${url}`);
        return apiFileResponse('DEV COPY', { etag: 'W/"d"' });
      },
      async (calls) => {
        const ctx = await buildContext({ binding: { owner, repo: 'r', branch: 'dev' } });
        const text = await ctx.resolveFile('_posts/p.md');
        assert.equal(text, 'DEV COPY', 'dev branch must not be served the main-branch cache entry');
        assert.equal(calls.length, 1);
        const mainRow = await repoCache.get(mainKey);
        const devRow = await repoCache.get(devKey);
        assert.equal(mainRow.content, 'MAIN COPY', 'main entry untouched');
        assert.equal(devRow.content, 'DEV COPY', 'dev entry cached separately');
      }
    );
  });
});
