/**
 * editor/context.js — skrender context builder + repo cache (WP-3.2)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. Builds a context in the
 * assets/js/skrender.js shape (§1.1, plus the WP-1.2 as-built deltas
 * `origin` and `rawContentBase`) so the editor's preview pane (WP-3.3) can
 * feed renderPost() the same inputs the deployed site's build — and the
 * preview/index.html shell — use. This module is the editor-side equivalent
 * of that shell's fetch layer (preview/index.html:284-493): it owns the
 * impure edges (GitHub / raw / Chirpy-CDN fetching, ETag revalidation, the
 * IndexedDB repoCache, config/_data parsing) behind a single injected
 * `resolveFile` seam that skrender calls LAZILY mid-render.
 *
 * ── Produced context shape ──────────────────────────────────────────────────
 *   {
 *     config:         object,        // parsed _config.yml ({} on miss)
 *     locales:        object|null,   // parsed _data/locales/<lang>.yml
 *     origin:         { default: object } | (absent),  // _data/origin/default.yml
 *     assetOrigin:    string,        // config.url (deployed origin for URL rewriting)
 *     baseurl:        string,        // config.baseurl
 *     rawContentBase: string,        // raw.githubusercontent base for relative content links
 *     resolveFile:    async (repoRelPath) => string|null,  // memoized seam
 *     layouts:        Map,           // empty pre-seed (misses fall through to resolveFile)
 *     includes:       Map,           // empty pre-seed
 *     diagnostics:    Diagnostic[],  // ADDITIVE (see below)
 *   }
 * `origin` is only present when the data file was found (mirrors the preview
 * shell; skrender omits origin-driven <link> tags when context.origin is
 * undefined).
 *
 * ── ADDITIVE FIELD: context.diagnostics ─────────────────────────────────────
 * Not part of the frozen §1.1 skrender shape. A live array (shared by
 * reference) of `{ level:'warn', stage:'fetch', message }` diagnostics that
 * buildContext PRE-POPULATES while resolving config/_data and that
 * `resolveFile` CONTINUES to push MID-RENDER (offline / stale-cache warnings).
 * WP-3.3 MUST merge `context.diagnostics` into the array returned by
 * renderPost() — and must read it AFTER renderPost() resolves, because
 * mid-render resolveFile calls append to it during the render pass. The shape
 * matches skrender's Diagnostic union (stage:'fetch'), so a plain concat is
 * sufficient. Messages are de-duplicated by text within a single context.
 *
 * ── resolveFile chain ───────────────────────────────────────────────────────
 * Per path, keyed by repoCache.makeKey({owner,repo,ref:branch,path}):
 *   1. repoCache hit, FRESH (< FRESHNESS_MS): serve cached content (null for a
 *      negative entry) with no network.
 *   2. repoCache hit, STALE, or MISS: resolve from the network:
 *        · bound   → github.getFile({etag}) — 'not-modified' refreshes
 *          fetchedAt and serves cached content; a fetch returns + caches;
 *          a null (404) falls through to the Chirpy gem fallback.
 *        · unbound → raw.githubusercontent of THIS starter
 *          (rsnyder/storykit-starter@main) with If-None-Match; a 404 falls
 *          through to the Chirpy gem fallback.
 *        · Chirpy gem fallback (BOTH modes, mirrors the preview shell's
 *          repo→CDN fetchFile): cdn.jsdelivr.net/gh/cotes2020/
 *          jekyll-theme-chirpy@<CHIRPY_VERSION>/<path>. Gem-only seed paths
 *          (layouts, gem includes, gem _data) skip the repo/raw probe and go
 *          straight to the CDN, conserving GitHub quota exactly as the shell's
 *          repoMissCache does.
 *   3. Absent from every source → cached as a NEGATIVE entry (content:null) so
 *      nested include probing (skrender treats null as "not found") never
 *      refetches it within the freshness window.
 *   4. OFFLINE / any fetch failure (GitHubError kind:'network'|'auth'|
 *      'rate-limit', or a raw/CDN fetch throw): serve the stale cached entry
 *      when one exists (+ 'offline: serving stale cache from <date>'
 *      diagnostic); when cold, return null (+ 'offline: context incomplete'
 *      diagnostic). resolveFile never throws.
 *
 * ── FRESHNESS POLICY (constants) ─────────────────────────────────────────────
 *   FRESHNESS_MS = 5 min. Entries younger are served without revalidation;
 *   older ones are revalidated (bound: ETag If-None-Match against GitHub;
 *   unbound: If-None-Match against raw.githubusercontent). This mirrors the
 *   ~5-min raw.githubusercontent CDN lag the preview shell documents.
 *
 * ── UNBOUND MODE ─────────────────────────────────────────────────────────────
 * When `binding` is null the pipeline serves this starter's canonical sources
 * so drafts still preview (FR-PRE.4): content from
 * raw.githubusercontent.com/rsnyder/storykit-starter/main/<path>, gem-only
 * files from the Chirpy CDN — NEVER api.github.com (no auth needed). Entries
 * are cached under the UNBOUND pseudo-binding key (owner 'unbound') so they
 * never collide with a real binding to rsnyder/storykit-starter@main.
 * assetOrigin/baseurl come from the starter's own _config.yml; rawContentBase
 * is the starter's raw.githubusercontent base (per the WP-3.2 brief, overriding
 * §1.1's '' default for unbound drafts).
 *
 * ── CHIRPY_VERSION ───────────────────────────────────────────────────────────
 * Mirrors preview/index.html's CHIRPY_VERSION (must match Gemfile.lock's
 * jekyll-theme-chirpy). tools/check_consistency.py enforces the preview
 * shell's copy against the gem; this second copy must be bumped in lock-step
 * when the gem is upgraded (logged in the WP-3.2 handoff notes).
 */

