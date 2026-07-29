/**
 * editor/spellcheck.js — region-aware spell checking ("option 2").
 *
 * WHY NOT native browser spellcheck: browsers only evaluate text the user
 * TYPES, and their squiggles live on text nodes that CodeMirror constantly
 * replaces (syntax highlighting, StoryKit decorations, lint passes) — in
 * this editor they appeared erratically and vanished on redraws. Here the
 * findings are CM lint diagnostics: WE own them, they survive every redraw,
 * they carry suggestion/add-to-dictionary actions, and they feed the Audit.
 *
 * ENGINE: nspell (Hunspell-compatible) + dictionary-en, both pinned. The
 * dictionary (~1.2 MB aff+dic) is fetched once and kept in the Cache API
 * (`storykit-spell-v1`) — no store schema change, survives sessions. Until
 * the engine is ready (or if the fetch fails offline) the lint source
 * returns no diagnostics; loading is retried on the next lint pass.
 *
 * REGION AWARENESS — only prose is checked. Masked out:
 *   front matter · Liquid tags ({% … %}, {{ … }}) · fenced + inline code ·
 *   link/image destinations `](…)` · autolinks/raw URLs · HTML tags ·
 *   kramdown IALs · footnote labels ([^1])
 * Token heuristics additionally skip: words <3 letters, ALL-CAPS,
 *   mixed-case identifiers (CamelCase), words containing digits.
 *
 * PERSONAL DICTIONARY: `prefs.spellWords` (app-owned, injected via deps) —
 * the "Add to dictionary" lint action appends and re-lints. Sentence-initial
 * capitalization is handled by retrying the lowercase form before flagging.
 *
 * ── SUGGESTION COST (why this file has a cache and a viewport window) ───────
 * Measured against dictionary-en@4.0.0 in the deployed editor:
 *     engine.correct(word)   ~0.002 ms   (and memoized by `okCache`)
 *     engine.suggest(word)   ~61 ms      (edit-distance search of the dictionary)
 * suggest() is ~30,000x the cost of correct(), and this lint source used to
 * call it EAGERLY for every unknown word on EVERY pass. A real essay carries
 * ~113 unknown words (proper nouns, place names, jargon), so each edit burned
 * ~5.4 s of SYNCHRONOUS main-thread time — profiled as a single long task,
 * which also delayed the split-view preview (its debounce timer could not
 * fire behind the block) and read to authors as "the preview lags".
 *
 * Two independent fixes, both here:
 *   1. Memoize suggestions per word (`suggestCache`) — the same unknown words
 *      recur on every pass, so passes after the first cost ~0.
 *   2. Only compute suggestions for hits near the rendered viewport — the only
 *      ones whose tooltip the author can open right now. This also spares the
 *      FIRST pass (and document open, which pays the same price).
 * Because scrolling does not re-run lint sources, the linter's `needsRefresh`
 * hook asks for another pass once the viewport settles outside the window the
 * last pass covered — so a word scrolled to still gets its suggestions.
 *
 * TEST SEAMS: `_deps.loadEngine` (tests inject a fake nspell) and
 * `DICTIONARY_URLS` (e2e routes serve a committed mini dictionary fixture).
 */

import { linter } from '@codemirror/lint';

export const DICTIONARY_URLS = {
  aff: 'https://cdn.jsdelivr.net/npm/dictionary-en@4.0.0/index.aff',
  dic: 'https://cdn.jsdelivr.net/npm/dictionary-en@4.0.0/index.dic',
};

const CACHE_NAME = 'storykit-spell-v1';

async function fetchCached(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return await hit.text();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await cache.put(url, resp.clone());
    return await resp.text();
  } catch {
    // Cache API unavailable (rare) — plain fetch, no persistence.
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  }
}

async function defaultLoadEngine() {
  const [{ default: nspell }, aff, dic] = await Promise.all([
    import('nspell'),
    fetchCached(DICTIONARY_URLS.aff),
    fetchCached(DICTIONARY_URLS.dic),
  ]);
  return nspell(aff, dic);
}

/** Test seam (mirrors sync.js's `_deps` convention). */
export const _deps = { loadEngine: defaultLoadEngine };

