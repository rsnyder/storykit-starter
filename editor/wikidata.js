/**
 * editor/wikidata.js — Wikidata entity search + hover cards (WP-4.2)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2, §3 WP-4.2; docs/editor-spec.md
 * FR-WD.1–4. Talks to the public Wikidata action API directly (CORS-enabled
 * via `origin=*`, no key/auth):
 *
 *   searchEntities(q, {signal})
 *     GET https://www.wikidata.org/w/api.php
 *         ?action=wbsearchentities&search=<q>&language=en&format=json
 *         &origin=*&limit=8
 *     → Promise<Array<{ qid, label, description }>>
 *     Abort-safe: pass an AbortSignal; a fetch aborted mid-flight rejects
 *     with the platform's AbortError, which callers should treat as "ignore,
 *     a newer search superseded this one" rather than a real failure.
 *
 *   getEntities(qids)
 *     entityCache-backed (editor/store.js `entityCache`, 30-day TTL): every
 *     qid is served from cache when fresh; only misses are fetched, batched
 *     (≤50 ids/request — Wikidata's own limit) via
 *         GET .../w/api.php?action=wbgetentities&ids=<Q1|Q2|…>
 *             &props=labels|descriptions|claims&languages=en&format=json&origin=*
 *     `claims` is requested (rather than the narrower labels|descriptions)
 *     solely to reach the P18 ("image") statement so a Commons thumbnail can
 *     be built — see "Thumbnail algorithm" below. Freshly-fetched entities
 *     are written back via entityCache.put before the Promise resolves.
 *     → Promise<{ [qid]: { label, description, thumbnail?, wikidataUrl } }>
 *     A network/offline failure leaves the affected qids simply absent from
 *     the result object (never throws) — callers degrade per-qid.
 *
 *   linkEntityCommand(view)
 *     The ⌘⇧K command body (WP-4.3 registers the keybinding itself — see
 *     editor/commands.js precedent). Synchronously opens a focus-trapped
 *     popup anchored under the selection (or cursor) and returns `true`
 *     (CM6 command contract: "handled"). Selected text (if any) is used
 *     verbatim as the link text on insert (FR-WD.1); with no selection the
 *     chosen entity's label is used instead (FR-WD.2). Search is live,
 *     debounced ≥300ms, superseding requests abort the prior one. A
 *     `Qnnnn`-shaped manual entry is always offered (FR-WD.4) so the
 *     feature works fully offline.
 *
 *   qidHoverExtension()
 *     `hoverTooltip` wired over `[text](Qnnnn)` links, found via
 *     lang-storykit.js's exported `scanLinks` (the same scanner that drives
 *     the `sk-qid-link` decoration — see WP-2.4's FR-EDIT.5 hook) rather
 *     than re-deriving the link grammar. Cards render a loading skeleton
 *     synchronously, then populate from getEntities (cache-first, so a
 *     cached qid never re-fetches) — "never blocks" per the WP-4.2 brief.
 *
 * ── Thumbnail algorithm (Commons thumb URL from a P18 filename) ────────────
 * Reused faithfully from the two existing, independently-verified JS
 * implementations already shipping in this repo (both build the exact same
 * upload.wikimedia.org/…/thumb/<A>/<AB>/<Name>/<width>px-<Name> shape that
 * Wikimedia's own thumbnailer expects, mirroring _includes/media-url.html's
 * Liquid `md5` filter, ruby-side, at _plugins/md5_filter.rb):
 *   - assets/js/storykit.js `mwImage()` (:573–600) — the closest match:
 *     given a bare Commons filename, replace spaces with underscores,
 *     md5-hash the normalized name, and build
 *     `.../thumb/<hash[0]>/<hash[0..2]>/<name>/<width>px-<name>`
 *     (`.png`/`.jpg` extension override for svg/tif/tiff sources).
 *   - assets/js/skrender.js `md5()` (:124–155) — the pure-JS MD5 used
 *     because LiquidJS ships no md5 filter; duplicated verbatim below since
 *     this module has no import-map access to assets/js/skrender.js (that
 *     file is a shared *renderer* module, not part of the editor's pinned
 *     graph) and no npm/bundler is available to pull in a package (buildless
 *     discipline, docs/editor-plan.md §0.4).
 * `commonsThumbUrl()` below is `mwImage(..., width)`'s width>0 branch,
 * renamed for this call site; P18 already gives a bare filename (no
 * `wc:`/`File:`/`Special:FilePath/` prefix to strip), so that stripping
 * logic is intentionally omitted. Verified against a known vector: md5
 * ("Example.jpg") = a91fe217e45a700fc2dab0cc476f01c7 (computed independently
 * via the system `md5` tool, not re-derived from this file's own md5() —
 * see tests/unit/wikidata.test.js) → thumb path `.../thumb/a/a9/Example.jpg/
 * 120px-Example.jpg`, which is genuinely Commons' real thumbnail path for
 * that file.
 *
 * ── Resolver glue for WP-4.3 (editor/lang-storykit.js's FR-EDIT.5 hook) ────
 * lang-storykit.js exposes:
 *   storykit.setEntityResolver(fn)   fn: (qid) => {label?,description?}|null,
 *                                     called SYNCHRONOUSLY while building QID
 *                                     decorations.
 *   storykit.refreshEntities         a StateEffectType<null>; dispatching it
 *                                     forces a decoration rebuild.
 * `createEntityResolver()` (additive export, not in the original §1.2
 * signature list but explicitly commissioned by this WP's brief) adapts
 * that hook to getEntities. Usage — the whole of WP-4.3's wiring:
 *
 *   import { createEntityResolver } from './wikidata.js';
 *   import { storykit } from './lang-storykit.js';
 *   ...
 *   const { resolver, prime } = createEntityResolver();
 *   storykit.setEntityResolver(resolver);         // once, at startup
 *   // ...after `const { view } = createEditor({ extraExtensions: [...] })`:
 *   prime(view);                                  // one call is enough
 *
 * `resolver(qid)` reads a synchronous in-memory (session) Map — returns
 * `null` on a miss AND queues the qid. Queued qids are flushed on a
 * microtask (so a whole decoration-build pass's worth of qids coalesces
 * into one getEntities call) using the most recent `view` passed to
 * `prime()`; after the fetch, matched qids populate the session Map and, if
 * a view is known, `storykit.refreshEntities.of(null)` is dispatched so the
 * decoration ViewPlugin recomputes titles. Because the decoration builder
 * also queues qids on later viewport scrolls (independent of any second
 * `prime()` call), calling `prime(view)` once right after mount is enough —
 * the remembered view services every later automatic flush too. Calling
 * `prime(view)` again (e.g. after switching documents) is harmless and just
 * updates which view refresh-effects are dispatched to.
 */