import { repoCache } from './store.js';
import * as github from './github.js';
import { load as yamlLoad } from 'js-yaml';

// ── Constants ────────────────────────────────────────────────────────────────

/** Cache entries younger than this are served without revalidation. */
const FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

/** This starter's canonical repo — the unbound-mode content source. */
const STARTER = { owner: 'rsnyder', repo: 'storykit-starter', branch: 'main' };

/** Pseudo-binding used to namespace unbound-mode repoCache keys. */
const UNBOUND = { owner: 'unbound', repo: 'storykit-starter', branch: 'main' };

/** Chirpy gem version on jsDelivr — mirror of preview/index.html:CHIRPY_VERSION. */
const CHIRPY_VERSION = 'v7.5.0';
const GEM_BASE = `https://cdn.jsdelivr.net/gh/cotes2020/jekyll-theme-chirpy@${CHIRPY_VERSION}/`;

/**
 * Paths known to live in the Chirpy gem, not a user/starter repo. These skip
 * the GitHub/raw probe and go straight to the CDN — mirrored from the preview
 * shell's repoMissCache (preview/index.html:313-339) so preview fidelity and
 * request economy match exactly.
 */
const GEM_ONLY_SEEDS = new Set([
  // Layouts — live in the Chirpy gem, not the user repo
  '_layouts/default.html', '_layouts/compress.html', '_layouts/page.html',
  '_layouts/home.html', '_layouts/archives.html', '_layouts/categories.html',
  '_layouts/tags.html',

  // Core Chirpy includes — gem-only
  '_includes/lang.html', '_includes/toc-status.html',
  '_includes/datetime.html', '_includes/read-time.html',
  '_includes/post-sharing.html', '_includes/head.html',
  '_includes/sidebar.html', '_includes/topbar.html',
  '_includes/footer.html', '_includes/comments.html',
  '_includes/toc.html', '_includes/trending-tags.html',
  '_includes/panel.html', '_includes/post-nav.html',
  '_includes/magic-round.html', '_includes/related-posts.html',
  '_includes/recently-updated.html', '_includes/no-linenos.html',
  '_includes/img-extra.html', '_includes/embed-video.html',
  '_includes/schema.html', '_includes/origin-type.html',
  '_includes/favicons.html', '_includes/js-selector.html',
  '_includes/jsdelivr-combine.html', '_includes/metadata-hook.html',
  '_includes/update-list.html', '_includes/search-results.html',
  '_includes/notification.html', '_includes/search-loader.html',

  // Data files — gem-only
  '_data/locales/en.yml',
  '_data/origin/default.yml',
]);

// ── Small helpers ────────────────────────────────────────────────────────────

/** Percent-encode a repo-relative path, preserving '/' as a segment separator. */
function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

/** Parse YAML text into an object; never throws (returns {} on error). */
function parseYaml(text) {
  if (!text) return {};
  try {
    return yamlLoad(text) || {};
  } catch {
    return {};
  }
}