// ── Region masking ───────────────────────────────────────────────────────────

/** Return [from, to) ranges of NON-prose text to exclude from checking. */
export function maskedRanges(text) {
  const ranges = [];
  const push = (a, b) => { if (b > a) ranges.push([a, b]); };

  // front matter
  if (text.startsWith('---')) {
    const close = /\n---[ \t]*(\n|$)/.exec(text.slice(3));
    if (close) push(0, 3 + close.index + close[0].length);
  }
  const patterns = [
    /\{%[\s\S]*?%\}/g,               // liquid tags (incl. multi-line)
    /\{\{[\s\S]*?\}\}/g,             // liquid output
    /\{:[^}\n]*\}/g,                 // kramdown IAL
    /<[^>\n]+>/g,                    // HTML tags / autolinks
    /`[^`\n]*`/g,                    // inline code
    /\]\([^)\n]*\)?/g,               // link/image destinations
    /https?:\/\/\S+/g,               // raw URLs
    /\[\^[^\]\n]*\]/g,               // footnote labels
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) push(m.index, m.index + m[0].length);
  }
  // fenced code blocks
  const fence = /^(```|~~~).*$/gm;
  let open = null, m;
  while ((m = fence.exec(text)) !== null) {
    if (open === null) open = m.index;
    else { push(open, m.index + m[0].length); open = null; }
  }
  if (open !== null) push(open, text.length);
  return ranges;
}

const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ']*/g;

/** Heuristic skips that would otherwise flood authors with false positives. */
function skippable(word) {
  if (word.length < 3) return true;
  if (word === word.toUpperCase()) return true;               // acronyms
  if (/[A-Z]/.test(word.slice(1))) return true;               // CamelCase / ids
  return false;
}

/**
 * Check `text`, returning CM diagnostics. `engine` is an nspell instance;
 * `known` a Set of personal-dictionary words (lowercased); `okCache` a Set
 * used to memoize engine hits across passes (grows per session).
 */
export function checkText(text, engine, known, okCache) {
  // maskedRanges emits one pass per pattern, so ranges arrive unsorted and may
  // overlap or nest. Words, however, are scanned left to right — so sorting
  // once lets a pointer walk replace what was a full linear scan of every
  // range per word (profiled as the top JS cost of a lint pass on a 66 KB
  // document, where the range count runs into the hundreds).
  //
  // `maxEnd` is the largest end among ranges that have started at or before
  // `p`; if it is past `p`, some range covers `p`. That stays correct with
  // overlapping and nested ranges, which a start-sorted scan alone would not.
  // Relies on `p` never going backwards across calls — true for WORD_RE.
  const masked = maskedRanges(text).sort((x, y) => x[0] - y[0]);
  let nextRange = 0;
  let maxEnd = 0;
  const inMasked = (p) => {
    while (nextRange < masked.length && masked[nextRange][0] <= p) {
      if (masked[nextRange][1] > maxEnd) maxEnd = masked[nextRange][1];
      nextRange += 1;
    }
    return p < maxEnd;
  };
  const out = [];
  let m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text)) !== null) {
    const word = m[0].replace(/^'+|'+$/g, '');
    if (!word || skippable(word)) continue;
    if (inMasked(m.index)) continue;
    const lower = word.toLowerCase();
    if (known.has(lower) || okCache.has(word)) continue;
    if (engine.correct(word) || (word[0] === word[0].toUpperCase() && engine.correct(lower))) {
      okCache.add(word);
      continue;
    }
    out.push({ from: m.index, to: m.index + word.length, word });
  }
  return out;
}

// ── CM lint source ───────────────────────────────────────────────────────────

/**
 * @param {{
 *   getPersonalWords: () => string[],
 *   addPersonalWord: (word: string) => void,
 *   isEnabled: () => boolean,
 *   onCount?: (n: number) => void,
 * }} opts
 */
let engine = null;
let loading = null;
const okCache = new Set();

function ensureEngine() {
  if (engine || loading) return;
  loading = _deps.loadEngine().then(
    (e) => { engine = e; loading = null; },
    () => { loading = null; /* offline — retried on a later pass */ },
  );
}

// ── Suggestions: memoized, and only for hits near the viewport ──────────────
// (see the file header for the measurements that motivate both.)

