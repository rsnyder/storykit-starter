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
  const masked = maskedRanges(text);
  const inMasked = (p) => masked.some(([a, b]) => p >= a && p < b);
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

/** Test seam: reset module state between unit tests. */
export function _resetForTests() { engine = null; loading = null; okCache.clear(); }

export function spellcheckExtension(opts) {
  return linter(
    (view) => {
      if (!opts.isEnabled()) { opts.onCount?.(0); return []; }
      if (!engine) { ensureEngine(); return []; }
      const text = view.state.doc.toString();
      const known = new Set((opts.getPersonalWords() || []).map((w) => w.toLowerCase()));
      const hits = checkText(text, engine, known, okCache);
      opts.onCount?.(hits.length);
      return hits.map((h) => ({
        from: h.from,
        to: h.to,
        severity: 'warning',
        source: 'spelling',
        message: `Unknown word "${h.word}".`,
        actions: [
          ...engine.suggest(h.word).slice(0, 3).map((sug) => ({
            name: sug,
            apply(v, from, to) { v.dispatch({ changes: { from, to, insert: sug } }); },
          })),
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
    { delay: 600 },
  );
}

/** Whole-document spelling report for the Audit dialog. Returns null while
 *  the engine is still loading (caller reports "warming up"). */
export function auditSpelling(text, getPersonalWords) {
  if (!engine) { ensureEngine(); return null; }
  const known = new Set((getPersonalWords() || []).map((w) => w.toLowerCase()));
  return checkText(text, engine, known, okCache);
}
