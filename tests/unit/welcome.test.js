// The first-run welcome document must stay AUDIT-CLEAN: it is many authors'
// first impression, and a sample that flags its own examples teaches distrust.
import { describe, it, assert } from './runner.js';
import { WELCOME_TITLE, WELCOME_CONTENT } from '../../editor/welcome.js';
import { computeDiagnostics } from '../../editor/lang-storykit.js';
import { catalog } from '../../editor/viewer-catalog.js';

describe('welcome document', () => {
  it('is audit-clean (tags, action links, front matter)', () => {
    const diags = computeDiagnostics(WELCOME_CONTENT, { catalog });
    assert.deepEqual(diags.map((d) => `${d.severity}: ${d.message}`), []);
  });
  it('demonstrates the core constructs', () => {
    for (const marker of ['embed/image.html', 'embed/map.html', 'zoomto/pct:',
                          'flyto/', '](Q', '[^1]', 'wc:']) {
      assert.ok(WELCOME_CONTENT.includes(marker), `missing ${marker}`);
    }
    assert.equal(WELCOME_TITLE, 'Welcome to StoryKit');
  });
});
