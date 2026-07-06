// tests/unit/selftest-fail.test.js
//
// Deliberately-failing test, NOT part of the normal test manifest in
// index.html. Loaded only when the page is opened with ?selftest=fail
// (see the loader script in index.html), so the harness itself — and
// tools/run_browser_tests.py's exit-code behavior — can be verified
// on demand without a permanently-red test polluting the seed suite.
//
// Run it directly with:
//   python3 tools/run_browser_tests.py --selftest-fail
// (see tools/run_browser_tests.py --help)
import { describe, it, assert } from './runner.js';

describe('selftest (deliberately failing; only loaded via ?selftest=fail)', () => {
  it('fails on purpose to prove failure detection works', () => {
    assert.equal(1, 2, 'deliberate failure — if you see this, the harness correctly detected it');
  });
});