import { hoverTooltip } from '@codemirror/view';
import { entityCache } from './store.js';
import { storykit, scanLinks } from './lang-storykit.js';

// ── constants ────────────────────────────────────────────────────────────
const API = 'https://www.wikidata.org/w/api.php';
const QID_RE = /^Q\d+$/;
const QID_RE_I = /^Q\d+$/i;

/** Tunable knobs, exposed for tests (mirrors editor/github.js's `_internal`
 * pattern) — not part of the frozen contract. */
export const _internal = {
  searchLimit: 8,
  thumbWidth: 120, // spec: "~120px" thumbnail
  batchSize: 50,   // Wikidata's own per-request ids cap
  debounceMs: 320, // FR-WD.4: "MUST be debounced (≥300 ms)"
};

// ── MD5 (pure JS; see "Thumbnail algorithm" header note for provenance) ────
function md5(str) {
  function safeAdd(x, y) { const lsw = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xffff); }
  function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function md5blks(s) {
    const l = s.length, nblk = ((l + 8) >> 6) + 1, blks = new Array(nblk * 16).fill(0);
    for (let i = 0; i < l; i++) blks[i >> 2] |= (s.charCodeAt(i) & 0xff) << ((i % 4) * 8);
    blks[l >> 2] |= 0x80 << ((l % 4) * 8);
    blks[nblk * 16 - 2] = l * 8;
    return blks;
  }
  function rhex(n) { let s = '', j = 0; for (; j < 4; j++) s += ('0' + ((n >>> (j * 8)) & 0xff).toString(16)).slice(-2); return s; }
  const x = md5blks(str);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const [oa, ob, oc, od] = [a, b, c, d];
    a = md5ff(a, b, c, d, x[i], 7, -680876936); d = md5ff(d, a, b, c, x[i + 1], 12, -389564586); c = md5ff(c, d, a, b, x[i + 2], 17, 606105819); b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = md5ff(a, b, c, d, x[i + 4], 7, -176418897); d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426); c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341); b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416); d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417); c = md5ff(c, d, a, b, x[i + 10], 17, -42063); b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682); d = md5ff(d, a, b, c, x[i + 13], 12, -40341101); c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290); b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = md5gg(a, b, c, d, x[i + 1], 5, -165796510); d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632); c = md5gg(c, d, a, b, x[i + 11], 14, 643717713); b = md5gg(b, c, d, a, x[i], 20, -373897302);
    a = md5gg(a, b, c, d, x[i + 5], 5, -701558691); d = md5gg(d, a, b, c, x[i + 10], 9, 38016083); c = md5gg(c, d, a, b, x[i + 15], 14, -660478335); b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = md5gg(a, b, c, d, x[i + 9], 5, 568446438); d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690); c = md5gg(c, d, a, b, x[i + 3], 14, -187363961); b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467); d = md5gg(d, a, b, c, x[i + 2], 9, -51403784); c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473); b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = md5hh(a, b, c, d, x[i + 5], 4, -378558); d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463); c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562); b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060); d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353); c = md5hh(c, d, a, b, x[i + 7], 16, -155497632); b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = md5hh(a, b, c, d, x[i + 13], 4, 681279174); d = md5hh(d, a, b, c, x[i], 11, -358537222); c = md5hh(c, d, a, b, x[i + 3], 16, -722521979); b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = md5hh(a, b, c, d, x[i + 9], 4, -640364487); d = md5hh(d, a, b, c, x[i + 12], 11, -421815835); c = md5hh(c, d, a, b, x[i + 15], 16, 530742520); b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = md5ii(a, b, c, d, x[i], 6, -198630844); d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415); c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905); b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571); d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606); c = md5ii(c, d, a, b, x[i + 10], 15, -1051523); b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359); d = md5ii(d, a, b, c, x[i + 15], 10, -30611744); c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380); b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = md5ii(a, b, c, d, x[i + 4], 6, -145523070); d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379); c = md5ii(c, d, a, b, x[i + 2], 15, 718787259); b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = safeAdd(a, oa); b = safeAdd(b, ob); c = safeAdd(c, oc); d = safeAdd(d, od);
  }
  return rhex(a) + rhex(b) + rhex(c) + rhex(d);
}

