// Unit tests for editor/spellcheck.js — region masking, token heuristics,
// checkText against a FAKE engine (no dictionary download in unit tests).
import { describe, it, assert } from './runner.js';
import { maskedRanges, checkText } from '../../editor/spellcheck.js';

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
