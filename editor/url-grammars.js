// editor/url-grammars.js  (WP-0.3)
//
// Pure, dependency-free URL/drop-payload grammar for StoryKit's
// drag-and-drop and paste tag insertion (FR-DND.2–FR-DND.7). No DOM, no
// network, no CM6 — this module only classifies a dataTransfer-shaped
// payload and returns the tag text to insert. The actual CM6 drop/paste
// wiring lives in editor/dnd.js (WP-4.1), which is the consumer of the
// `parseDropPayload` export below.
//
// ---------------------------------------------------------------------
// Public contract (frozen, docs/editor-plan.md §1.2):
//
//   parseDropPayload({ uriList, text, html })
//     → {
//         kind: 'commons' | 'youtube' | 'maps' | 'maps-short' | 'link' | 'unknown',
//         tag?: string,        // Liquid include tag or Markdown link; absent
//                              // for 'maps-short' (can't be resolved
//                              // browser-side) and 'unknown'
//         chipLabel?: string,  // short human label for the drop-preview
//                              // chip (see spec §7); absent when there is
//                              // nothing useful to preview yet
//         message?: string,    // present only for 'maps-short': explains
//                              // why no tag could be produced
//       }
//
// Design: a data-driven grammar TABLE (array of matcher objects), each
// with `match(ctx) → result|null`. `parseDropPayload` walks the table in
// order and returns the first non-null result. Adding a new drop source
// (e.g. a future provider) means appending one matcher object — nothing
// else in this file changes. See GRAMMAR_TABLE below.
// ---------------------------------------------------------------------

/**
 * Picks the candidate URL/text to classify: the first non-comment,
 * non-blank line of `uriList` (the dataTransfer 'text/uri-list' flavor,
 * which may contain '#'-prefixed comment lines per RFC 2483), falling
 * back to `text` (the 'text/plain' flavor) when `uriList` is absent or
 * entirely comments/blank.
 */
