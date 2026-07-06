// tests/unit/runner.js
//
// Tiny buildless test framework for StoryKit editor unit tests.
// No build step, no npm — loaded directly as an ES module by
// tests/unit/index.html. See docs/editor-plan.md §2 / WP-0.1.
//
// Public API (all globals attached to `window` so plain <script type="module">
// test files can call them without an import, AND exported for modules that
// prefer `import { describe, it, assert } from './runner.js'`):
//
//   describe(name, fn)                 — group tests; fn must be synchronous
//                                         (registration only)
//   it(name, fn, { timeout } = {})     — a single test; fn may be async
//   assert.ok(value, message?)
//   assert.equal(actual, expected, message?)       — ===
//   assert.deepEqual(actual, expected, message?)   — structural, via
//                                                     JSON-stable recursive compare
//   assert.throws(fn, matcher?, message?)          — sync fn must throw
//   assert.rejects(asyncFnOrPromise, matcher?, message?) — must reject
//
// After all registered tests run, results are:
//   - rendered into the DOM (#test-results, created if absent)
//   - exposed as window.__testResults = {
//       done: true, passed, failed,
//       failures: [{ suite, name, error }],
//     }
//
// Suites run in registration order; tests within a suite run in registration
// order. Each test gets its own timeout (default 5000 ms). A thrown/rejected
// error, or a timeout, counts as a failure — the runner never throws out of
// run().

const DEFAULT_TIMEOUT = 5000;

/** @type {{ suiteName: string, name: string, fn: Function, timeout: number }[]} */
const registry = [];

/** @type {string[]} */
const suiteStack = [];

export function describe(name, fn) {
  suiteStack.push(name);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // describe() callbacks are expected to be synchronous (registration
      // only); warn loudly rather than silently dropping async registration.
      throw new Error(
        `describe("${name}") callback returned a Promise — describe() bodies must be synchronous; put async work inside it()`
      );
    }
  } finally {
    suiteStack.pop();
  }
}