/** word → its top suggestions. Session-lived; unknown words recur every pass. */
const suggestCache = new Map();

const MAX_SUGGESTIONS = 3;

/** Characters either side of the rendered viewport that still get suggestions. */
export const SUGGEST_MARGIN = 2000;

/**
 * Top suggestions for `word`, computed at most once per session per word.
 * @param {string} word
 * @param {{ suggest: (w: string) => string[] }} eng
 * @returns {string[]}
 */
export function suggestionsFor(word, eng) {
  let hit = suggestCache.get(word);
  if (!hit) {
    hit = eng.suggest(word).slice(0, MAX_SUGGESTIONS);
    suggestCache.set(word, hit);
  }
  return hit;
}

/**
 * Is a hit at `pos` close enough to what's on screen to be worth the ~61 ms?
 * A null viewport (non-view callers) means "yes" — no window to gate on.
 * @param {number} pos
 * @param {{ from: number, to: number }|null} viewport
 */
export function shouldSuggestAt(pos, viewport) {
  if (!viewport) return true;
  return pos >= viewport.from - SUGGEST_MARGIN && pos <= viewport.to + SUGGEST_MARGIN;
}

/** Test seam: reset module state between unit tests. */
export function _resetForTests() {
  engine = null;
  loading = null;
  okCache.clear();
  suggestCache.clear();
}

export function spellcheckExtension(opts) {
  // The document range the last pass computed suggestions for. Doubles as the
  // termination guard for `needsRefresh` below.
  let suggestedWindow = null;

  return linter(
    (view) => {
      if (!opts.isEnabled()) { opts.onCount?.(0); return []; }
      if (!engine) { ensureEngine(); return []; }
      const text = view.state.doc.toString();
      const known = new Set((opts.getPersonalWords() || []).map((w) => w.toLowerCase()));
      const hits = checkText(text, engine, known, okCache);
      opts.onCount?.(hits.length);

      const viewport = view.viewport;
      suggestedWindow = viewport
        ? { from: viewport.from - SUGGEST_MARGIN, to: viewport.to + SUGGEST_MARGIN }
        : null;

      return hits.map((h) => ({
        from: h.from,
        to: h.to,
        severity: 'warning',
        source: 'spelling',
        message: `Unknown word "${h.word}".`,
        actions: [
          // Off-screen hits are still flagged — they just skip the expensive
          // suggest() until the author scrolls them into view.
          ...(shouldSuggestAt(h.from, viewport)
            ? suggestionsFor(h.word, engine).map((sug) => ({
              name: sug,
              apply(v, from, to) { v.dispatch({ changes: { from, to, insert: sug } }); },
            }))
            : []),
          {
            name: 'Add to dictionary',
            apply(v) {
              opts.addPersonalWord(h.word);
              // re-run lint promptly: a no-op reconfigure isn't needed —
              // dispatching an empty transaction retriggers the debounce.
              v.dispatch({});
            },
          },
        ],
      }));
    },
    {
      delay: 600,
      // Scrolling alone never re-runs a lint source, so a diagnostic produced
      // while it was off-window would keep an empty suggestion list once the
      // author scrolled to it. `needsRefresh` is CM's hook for exactly this —
      // results that depend on something other than the document. (NOT
      // `forceLinting`: its `force()` no-ops unless the plugin already has a
      // pass pending, which after a settled lint it never does.)
      //
      // Self-terminating: the refreshed pass moves `suggestedWindow` onto the
      // new viewport, so the containment test then reports "no refresh needed".
      needsRefresh: (update) => {
        if (!update.viewportChanged || update.docChanged) return false;
        const vp = update.view.viewport;
        return !(suggestedWindow
          && vp.from >= suggestedWindow.from
          && vp.to <= suggestedWindow.to);
      },
    },
  );
}

/** Whole-document spelling report for the Audit dialog. Returns null while
 *  the engine is still loading (caller reports "warming up"). */
export function auditSpelling(text, getPersonalWords) {
  if (!engine) { ensureEngine(); return null; }
  const known = new Set((getPersonalWords() || []).map((w) => w.toLowerCase()));
  return checkText(text, engine, known, okCache);
}