function pickCandidate(uriList, text) {
  if (uriList) {
    const lines = String(uriList).split(/\r\n|\r|\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) return trimmed;
    }
  }
  if (text) {
    const trimmed = String(text).trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function tryParseUrl(candidate) {
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

// ---- Wikimedia Commons (FR-DND.2) -------------------------------------

/**
 * Given a raw (still percent-encoded) Commons filename fragment — as
 * captured from a File: page path, a Special:FilePath path, or an
 * upload.wikimedia.org path — produce the canonical `Name_With_Spaces.ext`
 * form used in `wc:<name>` src values (matches the convention already
 * used by `_includes/media-url.html` and existing posts, e.g.
 * `wc:Monument_Valley,_Utah,_USA.jpg`).
 */
function canonicalizeCommonsName(rawName) {
  if (!rawName) return null;
  let name = rawName.replace(/^File:/i, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Malformed percent-escapes: fall back to the raw (still-encoded)
    // string rather than throwing the whole drop away.
  }
  // NOTE: '+' is a literal character in URL path segments (and appears in
  // real Commons filenames), so unlike Maps place names it is NOT
  // converted to a space here.
  name = name.replace(/ /g, '_');
  return name || null;
}

/**
 * Extracts the *original* filename from an upload.wikimedia.org URL,
 * whether it's a direct file URL
 *   /wikipedia/commons/<h>/<hh>/Name.jpg
 * or a thumbnail URL
 *   /wikipedia/commons/thumb/<h>/<hh>/Name.jpg/640px-Name.jpg
 * (the thumb directory segment right after the two hash-prefix dirs is
 * always the untouched original filename — no need to parse the
 * "640px-" suffix at all). Returns the raw (still percent-encoded)
 * filename, or null if `url` isn't an upload.wikimedia.org file URL.
 */
function extractUploadFilename(rawUrl) {
  let u;
  try {
    // Dragged <img> markup sometimes carries protocol-relative srcs.
    u = new URL(rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== 'upload.wikimedia.org') return null;
  const path = u.pathname;

  let m = /^\/wikipedia\/commons\/thumb\/[^/]+\/[^/]+\/([^/]+)\/\d+px-/i.exec(path);
  if (m) return m[1];

  m = /^\/wikipedia\/commons\/[^/]+\/[^/]+\/([^/]+)$/i.exec(path);
  if (m) return m[1];

  return null;
}

/** Pulls the first <img src="..."> out of a dragged HTML fragment. */
function extractImgSrc(html) {
  if (!html) return null;
  const m = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html);
  return m ? m[1] : null;
}

function buildCommonsResult(canonicalName) {
  const tag = `{% include embed/image.html src="wc:${canonicalName}" %}`;
  return {
    kind: 'commons',
    tag,
    chipLabel: `Image viewer · wc:${canonicalName}`,
  };
}

function matchCommons({ url, urlObj, html }) {
  if (!urlObj) return null;
  const host = urlObj.hostname.toLowerCase();
  let rawName = null;

  if (host === 'commons.wikimedia.org' || host === 'commons.m.wikimedia.org') {
    const path = urlObj.pathname;

    let m = /^\/wiki\/File:(.+)$/i.exec(path);
    if (m) rawName = m[1];

    if (!rawName) {
      m = /^\/wiki\/Special:FilePath\/(.+)$/i.exec(path);
      if (m) rawName = m[1];
    }

    if (!rawName && html) {
      // <img>-drag from a Commons search/category results page: the
      // uri-list flavor is the page URL, not the image — pull the real
      // upload.wikimedia.org URL out of the dragged HTML instead.
      const imgSrc = extractImgSrc(html);
      if (imgSrc) rawName = extractUploadFilename(imgSrc);
    }
  } else if (host === 'upload.wikimedia.org') {
    rawName = extractUploadFilename(url);
  }

  if (!rawName) return null;
  const canonical = canonicalizeCommonsName(rawName);
  if (!canonical) return null;
  return buildCommonsResult(canonical);
}

// ---- YouTube (FR-DND.3) ------------------------------------------------

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Parses a YouTube `t=`/`start=` value into whole seconds. Accepts a bare
 * integer ("90"), a trailing-`s` form ("90s"), and compound
 * hours/minutes/seconds forms ("1m30s", "1h2m3s"). Returns null if the
 * value doesn't match any recognized form.
 */
function parseYoutubeTimecode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  if (/^\d+$/.test(s)) return parseInt(s, 10);

  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (m && (m[1] || m[2] || m[3])) {
    const h = parseInt(m[1] || '0', 10);
    const mi = parseInt(m[2] || '0', 10);
    const se = parseInt(m[3] || '0', 10);
    return h * 3600 + mi * 60 + se;
  }
  return null;
}

function buildYoutubeResult(id, startSeconds) {
  let tag = `{% include embed/youtube.html vid="${id}"`;
  if (startSeconds != null) tag += ` start="${startSeconds}"`;
  tag += ' %}';
  const chipLabel = `YouTube viewer · ${id}`;
  return { kind: 'youtube', tag, chipLabel };
}

function matchYoutube({ urlObj }) {
  if (!urlObj) return null;
  const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');
  let id = null;

  if (host === 'youtu.be') {
    const m = /^\/([^/?#]+)/.exec(urlObj.pathname);
    if (m) id = m[1];
  } else if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (urlObj.pathname === '/watch') {
      id = urlObj.searchParams.get('v');
    } else {
      let m = /^\/shorts\/([^/?#]+)/.exec(urlObj.pathname);
      if (!m) m = /^\/embed\/([^/?#]+)/.exec(urlObj.pathname);
      if (m) id = m[1];
    }
  }

  if (!id || !YOUTUBE_ID_RE.test(id)) return null;

  const rawT = urlObj.searchParams.get('t') ?? urlObj.searchParams.get('start');
  const startSeconds = parseYoutubeTimecode(rawT);

  return buildYoutubeResult(id, startSeconds);
}

// ---- Google Maps (FR-DND.4) --------------------------------------------

function roundZoom(zoomStr) {
  const n = Number(zoomStr);
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n * 10) / 10);
}

function decodePlaceName(raw) {
  let name = raw;
  try {
    name = decodeURIComponent(name);
  } catch {
    // leave as-is on malformed percent-escapes
  }
  return name.replace(/\+/g, ' ');
}

function matchMapsShort({ urlObj }) {
  if (!urlObj) return null;
  const host = urlObj.hostname.toLowerCase();
  if (host !== 'maps.app.goo.gl') return null;
  return {
    kind: 'maps-short',
    message:
      'Shortened Google Maps links (maps.app.goo.gl) can’t be expanded in the browser. ' +
      'Open the link, then drag from the full maps.google.com URL in the address bar instead.',
  };
}

function matchMaps({ url, urlObj }) {
  if (!urlObj) return null;
  const host = urlObj.hostname.toLowerCase();
  // Any google.<tld> host (google.com, www.google.com, maps.google.com,
  // google.co.uk, ...); maps.app.goo.gl is handled by matchMapsShort
  // before this runs.
  if (!/(^|\.)google\.[a-z.]+$/i.test(host)) return null;

  let lat = null;
  let lng = null;
  let zoom = null;

  // /@<lat>,<lng>,<zoom>z  (a trailing "m" instead of "z" is a camera
  // altitude in meters, not a zoom level — treat zoom as absent in that
  // case while still taking the center coordinates)
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)([a-z])/i.exec(url);
  if (at) {
    lat = at[1];
    lng = at[2];
    if (at[4].toLowerCase() === 'z') zoom = roundZoom(at[3]);
  } else {
    const atNoZoom = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url);
    if (atNoZoom) {
      lat = atNoZoom[1];
      lng = atNoZoom[2];
    }
  }

  // ?q=<lat>,<lng>
  if (lat == null) {
    const q = urlObj.searchParams.get('q');
    if (q) {
      const m = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(q.trim());
      if (m) {
        lat = m[1];
        lng = m[2];
      }
    }
  }

  if (lat == null || lng == null) return null;

  // /place/<name>/@... additionally supplies a caption
  let caption = null;
  const placeMatch = /\/place\/([^/@]+)/i.exec(urlObj.pathname);
  if (placeMatch) caption = decodePlaceName(placeMatch[1]);

  let tag = `{% include embed/map.html center="${lat}, ${lng}"`;
  if (zoom != null) tag += ` zoom="${zoom}"`;
  if (caption != null) tag += ` caption="${caption}"`;
  tag += ' %}';

  const chipLabel = caption ? `Map viewer · ${caption}` : `Map viewer · ${lat}, ${lng}`;

  return { kind: 'maps', tag, chipLabel };
}

// ---- Grammar table ------------------------------------------------------
//
// Consumed only by parseDropPayload() below. Each matcher receives
// { url, urlObj, html } (urlObj is a parsed http(s) URL, or null when the
// candidate string isn't one) and returns a result object or null. Tried
// in order; first non-null match wins. Appending a new source (a future
// provider) is a single new entry here — nothing else in this file needs
// to change.
const GRAMMAR_TABLE = [
  { name: 'commons', match: matchCommons },
  { name: 'youtube', match: matchYoutube },
  { name: 'maps-short', match: matchMapsShort },
  { name: 'maps', match: matchMaps },
];

// ---- Fallbacks (FR-DND.6) -------------------------------------------------

function buildLinkResult(url, urlObj) {
  const tag = `[${urlObj.hostname}](${url})`;
  return { kind: 'link', tag, chipLabel: `Link · ${urlObj.hostname}` };
}

/**
 * Classifies a drop/paste payload per FR-DND.2–FR-DND.7. Pure function:
 * no DOM, no network. `uriList`/`text`/`html` mirror the dataTransfer
 * flavors `text/uri-list`, `text/plain`, and `text/html` respectively.
 */
export function parseDropPayload({ uriList, text, html } = {}) {
  const candidate = pickCandidate(uriList, text);
  const urlObj = tryParseUrl(candidate);
  const ctx = { url: candidate, urlObj, html };

  for (const matcher of GRAMMAR_TABLE) {
    const result = matcher.match(ctx);
    if (result) return result;
  }

  if (urlObj) return buildLinkResult(candidate, urlObj);

  return { kind: 'unknown' };
}