function fmtDate(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

/**
 * skrender's createResolveFileCache, obtained lazily. skrender.js runs
 * `window.markdownit(...)` at module top-level, so importing it eagerly would
 * force the render globals to exist wherever context.js is imported (including
 * the buildless unit-test page and scaffold's import-smoke test). We therefore
 * import it only when a context is actually built, and fall back to an inline
 * identical implementation if the import fails (globals not yet loaded) — the
 * memoization semantics are what matter, and they are preserved either way.
 * The resolved wrapper is memoized across calls.
 */
let _cachedWrap = null;
async function getResolveFileCacheWrapper() {
  if (_cachedWrap) return _cachedWrap;
  try {
    const mod = await import('../assets/js/skrender.js');
    if (typeof mod.createResolveFileCache === 'function') {
      _cachedWrap = mod.createResolveFileCache;
      return _cachedWrap;
    }
  } catch {
    // skrender's render globals aren't present — use the local copy below.
  }
  _cachedWrap = localCreateResolveFileCache;
  return _cachedWrap;
}

/** Inline copy of skrender's createResolveFileCache (per-session memoization). */
function localCreateResolveFileCache(resolveFile) {
  const cache = new Map();
  return function cachedResolveFile(repoRelPath) {
    if (cache.has(repoRelPath)) return cache.get(repoRelPath);
    const p = Promise.resolve()
      .then(() => resolveFile(repoRelPath))
      .then((v) => (v == null ? null : v))
      .catch(() => null);
    cache.set(repoRelPath, p);
    return p;
  };
}

// ── Network fetchers (impure edges) ──────────────────────────────────────────

/**
 * Fetch a starter file from raw.githubusercontent.com (unbound mode). Direct
 * fetch, no auth. Sends If-None-Match when an etag is supplied.
 * @returns {Promise<{ content: string, etag: string } | 'not-modified' | null>}
 */
async function fetchRaw({ owner, repo, branch, path, etag }) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodePath(path)}`;
  const headers = etag ? { 'If-None-Match': etag } : {};
  const resp = await globalThis.fetch(url, { headers, cache: 'no-store' });
  if (resp.status === 304) return 'not-modified';
  if (resp.status === 404) return null;
  if (!resp.ok) return null; // private/other — treat as absent (gem fallback / negative)
  return { content: await resp.text(), etag: resp.headers.get('etag') || '' };
}

/**
 * Fetch a gem file from the Chirpy CDN (jsDelivr). Immutable per version, so no
 * conditional request is needed.
 * @returns {Promise<string|null>}
 */
async function fetchGem(path) {
  const resp = await globalThis.fetch(`${GEM_BASE}${encodePath(path)}`);
  if (resp.ok) return await resp.text();
  return null; // 404 or other — not in the gem
}

// ── The resolveFile chain ────────────────────────────────────────────────────

/**
 * Build the raw (pre-memoization) resolveFile.
 *
 * @param {object} args
 * @param {boolean} args.bound        — true: probe GitHub; false: probe raw.
 * @param {{owner,repo,branch}} args.fetchCoords — coordinates for the fetch URLs
 *   (bound: the bound repo; unbound: the STARTER repo).
 * @param {{owner,repo,branch}} args.keyBinding  — coordinates for the repoCache
 *   key (bound: same as fetchCoords; unbound: the UNBOUND pseudo-binding).
 * @param {(level,message)=>void} args.pushDiag  — sink for offline/stale diagnostics.
 * @returns {(path:string)=>Promise<string|null>} never throws.
 */
function makeRawResolve({ bound, fetchCoords, keyBinding, pushDiag }) {
  const { owner, repo, branch } = fetchCoords;

  async function putCache(key, value) {
    try {
      await repoCache.put(key, value);
    } catch {
      /* IndexedDB unavailable — non-fatal; the network layer still works. */
    }
  }

  async function resolveFromGem({ path, key, now }) {
    const text = await fetchGem(path);
    if (text == null) {
      // Absent everywhere — negative-cache so nested probing doesn't refetch.
      await putCache(key, { etag: '', content: null, fetchedAt: now, source: 'negative' });
      return null;
    }
    await putCache(key, { etag: '', content: text, fetchedAt: now, source: 'gem' });
    return text;
  }

  async function resolveFromNetwork({ path, key, cached, now }) {
    // Gem-only files skip the repo/raw probe entirely.
    if (GEM_ONLY_SEEDS.has(path)) {
      return resolveFromGem({ path, key, now });
    }

    if (bound) {
      const etag = cached && cached.source === 'github' ? cached.etag : undefined;
      const res = await github.getFile({ owner, repo, ref: branch, path, etag });
      if (res === 'not-modified') {
        await putCache(key, { ...cached, fetchedAt: now });
        return cached.content;
      }
      if (res === null) {
        // Not in the repo — mirror the shell's repo→CDN fallback.
        return resolveFromGem({ path, key, now });
      }
      await putCache(key, { etag: res.etag || '', content: res.content, fetchedAt: now, source: 'github' });
      return res.content;
    }

    // Unbound: raw.githubusercontent of the starter, then gem fallback.
    const etag = cached && cached.source === 'raw' ? cached.etag : undefined;
    const res = await fetchRaw({ owner, repo, branch, path, etag });
    if (res === 'not-modified') {
      await putCache(key, { ...cached, fetchedAt: now });
      return cached.content;
    }
    if (res === null) {
      return resolveFromGem({ path, key, now });
    }
    await putCache(key, { etag: res.etag || '', content: res.content, fetchedAt: now, source: 'raw' });
    return res.content;
  }

  return async function rawResolve(path) {
    const key = repoCache.makeKey({
      owner: keyBinding.owner,
      repo: keyBinding.repo,
      ref: keyBinding.branch,
      path,
    });

    let cached = null;
    try {
      cached = await repoCache.get(key);
    } catch {
      cached = null;
    }

    const now = Date.now();
    if (cached && now - cached.fetchedAt < FRESHNESS_MS) {
      // Fresh — serve without revalidation (content may be null for a negative).
      return cached.content ?? null;
    }

    try {
      return await resolveFromNetwork({ path, key, cached, now });
    } catch {
      // Any connectivity/auth/rate-limit failure (GitHubError or a raw/CDN
      // fetch throw): prefer stale cache, else surface an incomplete-context
      // warning. resolveFile must never throw.
      if (cached && cached.content != null) {
        pushDiag('warn', `offline: serving stale cache from ${fmtDate(cached.fetchedAt)} (${path})`);
        return cached.content;
      }
      pushDiag('warn', `offline: context incomplete — ${path} unavailable`);
      return null;
    }
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a skrender context for the editor's preview pane.
 *
 * @param {{ binding: { owner: string, repo: string, branch?: string } | null }} args
 *   binding: the repo the document is bound to, or null for unbound drafts.
 * @returns {Promise<object>} the skrender context (shape documented above).
 */
export async function buildContext({ binding } = {}) {
  const diagnostics = [];
  const pushDiag = (level, message) => {
    if (!diagnostics.some((d) => d.message === message)) {
      diagnostics.push({ level, stage: 'fetch', message });
    }
  };

  const bound = !!(binding && binding.owner && binding.repo);

  // fetchCoords drive the network URLs; keyBinding namespaces the repoCache.
  // Bound: both are the bound repo. Unbound: fetch the STARTER's real repo but
  // cache under the UNBOUND pseudo-binding so entries can't collide with a real
  // binding to rsnyder/storykit-starter@main.
  const fetchCoords = bound
    ? { owner: binding.owner, repo: binding.repo, branch: binding.branch || 'main' }
    : { owner: STARTER.owner, repo: STARTER.repo, branch: STARTER.branch };
  const keyBinding = bound ? fetchCoords : UNBOUND;

  const rawResolve = makeRawResolve({ bound, fetchCoords, keyBinding, pushDiag });

  const wrap = await getResolveFileCacheWrapper();
  const resolveFile = wrap(rawResolve);

  // ── config ────────────────────────────────────────────────────────────────
  const configText = await resolveFile('_config.yml');
  const config = parseYaml(configText);

  // ── locales (lang from config, default 'en') ────────────────────────────────
  const lang = (config && config.lang) || 'en';
  let localesText = await resolveFile(`_data/locales/${lang}.yml`);
  let localesLang = lang;
  if (!localesText && lang !== 'en') {
    localesText = await resolveFile('_data/locales/en.yml');
    localesLang = 'en';
  }
  // KEYED BY LANGUAGE: templates index site.data.locales[lang].<path> — a
  // flat (unkeyed) object made every locale string render empty in previews
  // ("2 min read" lost its unit, tooltips lost their labels, …).
  const locales = localesText ? { [localesLang]: parseYaml(localesText) } : null;

  // ── origin (Chirpy head.html reads site.data.origin[type]) ──────────────────
  const originText = await resolveFile('_data/origin/default.yml');
  const origin = originText ? { default: parseYaml(originText) } : undefined;

  // ── URL bases ───────────────────────────────────────────────────────────────
  const assetOrigin = (config && config.url) ||
    (typeof location !== 'undefined' ? location.origin : '');
  const baseurl = (config && config.baseurl) || '';
  // Bound: the bound repo's raw base. Unbound: the starter's raw base.
  const rawContentBase =
    `https://raw.githubusercontent.com/${fetchCoords.owner}/${fetchCoords.repo}/${fetchCoords.branch}/`;

  const context = {
    config,
    locales,
    assetOrigin,
    baseurl,
    rawContentBase,
    resolveFile,
    layouts: new Map(), // empty pre-seed: layouts fall through to resolveFile
    includes: new Map(), // empty pre-seed: includes fall through to resolveFile
    diagnostics,
  };
  // Match the preview shell: only expose `origin` when the data file was found
  // (skrender omits origin-driven <link> tags when context.origin is undefined).
  if (origin !== undefined) context.origin = origin;

  return context;
}