/** Bare Commons filename (no wc:/File:/Special:FilePath prefix — P18 gives
 * that already) → a `<width>px-` thumbnail URL. See header note. */
function commonsThumbUrl(rawFilename, width = _internal.thumbWidth) {
  if (!rawFilename) return undefined;
  const name = String(rawFilename).replace(/ /g, '_');
  const hash = md5(name);
  const ext = name.split('.').pop()?.toLowerCase();
  let url = `https://upload.wikimedia.org/wikipedia/commons/thumb/${hash.slice(0, 1)}/${hash.slice(0, 2)}/${name}/${width}px-${name}`;
  if (ext === 'svg') url += '.png';
  else if (ext === 'tif' || ext === 'tiff') url += '.jpg';
  return url;
}

// ── injected styles (own stylesheet, --sk-* tokens with hermetic fallbacks) ─
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'sk-wikidata-styles';
  style.textContent = `
.sk-wd-popup {
  position: fixed; z-index: 10000; width: 320px; max-width: calc(100vw - 24px);
  background: var(--sk-surface, #fff); color: var(--sk-text, #1f2328);
  border: 1px solid var(--sk-border, #d8dee4); border-radius: var(--sk-radius-lg, 10px);
  box-shadow: var(--sk-shadow-2, 0 8px 24px rgba(31,35,40,.18));
  font: var(--sk-fs-base, 14px)/1.4 var(--sk-font-sans, -apple-system, sans-serif);
  padding: var(--sk-space-1, 8px);
}
.sk-wd-header { display: flex; align-items: center; gap: var(--sk-space-1, 8px); margin-bottom: var(--sk-space-1, 8px); }
.sk-wd-input {
  flex: 1; box-sizing: border-box; padding: 6px 8px; border-radius: var(--sk-radius, 6px);
  border: 1px solid var(--sk-border-strong, #c2c9d1); background: var(--sk-bg, #fff);
  color: var(--sk-text, #1f2328); font: inherit;
}
.sk-wd-input:focus-visible, .sk-wd-close:focus-visible, .sk-wd-result:focus-visible {
  outline: 2px solid var(--sk-focus, #0969da); outline-offset: 1px;
}
.sk-wd-close {
  border: none; background: transparent; color: var(--sk-text-muted, #57606a);
  font-size: 16px; line-height: 1; cursor: pointer; padding: 4px 6px; border-radius: var(--sk-radius-sm, 4px);
}
.sk-wd-close:hover { background: var(--sk-bg-sunken, #f6f8fa); }
.sk-wd-results { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; }
.sk-wd-result {
  display: flex; gap: var(--sk-space-1, 8px); align-items: center; padding: 6px;
  border-radius: var(--sk-radius, 6px); cursor: pointer;
}
.sk-wd-result.is-active, .sk-wd-result:hover { background: var(--sk-selection, rgba(9,105,218,.14)); }
.sk-wd-result.is-manual { border-top: 1px dashed var(--sk-border, #d8dee4); margin-top: 4px; padding-top: 8px; }
.sk-wd-thumb, .sk-wd-thumb-placeholder {
  width: 32px; height: 32px; border-radius: var(--sk-radius-sm, 4px); flex: none;
  background: var(--sk-skeleton-a, #eaeef2); object-fit: cover;
}
.sk-wd-result-text { min-width: 0; }
.sk-wd-result-label { font-weight: 600; color: var(--sk-text, #1f2328); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk-wd-result-desc { color: var(--sk-text-muted, #57606a); font-size: var(--sk-fs-xs, 12px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk-wd-empty, .sk-wd-loading { color: var(--sk-text-faint, #656d76); padding: 8px 6px; font-size: var(--sk-fs-sm, 13px); }
.sk-wd-notice {
  margin-top: var(--sk-space-1, 8px); padding: 6px 8px; border-radius: var(--sk-radius, 6px);
  background: var(--sk-bg-sunken, #f6f8fa); color: var(--sk-warning, #9a6700); font-size: var(--sk-fs-xs, 12px);
}
.sk-wd-hover-card {
  display: flex; gap: var(--sk-space-1, 8px); align-items: flex-start; max-width: 280px;
  padding: var(--sk-space-1, 8px); font: var(--sk-fs-sm, 13px)/1.4 var(--sk-font-sans, -apple-system, sans-serif);
  color: var(--sk-text, #1f2328); background: var(--sk-elevated, #fff);
}
.sk-wd-hover-body { min-width: 0; }
.sk-wd-hover-label { font-weight: 600; }
.sk-wd-hover-desc { color: var(--sk-text-muted, #57606a); margin: 2px 0 4px; }
.sk-wd-hover-link { color: var(--sk-accent, #0056b2); }
.sk-wd-hover-loading, .sk-wd-hover-notice { color: var(--sk-text-faint, #656d76); }
`;
  document.head.appendChild(style);
}

