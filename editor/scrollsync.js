/**
 * editor/scrollsync.js — split-view scroll synchronization (pure core).
 *
 * Approach (docs/editor-spec.md has no FR for this; it's an additive
 * nice-to-have, default-on in Split with a palette toggle): StoryKit posts
 * carry dense, deterministic anchors —
 *   - headings: markdown `#`-lines ↔ the preview's h1..h6[id] elements
 *     (Chirpy's pipeline always assigns heading ids), matched by NORMALIZED
 *     TEXT in document order (nth occurrence pairs with nth occurrence, so
 *     duplicate headings work);
 *   - viewers: `{% include embed/… id="X" %}` lines ↔ the preview's
 *     `iframe#X` elements, matched by id.
 * The intersection (in order, monotonic both sides) plus synthetic
 * document-start/end endpoints forms a piecewise-linear map between source
 * LINE numbers and preview PIXEL offsets. Sync is exact at anchors,
 * interpolated between them, and degrades to whole-document proportional
 * mapping when a post has no anchors at all. It can be wrong by a paragraph;
 * it cannot break: no renderer changes, no DOM mutations, mapping failures
 * just mean "no scroll".
 *
 * WHY NOT renderer line-maps (the markdown-it `token.map` technique): source
 * text passes through LIQUID before markdown-it here, so renderer line
 * numbers refer to post-expansion text and drift from the CM6 buffer —
 * that path is permanently brittle in this architecture.
 *
 * Everything in this file is pure (no DOM): the DOM-facing halves live with
 * their owners (anchor extraction from the preview document in preview.js's
 * host app wiring; CM6 geometry in app.js).
 */

/** Normalize heading text for order-preserving matching across the two
 *  representations (markdown source vs rendered textContent). */
export function normalizeHeadingText(text) {
  return String(text || '')
    // markdown link → its text, images → alt
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // inline code/emphasis markers
    .replace(/[`*_~]/g, '')
    // kramdown IAL / header-id attr list on the heading line
    .replace(/\{[:#][^}]*\}/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9À-￿]+/g, ' ')
    .trim();
}

/**
 * Scan the SOURCE buffer for anchor lines.
 * @param {string} text — the full document (front matter included)
 * @returns {{line:number, key:string}[]} 1-based line numbers, in order.
 *   Keys: `h:<n>:<normalized text>` (n = occurrence index) · `v:<id>`.
 */
export function extractSourceAnchors(text) {
  const anchors = [];
  const seen = new Map(); // normalized heading text → occurrence count
  const lines = String(text || '').split('\n');
  let inFront = false;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === '---') { inFront = true; continue; }
    if (inFront) { if (line.trim() === '---') inFront = false; continue; }
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      const norm = normalizeHeadingText(h[2]);
      if (norm) {
        const n = (seen.get(norm) || 0) + 1;
        seen.set(norm, n);
        anchors.push({ line: i + 1, key: `h:${n}:${norm}` });
      }
      continue;
    }
    if (/\{%\s*include\s+embed\//.test(line)) {
      const idm = line.match(/\bid\s*=\s*"([^"]+)"/);
      if (idm) anchors.push({ line: i + 1, key: `v:${idm[1]}` });
    }
  }
  return anchors;
}

/**
 * Build the piecewise-linear map from matched anchors.
 * @param {{line:number, key:string}[]} sourceAnchors
 * @param {{top:number,  key:string}[]} previewAnchors — top = absolute
 *        document offset (px) of the anchor element in the preview
 * @param {number} totalLines   — source line count (≥1)
 * @param {number} totalHeight  — preview scrollable height (px, ≥0)
 * @returns {{srcLine:number, pvTop:number}[]} monotonic in BOTH coordinates,
 *          always including {1,0} and {totalLines, totalHeight} endpoints.
 */
export function buildScrollMap(sourceAnchors, previewAnchors, totalLines, totalHeight) {
  const pvByKey = new Map();
  for (const a of previewAnchors) {
    if (!pvByKey.has(a.key)) pvByKey.set(a.key, a.top); // first occurrence wins
  }
  const pairs = [{ srcLine: 1, pvTop: 0 }];
  let lastLine = 1;
  let lastTop = 0;
  for (const a of sourceAnchors) {
    const top = pvByKey.get(a.key);
    if (top === undefined) continue;
    // enforce monotonicity in both axes — drop out-of-order matches
    if (a.line <= lastLine || top < lastTop) continue;
    pairs.push({ srcLine: a.line, pvTop: top });
    lastLine = a.line;
    lastTop = top;
  }
  const endLine = Math.max(totalLines, lastLine + 1);
  const endTop = Math.max(totalHeight, lastTop);
  pairs.push({ srcLine: endLine, pvTop: endTop });
  return pairs;
}

/** Interpolate: fractional source line → preview pixel offset. */
export function sourceToPreview(map, srcLine) {
  return interpolate(map, srcLine, 'srcLine', 'pvTop');
}

/** Interpolate: preview pixel offset → fractional source line. */
export function previewToSource(map, pvTop) {
  return interpolate(map, pvTop, 'pvTop', 'srcLine');
}

function interpolate(map, x, fromKey, toKey) {
  if (!Array.isArray(map) || map.length === 0) return 0;
  if (x <= map[0][fromKey]) return map[0][toKey];
  for (let i = 1; i < map.length; i++) {
    const a = map[i - 1];
    const b = map[i];
    if (x <= b[fromKey]) {
      const span = b[fromKey] - a[fromKey];
      const t = span > 0 ? (x - a[fromKey]) / span : 0;
      return a[toKey] + t * (b[toKey] - a[toKey]);
    }
  }
  return map[map.length - 1][toKey];
}
