// tests/unit/url-grammars.test.js  (WP-0.3)
//
// Unit tests for editor/url-grammars.js — the drop/paste URL grammar
// table per docs/editor-spec.md FR-DND.2/3/4/6 and FR-DND.7. Pure-module
// tests: every case is a synthetic dataTransfer-flavor payload in, a
// classified result out.
import { describe, it, assert } from './runner.js';
import { parseDropPayload } from '../../editor/url-grammars.js';

describe('url-grammars: Wikimedia Commons (FR-DND.2)', () => {
  it('recognizes a File: page URL', () => {
    const r = parseDropPayload({
      uriList: 'https://commons.wikimedia.org/wiki/File:Westgate_Towers_c1905.jpg',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Westgate_Towers_c1905.jpg" %}');
    assert.equal(r.chipLabel, 'Image viewer · wc:Westgate_Towers_c1905.jpg');
  });

  it('URL-decodes and underscores a File: page URL with encoded spaces', () => {
    const r = parseDropPayload({
      uriList: 'https://commons.wikimedia.org/wiki/File:Westgate%20Towers%20c1905.jpg',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Westgate_Towers_c1905.jpg" %}');
  });

  it('keeps commas in a File: name (Monument Valley)', () => {
    const r = parseDropPayload({
      uriList: 'https://commons.wikimedia.org/wiki/File:Monument_Valley,_Utah,_USA.jpg',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Monument_Valley,_Utah,_USA.jpg" %}');
    assert.equal(r.chipLabel, 'Image viewer · wc:Monument_Valley,_Utah,_USA.jpg');
  });

  it('recognizes a Special:FilePath URL', () => {
    const r = parseDropPayload({
      uriList: 'https://commons.wikimedia.org/wiki/Special:FilePath/Monument_Valley,_Utah,_USA.jpg',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Monument_Valley,_Utah,_USA.jpg" %}');
  });

  it('strips a redundant File: prefix inside Special:FilePath', () => {
    const r = parseDropPayload({
      uriList: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Example_image.png',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Example_image.png" %}');
  });

  it('recognizes a direct upload.wikimedia.org URL', () => {
    const r = parseDropPayload({
      uriList: 'https://upload.wikimedia.org/wikipedia/commons/3/3d/Westgate_Towers_c1905.jpg',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Westgate_Towers_c1905.jpg" %}');
  });

  it('extracts the original filename from a thumb URL', () => {
    const r = parseDropPayload({
      uriList:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Monument_Valley%2C_Utah%2C_USA.jpg/640px-Monument_Valley%2C_Utah%2C_USA.jpg',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Monument_Valley,_Utah,_USA.jpg" %}');
  });

  it('decodes %28/%29 parens in a thumb URL filename', () => {
    const r = parseDropPayload({
      uriList:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Tower_Bridge_%28London%29.jpg/800px-Tower_Bridge_%28London%29.jpg',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Tower_Bridge_(London).jpg" %}');
  });

  it('extracts the image from HTML when the uri-list is a Commons search page', () => {
    const r = parseDropPayload({
      uriList: 'https://commons.wikimedia.org/w/index.php?search=westgate+towers&title=Special:MediaSearch',
      html: '<img alt="thumb" src="https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Westgate_Towers_c1905.jpg/220px-Westgate_Towers_c1905.jpg" class="sd-image">',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Westgate_Towers_c1905.jpg" %}');
  });

  it('handles a protocol-relative img src in dragged Commons HTML', () => {
    const r = parseDropPayload({
      uriList: 'https://commons.wikimedia.org/w/index.php?search=example',
      html: '<img src="//upload.wikimedia.org/wikipedia/commons/1/15/Example_image.png">',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Example_image.png" %}');
  });

  it('falls back to a plain link for a Commons page that names no file', () => {
    const r = parseDropPayload({
      uriList: 'https://commons.wikimedia.org/wiki/Main_Page',
    });
    assert.equal(r.kind, 'link');
    assert.equal(r.tag, '[commons.wikimedia.org](https://commons.wikimedia.org/wiki/Main_Page)');
  });
});

describe('url-grammars: YouTube (FR-DND.3)', () => {
  it('recognizes a watch URL', () => {
    const r = parseDropPayload({ uriList: 'https://www.youtube.com/watch?v=yg0As_HOvJk' });
    assert.equal(r.kind, 'youtube');
    assert.equal(r.tag, '{% include embed/youtube.html vid="yg0As_HOvJk" %}');
    assert.equal(r.chipLabel, 'YouTube viewer · yg0As_HOvJk');
  });

  it('recognizes a youtu.be short URL', () => {
    const r = parseDropPayload({ uriList: 'https://youtu.be/GGyiZ7SE3V4' });
    assert.equal(r.kind, 'youtube');
    assert.equal(r.tag, '{% include embed/youtube.html vid="GGyiZ7SE3V4" %}');
  });

  it('recognizes a shorts URL', () => {
    const r = parseDropPayload({ uriList: 'https://www.youtube.com/shorts/yg0As_HOvJk' });
    assert.equal(r.kind, 'youtube');
    assert.equal(r.tag, '{% include embed/youtube.html vid="yg0As_HOvJk" %}');
  });

  it('recognizes an embed URL with a start= parameter', () => {
    const r = parseDropPayload({ uriList: 'https://www.youtube.com/embed/yg0As_HOvJk?start=90' });
    assert.equal(r.kind, 'youtube');
    assert.equal(r.tag, '{% include embed/youtube.html vid="yg0As_HOvJk" start="90" %}');
  });

  it('maps t=90 to start="90"', () => {
    const r = parseDropPayload({ uriList: 'https://www.youtube.com/watch?v=yg0As_HOvJk&t=90' });
    assert.equal(r.tag, '{% include embed/youtube.html vid="yg0As_HOvJk" start="90" %}');
  });

  it('maps t=90s to start="90"', () => {
    const r = parseDropPayload({ uriList: 'https://youtu.be/yg0As_HOvJk?t=90s' });
    assert.equal(r.tag, '{% include embed/youtube.html vid="yg0As_HOvJk" start="90" %}');
  });

  it('maps t=1m30s to start="90"', () => {
    const r = parseDropPayload({ uriList: 'https://www.youtube.com/watch?v=yg0As_HOvJk&t=1m30s' });
    assert.equal(r.tag, '{% include embed/youtube.html vid="yg0As_HOvJk" start="90" %}');
  });

  it('maps t=1h2m3s to start="3723"', () => {
    const r = parseDropPayload({ uriList: 'https://www.youtube.com/watch?v=yg0As_HOvJk&t=1h2m3s' });
    assert.equal(r.tag, '{% include embed/youtube.html vid="yg0As_HOvJk" start="3723" %}');
  });

  it('omits start when the t= value is unparseable', () => {
    const r = parseDropPayload({ uriList: 'https://www.youtube.com/watch?v=yg0As_HOvJk&t=bogus' });
    assert.equal(r.kind, 'youtube');
    assert.equal(r.tag, '{% include embed/youtube.html vid="yg0As_HOvJk" %}');
  });

  it('rejects a non-11-char video id (falls back to link)', () => {
    const r = parseDropPayload({ uriList: 'https://www.youtube.com/watch?v=tooshort' });
    assert.equal(r.kind, 'link');
  });

  it('falls back to link for a channel URL (no video id)', () => {
    const r = parseDropPayload({ uriList: 'https://www.youtube.com/@SomeChannel' });
    assert.equal(r.kind, 'link');
    assert.equal(r.tag, '[www.youtube.com](https://www.youtube.com/@SomeChannel)');
  });
});

describe('url-grammars: Google Maps (FR-DND.4)', () => {
  it('recognizes /@lat,lng,zoomz', () => {
    const r = parseDropPayload({
      uriList: 'https://www.google.com/maps/@36.9980,-110.0985,12z',
    });
    assert.equal(r.kind, 'maps');
    assert.equal(r.tag, '{% include embed/map.html center="36.9980, -110.0985" zoom="12" %}');
    assert.equal(r.chipLabel, 'Map viewer · 36.9980, -110.0985');
  });

  it('rounds zoom to one decimal', () => {
    const r = parseDropPayload({
      uriList: 'https://www.google.com/maps/@36.9980,-110.0985,12.34z',
    });
    assert.equal(r.tag, '{% include embed/map.html center="36.9980, -110.0985" zoom="12.3" %}');
  });

  it('treats a meters altitude (4406.68m) as zoom-absent', () => {
    const r = parseDropPayload({
      uriList: 'https://www.google.com/maps/@36.9980,-110.0985,4406.68m',
    });
    assert.equal(r.kind, 'maps');
    assert.equal(r.tag, '{% include embed/map.html center="36.9980, -110.0985" %}');
  });

  it('recognizes ?q=lat,lng', () => {
    const r = parseDropPayload({
      uriList: 'https://maps.google.com/?q=37.01056,-110.2425',
    });
    assert.equal(r.kind, 'maps');
    assert.equal(r.tag, '{% include embed/map.html center="37.01056, -110.2425" %}');
  });

  it('extracts a /place/ name as caption (+→space)', () => {
    const r = parseDropPayload({
      uriList: 'https://www.google.com/maps/place/Monument+Valley/@36.9980,-110.0985,12z',
    });
    assert.equal(r.kind, 'maps');
    assert.equal(
      r.tag,
      '{% include embed/map.html center="36.9980, -110.0985" zoom="12" caption="Monument Valley" %}'
    );
    assert.equal(r.chipLabel, 'Map viewer · Monument Valley');
  });

  it('URL-decodes non-ASCII place names', () => {
    const r = parseDropPayload({
      uriList: 'https://www.google.com/maps/place/Caf%C3%A9+de+Flore/@48.8542,2.3326,17z',
    });
    assert.equal(r.kind, 'maps');
    assert.equal(
      r.tag,
      '{% include embed/map.html center="48.8542, 2.3326" zoom="17" caption="Café de Flore" %}'
    );
  });

  it('degrades a maps.app.goo.gl short link to a message, no tag', () => {
    const r = parseDropPayload({ uriList: 'https://maps.app.goo.gl/AbCdEf12345' });
    assert.equal(r.kind, 'maps-short');
    assert.equal(r.tag, undefined);
    assert.ok(r.message && r.message.length > 20, 'expected a helpful message');
    assert.ok(/expanded|address bar|full/i.test(r.message));
  });

  it('falls back to link for a Google URL with no coordinates', () => {
    const r = parseDropPayload({ uriList: 'https://www.google.com/maps' });
    assert.equal(r.kind, 'link');
  });
});

describe('url-grammars: fallbacks and input handling (FR-DND.6/7)', () => {
  it('classifies an arbitrary http(s) URL as a plain Markdown link', () => {
    const r = parseDropPayload({ uriList: 'https://example.org/some/page?x=1' });
    assert.equal(r.kind, 'link');
    assert.equal(r.tag, '[example.org](https://example.org/some/page?x=1)');
    assert.equal(r.chipLabel, 'Link · example.org');
  });

  it('classifies a bare non-URL string as unknown', () => {
    const r = parseDropPayload({ text: 'just some words, no URL here' });
    assert.equal(r.kind, 'unknown');
    assert.equal(r.tag, undefined);
  });

  it('classifies an empty payload as unknown', () => {
    const r = parseDropPayload({});
    assert.equal(r.kind, 'unknown');
  });

  it('classifies a non-http scheme (mailto:) as unknown', () => {
    const r = parseDropPayload({ text: 'mailto:ron@example.com' });
    assert.equal(r.kind, 'unknown');
  });

  it('skips uri-list comment lines and uses the first URL line', () => {
    const r = parseDropPayload({
      uriList: '# dragged from browser\r\nhttps://youtu.be/yg0As_HOvJk\r\n',
    });
    assert.equal(r.kind, 'youtube');
    assert.equal(r.tag, '{% include embed/youtube.html vid="yg0As_HOvJk" %}');
  });

  it('prefers uriList over text when both are present', () => {
    const r = parseDropPayload({
      uriList: 'https://youtu.be/yg0As_HOvJk',
      text: 'https://example.org/ignored',
    });
    assert.equal(r.kind, 'youtube');
  });

  it('falls back to text when uriList is absent (paste path, FR-DND.7)', () => {
    const r = parseDropPayload({
      text: 'https://commons.wikimedia.org/wiki/File:Example_image.png',
    });
    assert.equal(r.kind, 'commons');
    assert.equal(r.tag, '{% include embed/image.html src="wc:Example_image.png" %}');
  });

  it('trims whitespace around a pasted URL', () => {
    const r = parseDropPayload({ text: '  https://youtu.be/yg0As_HOvJk \n' });
    assert.equal(r.kind, 'youtube');
  });
});