// ── searchEntities ───────────────────────────────────────────────────────

/**
 * @param {string} q
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<{ qid: string, label: string, description: string }>>}
 */
export async function searchEntities(q, { signal } = {}) {
  const query = (q || '').trim();
  if (!query) return [];
  const url = `${API}?action=wbsearchentities&search=${encodeURIComponent(query)}`
    + `&language=en&format=json&origin=*&limit=${_internal.searchLimit}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Wikidata search failed: HTTP ${res.status}`);
  const data = await res.json();
  const results = Array.isArray(data?.search) ? data.search : [];
  return results.map((r) => ({
    qid: r.id,
    label: r.label || r.id,
    description: r.description || '',
  }));
}

// ── getEntities ──────────────────────────────────────────────────────────

function parseEntity(qid, raw) {
  if (!raw || raw.missing !== undefined) return null;
  const label = raw.labels?.en?.value || qid;
  const description = raw.descriptions?.en?.value || '';
  const filename = raw.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  const entity = { label, description, wikidataUrl: `https://www.wikidata.org/wiki/${qid}` };
  if (filename) {
    const thumb = commonsThumbUrl(filename);
    if (thumb) entity.thumbnail = thumb;
  }
  return entity;
}

/**
 * Cache-first (editor/store.js `entityCache`, 30-day TTL), batched
 * `wbgetentities` lookup. Never throws on network failure — a batch that
 * fails to fetch simply leaves its qids absent from the result.
 * @param {string[]} qids
 * @returns {Promise<{ [qid: string]: { label: string, description: string, thumbnail?: string, wikidataUrl: string } }>}
 */
