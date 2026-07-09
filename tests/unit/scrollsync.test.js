// Unit tests for editor/scrollsync.js — the pure anchor-interpolation core
// of split-view scroll sync (headings + viewer ids → piecewise-linear map).
import { describe, it, assert } from './runner.js';
import {
  normalizeHeadingText, extractSourceAnchors, buildScrollMap,
  sourceToPreview, previewToSource,
} from '../../editor/scrollsync.js';

describe('scrollsync: normalizeHeadingText', () => {
  it('strips markdown constructs and case, keeps unicode words', () => {
    assert.equal(normalizeHeadingText('The **Büttes** of [Utah](Q829) `now`'),
      'the büttes of utah now');
    assert.equal(normalizeHeadingText('Fly-to on a map {#custom-id}'),
      normalizeHeadingText('Fly-to on a map'));
  });
});

describe('scrollsync: extractSourceAnchors', () => {
  const DOC = [
    '---', 'title: T', '---',            // 1-3 front matter
    '', '# First',                        // 5
    'prose', '',
    '{% include embed/image.html id="v1" src="x.jpg" %}',  // 8
    '', '## Second', '',                  // 10
    '```', '# not a heading', '```',      // fenced
    '## Second', '',                      // 15 duplicate text
  ].join('\n');
  it('finds headings (occurrence-keyed) and viewer ids; skips front matter and fences', () => {
    const a = extractSourceAnchors(DOC);
    assert.deepEqual(a, [
      { line: 5, key: 'h:1:first' },
      { line: 8, key: 'v:v1' },
      { line: 10, key: 'h:1:second' },
      { line: 15, key: 'h:2:second' },
    ]);
  });
});

describe('scrollsync: buildScrollMap + interpolation', () => {
  it('intersects in order, keeps monotonic pairs, interpolates both ways', () => {
    const src = [
      { line: 5, key: 'h:1:a' },
      { line: 10, key: 'v:x' },
      { line: 20, key: 'h:1:z-unmatched' },
      { line: 30, key: 'h:1:b' },
    ];
    const pv = [
      { key: 'h:1:a', top: 100 },
      { key: 'v:x', top: 500 },
      { key: 'h:1:b', top: 900 },
    ];
    const map = buildScrollMap(src, pv, 40, 1200);
    assert.deepEqual(map, [
      { srcLine: 1, pvTop: 0 },
      { srcLine: 5, pvTop: 100 },
      { srcLine: 10, pvTop: 500 },
      { srcLine: 30, pvTop: 900 },
      { srcLine: 40, pvTop: 1200 },
    ]);
    assert.equal(sourceToPreview(map, 5), 100, 'exact at anchor');
    assert.equal(sourceToPreview(map, 7.5), 300, 'midpoint interpolates');
    assert.equal(previewToSource(map, 500), 10, 'inverse exact');
    assert.equal(previewToSource(map, 700), 20, 'inverse midpoint');
    assert.equal(sourceToPreview(map, 0), 0, 'clamps below');
    assert.equal(sourceToPreview(map, 99), 1200, 'clamps above');
  });

  it('drops non-monotonic matches and degrades to endpoints-only when nothing matches', () => {
    const src = [{ line: 5, key: 'h:1:a' }, { line: 9, key: 'h:1:b' }];
    const pvOutOfOrder = [{ key: 'h:1:a', top: 800 }, { key: 'h:1:b', top: 100 }];
    const m1 = buildScrollMap(src, pvOutOfOrder, 20, 1000);
    assert.equal(m1.length, 3, 'second (regressing) pair dropped');
    const m2 = buildScrollMap(src, [], 20, 1000);
    assert.deepEqual(m2, [{ srcLine: 1, pvTop: 0 }, { srcLine: 20, pvTop: 1000 }],
      'no anchors → proportional whole-document map');
    assert.equal(sourceToPreview(m2, 10.5), 500, 'proportional midpoint');
  });
});
