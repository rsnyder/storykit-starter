// Unit tests for editor/spellcheck.js — region masking, token heuristics,
// checkText against a FAKE engine (no dictionary download in unit tests).
import { describe, it, assert } from './runner.js';
import {
  maskedRanges,
  checkText,
  suggestionsFor,
  shouldSuggestAt,
  SUGGEST_MARGIN,
  _resetForTests,
} from '../../editor/spellcheck.js';

const GOOD = new Set(['the', 'quick', 'brown', 'fox', 'valley', 'monument',
  'a', 'story', 'about', 'this', 'word', 'is', 'fine', 'teh'.split('').join('')]);
const fakeEngine = {
  correct: (w) => GOOD.has(w.toLowerCase()),
  suggest: () => ['the'],
};
const check = (text, known = []) =>
  checkText(text, fakeEngine, new Set(known.map((w) => w.toLowerCase())), new Set());

describe('spellcheck: region masking', () => {
  it('masks front matter, tags, code, links, URLs, IALs, footnotes', () => {
    const doc = [
      '---', 'title: Mispeledword', '---', '',
      '{% include embed/image.html src="mispeledtag.jpg" %}', '',
      'Prose with `mispeledcode` and [text](mispeledurl.html) plus', 
      'https://mispeled.example.com and {:.mispeledial} and [^mispeledfoot]', '',
      '```', 'mispeledfence', '```', '',
    ].join('\n');
    const ranges = maskedRanges(doc);
    for (const bad of ['Mispeledword', 'mispeledtag', 'mispeledcode', 'mispeledurl',
                       'mispeled.example', 'mispeledial', 'mispeledfoot', 'mispeledfence']) {
      const idx = doc.indexOf(bad);
      assert.ok(ranges.some(([a, b]) => idx >= a && idx < b), `${bad} should be masked`);
    }
  });
});

describe('spellcheck: checkText', () => {
  it('flags misspelled prose words with positions', () => {
    const hits = check('The quick brwn fox');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].word, 'brwn');
    assert.equal('The quick brwn fox'.slice(hits[0].from, hits[0].to), 'brwn');
  });
  it('skips masked regions, acronyms, CamelCase, and short words', () => {
    const hits = check('NASA StoryKit xz `brwn` {% brwn %} ok the');
    assert.deepEqual(hits.map((h) => h.word), ['ok'].filter(() => false).concat(
      hits.map((h) => h.word)));  // introspect below
    // Only 'ok' is <3 chars (skipped); everything else masked/heuristic-skipped.
    assert.deepEqual(hits, []);
  });
  it('accepts sentence-initial capitalization of known words', () => {
    assert.deepEqual(check('Quick fox. Valley story.'), []);
  });
  it('honors the personal dictionary case-insensitively', () => {
    assert.equal(check('Zoomable viewers').length, 2);
    assert.deepEqual(check('Zoomable viewers', ['zoomable', 'Viewers']), []);
  });
});

// nspell's suggest() measured ~61 ms per word against dictionary-en, versus
// ~0.002 ms for correct(). Calling it once per unknown word per lint pass cost
// ~5.4 s on a real 113-unknown-word essay and blocked the preview behind it.
describe('spellcheck: suggestion cost controls', () => {
  it('computes suggestions at most once per word, capped at 3', () => {
    _resetForTests();
    let calls = 0;
    const eng = {
      suggest: (w) => { calls += 1; return [`${w}-a`, `${w}-b`, `${w}-c`, `${w}-d`]; },
    };
    assert.deepEqual(suggestionsFor('brwn', eng), ['brwn-a', 'brwn-b', 'brwn-c'],
      'capped at 3 suggestions');
    assert.equal(calls, 1);

    // Same word again — the whole point: unknown words recur on every pass.
    assert.deepEqual(suggestionsFor('brwn', eng), ['brwn-a', 'brwn-b', 'brwn-c']);
    assert.equal(calls, 1, 'second lookup served from the cache');

    suggestionsFor('teh', eng);
    assert.equal(calls, 2, 'a new word does reach the engine');

    _resetForTests();
    suggestionsFor('brwn', eng);
    assert.equal(calls, 3, 'reset clears the cache');
  });

  // checkText's masking uses a pointer walk over start-sorted ranges rather
  // than scanning every range per word. Overlapping/nested ranges are the case
  // a naive sorted scan gets wrong, so pin them.
  it('masks correctly when ranges overlap and nest', () => {
    // A raw URL inside a link destination, and a URL inside a Liquid tag:
    // patterns whose ranges overlap and nest, emitted out of pattern order.
    // Prose words are all in the fake dictionary so only `brwn` should flag.
    const doc = 'This is fine {% include x.html src="https://ex.com/mispeledone" %} '
              + 'the story [word](https://ex.com/mispeledtwo) about `mispeledthree` '
              + 'a fox brwn';
    const hits = check(doc);
    assert.deepEqual(hits.map((h) => h.word), ['brwn'],
      'only the unmasked misspelling survives');
    // A word after a long masked run must not stay masked by a stale maxEnd.
    assert.equal(doc.slice(hits[0].from, hits[0].to), 'brwn');
  });

  it('gates suggestions on the viewport, with a margin either side', () => {
    const vp = { from: 10_000, to: 12_000 };
    assert.equal(shouldSuggestAt(11_000, vp), true, 'inside the viewport');
    assert.equal(shouldSuggestAt(10_000 - SUGGEST_MARGIN, vp), true, 'on the leading edge');
    assert.equal(shouldSuggestAt(12_000 + SUGGEST_MARGIN, vp), true, 'on the trailing edge');
    assert.equal(shouldSuggestAt(10_000 - SUGGEST_MARGIN - 1, vp), false, 'just before the window');
    assert.equal(shouldSuggestAt(12_000 + SUGGEST_MARGIN + 1, vp), false, 'just after the window');
    assert.equal(shouldSuggestAt(0, null), true, 'no viewport → no gating');
  });
});