export async function getEntities(qids) {
  const unique = [...new Set((qids || []).filter((q) => QID_RE.test(q)))];
  /** @type {Record<string, object>} */
  const result = {};
  const misses = [];
  for (const qid of unique) {
    const cached = await entityCache.get(qid);
    if (cached) result[qid] = cached;
    else misses.push(qid);
  }
  if (!misses.length) return result;

  for (let i = 0; i < misses.length; i += _internal.batchSize) {
    const batch = misses.slice(i, i + _internal.batchSize);
    const url = `${API}?action=wbgetentities&ids=${batch.join('|')}`
      + `&props=labels|descriptions|claims&languages=en&format=json&origin=*`;
    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Wikidata getEntities failed: HTTP ${res.status}`);
      data = await res.json();
    } catch {
      continue; // offline/network failure: leave this batch's qids unresolved
    }
    const entities = data?.entities || {};
    for (const qid of batch) {
      const entity = parseEntity(qid, entities[qid]);
      if (entity) {
        result[qid] = entity;
        await entityCache.put(qid, entity);
      }
    }
  }
  return result;
}

// ── linkEntityCommand: ⌘⇧K search popup ─────────────────────────────────

/** Module singleton so a second invocation replaces (never stacks) a popup. */
let activePopup = null;

function closePopup() {
  if (activePopup) activePopup.destroy();
  activePopup = null;
}

/**
 * @param {import('@codemirror/view').EditorView} view
 * @returns {boolean}
 */
export function linkEntityCommand(view) {
  closePopup();
  ensureStyles();

  const { from, to } = view.state.selection.main;
  const hadSelection = from !== to;
  const selectedText = hadSelection ? view.state.sliceDoc(from, to) : '';
  const coords = view.coordsAtPos(hadSelection ? to : from)
    || view.coordsAtPos(from)
    || { left: 40, right: 40, bottom: 40, top: 40 };

  activePopup = openPopup({ view, from, to, hadSelection, selectedText, coords });
  return true;
}

function openPopup({ view, from, to, hadSelection, selectedText, coords }) {
  const root = document.createElement('div');
  root.className = 'sk-wd-popup';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Link Wikidata entity');
  root.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 328))}px`;
  root.style.top = `${Math.min(coords.bottom + 6, window.innerHeight - 60)}px`;

  const header = document.createElement('div');
  header.className = 'sk-wd-header';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sk-wd-input';
  input.placeholder = 'Search Wikidata…';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'sk-wd-listbox');
  input.value = selectedText;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sk-wd-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';

  header.append(input, closeBtn);

  const list = document.createElement('ul');
  list.className = 'sk-wd-results';
  list.id = 'sk-wd-listbox';
  list.setAttribute('role', 'listbox');

  const notice = document.createElement('div');
  notice.className = 'sk-wd-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;

  root.append(header, list, notice);
  document.body.appendChild(root);

  // ── state ──────────────────────────────────────────────────────────────
  let items = []; // [{qid,label,description,manual?}]
  let activeIndex = -1;
  let debounceTimer = null;
  let controller = null;
  let destroyed = false;

  function manualItemFor(value) {
    const v = value.trim();
    if (!QID_RE_I.test(v)) return null;
    const qid = v.toUpperCase();
    return { qid, label: qid, description: 'Use this QID directly', manual: true };
  }

  function renderItems() {
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'sk-wd-empty';
      empty.textContent = input.value.trim() ? 'No matches.' : 'Type to search Wikidata…';
      list.appendChild(empty);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'sk-wd-result' + (item.manual ? ' is-manual' : '') + (i === activeIndex ? ' is-active' : '');
      li.id = `sk-wd-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === activeIndex));
      li.dataset.qid = item.qid;
      li.dataset.index = String(i);

      const thumb = document.createElement('div');
      thumb.className = 'sk-wd-thumb-placeholder';
      thumb.setAttribute('aria-hidden', 'true');

      const text = document.createElement('div');
      text.className = 'sk-wd-result-text';
      const label = document.createElement('div');
      label.className = 'sk-wd-result-label';
      label.textContent = item.manual ? `Use ${item.qid} directly` : item.label;
      const desc = document.createElement('div');
      desc.className = 'sk-wd-result-desc';
      desc.textContent = item.description || '';
      text.append(label, desc);

      li.append(thumb, text);
      list.appendChild(li);
    });
    if (activeIndex >= 0) input.setAttribute('aria-activedescendant', `sk-wd-opt-${activeIndex}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function setItems(results) {
    const manual = manualItemFor(input.value);
    items = manual ? [...results, manual] : [...results];
    activeIndex = items.length ? 0 : -1;
    renderItems();
  }

  function showNotice(message) {
    notice.textContent = message;
    notice.hidden = false;
  }
  function hideNotice() {
    notice.hidden = true;
  }

  async function runSearch(query) {
    if (controller) controller.abort();
    if (destroyed) return;
    if (!query.trim()) {
      controller = null;
      setItems([]);
      hideNotice();
      return;
    }
    controller = new AbortController();
    const mine = controller;
    try {
      const results = await searchEntities(query, { signal: mine.signal });
      if (destroyed || mine.signal.aborted) return;
      hideNotice();
      setItems(results);
    } catch (err) {
      if (mine.signal.aborted) return; // superseded by a newer search
      if (destroyed) return;
      setItems([]);
      showNotice('Offline or Wikidata unavailable — you can still enter a QID like Q42 directly.');
    }
  }

  function scheduleSearch() {
    if (debounceTimer) clearTimeout(debounceTimer);
    const query = input.value;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSearch(query);
    }, _internal.debounceMs);
  }

  function moveActive(delta) {
    if (!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    renderItems();
  }

  function selectItem(item) {
    if (!item) return;
    const linkText = hadSelection ? selectedText : (item.label || item.qid);
    const insertText = `[${linkText}](${item.qid})`;
    view.dispatch({
      changes: { from, to, insert: insertText },
      selection: { anchor: from + insertText.length },
    });
    destroy();
    view.focus();
  }

  function onInputKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      destroy();
      view.focus();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const active = activeIndex >= 0 ? items[activeIndex] : null;
      if (active) selectItem(active);
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      closeBtn.focus();
      return;
    }
  }

  function onCloseKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      destroy();
      view.focus();
      return;
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      input.focus();
    }
  }

  input.addEventListener('input', () => {
    scheduleSearch();
  });
  input.addEventListener('keydown', onInputKeydown);
  closeBtn.addEventListener('keydown', onCloseKeydown);
  closeBtn.addEventListener('click', () => { destroy(); view.focus(); });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('.sk-wd-result');
    if (!li) return;
    const item = items[Number(li.dataset.index)];
    selectItem(item);
  });

  function onOutsidePointerDown(e) {
    if (!root.contains(e.target)) destroy();
  }
  // Deferred so the keyboard shortcut / click that opened the popup doesn't
  // immediately close it via this same listener.
  const attachOutsideListener = () => {
    if (destroyed) return;
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
  };
  queueMicrotask(attachOutsideListener);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (controller) controller.abort();
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    root.remove();
    if (activePopup && activePopup.destroy === destroy) activePopup = null;
  }

  // Initial state + kick off the prefilled search (still debounced, per FR-WD.4).
  renderItems();
  scheduleSearch();
  input.focus();
  input.select();

  return { destroy, root };
}

