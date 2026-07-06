// tests/unit/sample-pass.test.js
//
// Seed test proving the harness works end-to-end (registration, async
// tests, all assert.* variants). Always green — see selftest-fail.test.js
// for the deliberate-failure counterpart used to verify exit code 1.
import { describe, it, assert } from './runner.js';

describe('sample-pass (harness smoke test)', () => {
  it('adds numbers', () => {
    assert.equal(1 + 1, 2);
  });

  it('deep-equals objects regardless of key order', () => {
    assert.deepEqual({ a: 1, b: [1, 2, 3] }, { b: [1, 2, 3], a: 1 });
  });

  it('supports async tests', async () => {
    const value = await Promise.resolve(42);
    assert.equal(value, 42);
  });

  it('assert.ok treats truthy values as passing', () => {
    assert.ok('non-empty string');
    assert.ok(1);
  });

  it('assert.throws catches synchronous errors', () => {
    assert.throws(() => {
      throw new Error('boom');
    }, /boom/);
  });

  it('assert.rejects catches asynchronous errors', async () => {
    await assert.rejects(async () => {
      throw new Error('async boom');
    }, /async boom/);
  });
});