export function it(name, fn, options = {}) {
  const suiteName = suiteStack[suiteStack.length - 1] ?? '(no suite)';
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  registry.push({ suiteName, name, fn, timeout });
}

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function stableStringify(value) {
  const seen = new WeakSet();
  const sort = (v) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.map(sort);
      if (v instanceof Map) return { __type: 'Map', entries: [...v.entries()].map(sort) };
      if (v instanceof Set) return { __type: 'Set', values: [...v.values()].map(sort) };
      return Object.keys(v)
        .sort()
        .reduce((acc, k) => {
          acc[k] = sort(v[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return stableStringify(a) === stableStringify(b);
}

function fmt(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const assert = {
  ok(value, message) {
    if (!value) {
      throw new AssertionError(message || `expected truthy value, got ${fmt(value)}`);
    }
  },

  equal(actual, expected, message) {
    if (!Object.is(actual, expected)) {
      throw new AssertionError(
        message || `expected ${fmt(actual)} to equal (===) ${fmt(expected)}`
      );
    }
  },

  deepEqual(actual, expected, message) {
    if (!deepEqual(actual, expected)) {
      throw new AssertionError(
        message ||
          `expected ${fmt(actual)} to deeply equal ${fmt(expected)}`
      );
    }
  },

  throws(fn, matcher, message) {
    let threw = false;
    let caught;
    try {
      fn();
    } catch (err) {
      threw = true;
      caught = err;
    }
    if (!threw) {
      throw new AssertionError(message || 'expected function to throw, but it did not');
    }
    checkMatcher(caught, matcher, message);
  },

  async rejects(fnOrPromise, matcher, message) {
    let rejected = false;
    let caught;
    try {
      const promise = typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise;
      await promise;
    } catch (err) {
      rejected = true;
      caught = err;
    }
    if (!rejected) {
      throw new AssertionError(message || 'expected promise/function to reject, but it did not');
    }
    checkMatcher(caught, matcher, message);
  },
};

function checkMatcher(error, matcher, message) {
  if (matcher == null) return;
  if (matcher instanceof RegExp) {
    const text = error && error.message ? error.message : String(error);
    if (!matcher.test(text)) {
      throw new AssertionError(
        message || `expected error message ${fmt(text)} to match ${matcher}`
      );
    }
    return;
  }
  if (typeof matcher === 'function') {
    if (!(error instanceof matcher)) {
      throw new AssertionError(
        message || `expected error to be instance of ${matcher.name}, got ${error}`
      );
    }
    return;
  }
  if (typeof matcher === 'string') {
    const text = error && error.message ? error.message : String(error);
    if (!text.includes(matcher)) {
      throw new AssertionError(
        message || `expected error message ${fmt(text)} to include ${fmt(matcher)}`
      );
    }
  }
}

function withTimeout(fn, timeout, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timed out after ${timeout}ms: ${label}`));
    }, timeout);

    Promise.resolve()
      .then(() => fn())
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

function renderResults({ passed, failed, failures, total }) {
  let root = document.getElementById('test-results');
  if (!root) {
    root = document.createElement('div');
    root.id = 'test-results';
    document.body.appendChild(root);
  }
  root.innerHTML = '';

  const summary = document.createElement('h1');
  summary.id = 'test-summary';
  summary.textContent = `${passed}/${total} passed, ${failed} failed`;
  summary.style.color = failed > 0 ? '#b00020' : '#0a7d2c';
  root.appendChild(summary);

  if (failures.length) {
    const list = document.createElement('ul');
    list.id = 'test-failures';
    for (const f of failures) {
      const li = document.createElement('li');
      li.className = 'test-failure';
      const stack = f.error && f.error.stack ? f.error.stack : String(f.error);
      li.innerHTML = `<strong>${escapeHtml(f.suite)} &rsaquo; ${escapeHtml(f.name)}</strong><pre>${escapeHtml(
        stack
      )}</pre>`;
      list.appendChild(li);
    }
    root.appendChild(list);
  }

  const style = document.createElement('style');
  style.textContent = `
    #test-results { font: 14px/1.4 -apple-system, system-ui, sans-serif; padding: 16px; }
    #test-summary { font-size: 18px; margin: 0 0 12px; }
    #test-failures { list-style: none; margin: 0; padding: 0; }
    .test-failure { background: #fff3f3; border: 1px solid #f0c2c2; border-radius: 6px;
                    padding: 8px 12px; margin-bottom: 8px; }
    .test-failure pre { white-space: pre-wrap; margin: 4px 0 0; font-size: 12px; }
  `;
  if (!document.getElementById('test-results-style')) {
    style.id = 'test-results-style';
    document.head.appendChild(style);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/**
 * Runs every test registered via it() (across all describe() blocks that
 * have executed by the time this is called), then renders + exposes results.
 * Safe to call once per page load.
 */
export async function run() {
  const failures = [];
  let passed = 0;

  for (const test of registry) {
    try {
      await withTimeout(test.fn, test.timeout, `${test.suiteName} > ${test.name}`);
      passed += 1;
    } catch (error) {
      failures.push({ suite: test.suiteName, name: test.name, error });
    }
  }

  const result = {
    done: true,
    passed,
    failed: failures.length,
    total: registry.length,
    failures: failures.map((f) => ({
      suite: f.suite,
      name: f.name,
      error: f.error && f.error.message ? f.error.message : String(f.error),
    })),
  };

  window.__testResults = result;
  renderResults({ passed, failed: failures.length, failures, total: registry.length });
  return result;
}

// Also attach to window so test files can be plain <script type="module">
// tags that don't bother importing (index.html imports runner.js first,
// which runs before the per-file <script type="module"> imports execute —
// see index.html for the load order contract).
window.describe = describe;
window.it = it;
window.assert = assert;