// ── qidHoverExtension: hover cards on [text](Qnnnn) ─────────────────────

/** Finds the `[text](Qnnnn)` link range (if any) containing `pos`, via
 * lang-storykit's own link scanner so the hover surface matches the
 * `sk-qid-link` decoration exactly. */
function qidLinkAt(state, pos) {
  const margin = 400;
  const from = Math.max(0, pos - margin);
  const to = Math.min(state.doc.length, pos + margin);
  const text = state.doc.sliceString(from, to);
  const { qidLinks } = scanLinks(text, from);
  return qidLinks.find((l) => pos >= l.from && pos <= l.to) || null;
}

/**
 * Builds the hover-card DOM for `qid`: a loading skeleton synchronously,
 * then populated from getEntities (cache-first — a cached qid never
 * triggers a fetch). Exported (additive) so tests can drive it without
 * simulating real pointer hover timing over a mounted CM6 view.
 * @param {string} qid
 * @returns {{ dom: HTMLElement, ready: Promise<void> }}
 */
export function buildEntityCardDom(qid) {
  ensureStyles();
  const dom = document.createElement('div');
  dom.className = 'sk-wd-hover-card';

  const loading = document.createElement('div');
  loading.className = 'sk-wd-hover-loading';
  loading.textContent = 'Loading…';
  dom.appendChild(loading);

  const ready = getEntities([qid]).then((map) => {
    const entity = map[qid];
    dom.replaceChildren();
    if (!entity) {
      const notice = document.createElement('div');
      notice.className = 'sk-wd-hover-notice';
      notice.textContent = `${qid} — no entity data available.`;
      dom.appendChild(notice);
      return;
    }
    if (entity.thumbnail) {
      const img = document.createElement('img');
      img.className = 'sk-wd-thumb';
      img.src = entity.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      dom.appendChild(img);
    }
    const body = document.createElement('div');
    body.className = 'sk-wd-hover-body';
    const label = document.createElement('div');
    label.className = 'sk-wd-hover-label';
    label.textContent = entity.label;
    const desc = document.createElement('div');
    desc.className = 'sk-wd-hover-desc';
    desc.textContent = entity.description || '';
    const link = document.createElement('a');
    link.className = 'sk-wd-hover-link';
    link.href = entity.wikidataUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open on Wikidata';
    body.append(label, desc, link);
    dom.appendChild(body);
  }).catch(() => {
    dom.replaceChildren();
    const notice = document.createElement('div');
    notice.className = 'sk-wd-hover-notice';
    notice.textContent = 'Offline — entity details unavailable.';
    dom.appendChild(notice);
  });

  return { dom, ready };
}

/**
 * Hover cards on `[text](Qnnnn)` links (FR-WD.3).
 * @returns {import('@codemirror/state').Extension[]}
 */
export function qidHoverExtension() {
  ensureStyles();
  return [
    hoverTooltip((view, pos) => {
      const link = qidLinkAt(view.state, pos);
      if (!link) return null;
      return {
        pos: link.from,
        end: link.to,
        above: true,
        create() {
          const { dom } = buildEntityCardDom(link.qid);
          return { dom };
        },
      };
    }, { hoverTime: 300 }),
  ];
}

// ── createEntityResolver: glue for the WP-2.4 hook (see header note) ─────

/**
 * @returns {{
 *   resolver: (qid: string) => { label?: string, description?: string } | null,
 *   prime: (view?: import('@codemirror/view').EditorView) => Promise<void>,
 * }}
 */
export function createEntityResolver() {
  /** @type {Map<string, object|null>} */
  const sessionCache = new Map();
  const queued = new Set();
  let scheduled = false;
  let latestView = null;

  async function flush() {
    if (!queued.size) return;
    const qids = [...queued];
    queued.clear();
    let fetched = {};
    try {
      fetched = await getEntities(qids);
    } catch {
      // Offline/failure: leave these qids unresolved; a later resolver()
      // call (e.g. on the next decoration rebuild) will re-queue them.
      return;
    }
    let changed = false;
    for (const qid of qids) {
      const entity = fetched[qid] || null;
      // Negative results are cached too (as null) so a permanently-missing
      // qid doesn't get re-queued on every decoration rebuild.
      sessionCache.set(qid, entity);
      if (entity) changed = true;
    }
    if (changed && latestView) {
      latestView.dispatch({ effects: storykit.refreshEntities.of(null) });
    }
  }

  function scheduleFlush() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      flush();
    });
  }

  function resolver(qid) {
    if (!qid || !QID_RE.test(qid)) return null;
    if (sessionCache.has(qid)) return sessionCache.get(qid);
    queued.add(qid);
    scheduleFlush();
    return null;
  }

  function prime(view) {
    if (view) latestView = view;
    return flush();
  }

  return { resolver, prime };
}
