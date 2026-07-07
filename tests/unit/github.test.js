// tests/unit/github.test.js  (WP-3.1)
//
// Unit tests for editor/github.js — the frozen GitHub Contents/Git API
// client (docs/editor-plan.md §1.2, docs/editor-spec.md FR-GH.1/3/4).
// `globalThis.fetch` is stubbed per test (saved/restored so tests never
// leak state to each other or touch the live network — per docs/editor-plan
// §0.5, hermetic tests only). Covers every endpoint's happy path, the full
// status→kind error mapping, the 304/404 getFile special cases, UTF-8-safe
// base64 round-tripping, and the token-never-leaks security invariant.

import { describe, it, assert } from './runner.js';
import * as github from '../../editor/github.js';

const { GitHubError, TOKEN_KEY } = github;

// ── test helpers ────────────────────────────────────────────────────────

/** Minimal Response-alike. `clone()` returns an independent copy so the
 * error-classification path (which reads the body via clone().text()) never
 * disturbs a body a caller still intends to read. */
function fakeResponse({ status, headers = {}, body = '' } = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (lower.has(String(k).toLowerCase()) ? lower.get(String(k).toLowerCase()) : null) },
    async json() { return text ? JSON.parse(text) : null; },
    async text() { return text; },
    clone() { return fakeResponse({ status, headers, body: text }); },
  };
}

/** Runs `fn` with globalThis.fetch replaced by `stub`, always restoring the
 * original afterward (even on throw). `stub` receives (url, opts). */
async function withStubFetch(stub, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return stub(url, opts, calls);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Runs `fn` with a token set, always forgetting it afterward. */
async function withToken(token, fn) {
  const previous = localStorage.getItem(TOKEN_KEY);
  github.setToken(token);
  try {
    await fn();
  } finally {
    if (previous === null) github.forgetToken();
    else localStorage.setItem(TOKEN_KEY, previous);
  }
}

/** Awaits `promise`, asserting it rejects with a GitHubError of the given
 * kind/status, and returns the caught error for further inspection. */
async function expectGitHubError(promise, { kind, status } = {}) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof GitHubError, `expected a GitHubError, got ${caught}`);
  if (kind !== undefined) assert.equal(caught.kind, kind, `expected kind '${kind}', got '${caught.kind}'`);
  if (status !== undefined) assert.equal(caught.status, status, `expected status ${status}, got ${caught.status}`);
  return caught;
}

// UTF-8-safe base64 helpers duplicated here (module's are private) purely to
// let the test construct/verify wire payloads independently of the
// implementation under test.
function b64encodeUtf8(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
}
function b64decodeUtf8(b64) {
  return decodeURIComponent(atob(b64).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
}

// ── token management ────────────────────────────────────────────────────

describe('github: token management', () => {
  it('getToken returns null when unset', () => {
    github.forgetToken();
    assert.equal(github.getToken(), null);
  });

  it('setToken/getToken round-trip via the shared localStorage key', () => {
    github.setToken('ghp_abc123');
    assert.equal(localStorage.getItem(TOKEN_KEY), 'ghp_abc123');
    assert.equal(github.getToken(), 'ghp_abc123');
    github.forgetToken();
  });

  it('forgetToken clears the shared key', () => {
    github.setToken('ghp_xyz');
    github.forgetToken();
    assert.equal(github.getToken(), null);
    assert.equal(localStorage.getItem(TOKEN_KEY), null);
  });
});

// ── getFile ──────────────────────────────────────────────────────────────

describe('github: getFile', () => {
  it('GETs the Contents API and decodes base64 content, returning content/sha/etag', async () => {
    await withStubFetch(
      (url, opts) => {
        assert.ok(url.startsWith('https://api.github.com/repos/o/r/contents/_posts/a.md'));
        assert.ok(url.includes('ref=main'));
        assert.equal(opts.headers.Accept, 'application/vnd.github+json');
        assert.equal(opts.headers.Authorization, undefined, 'no token set — no Authorization header');
        return fakeResponse({
          status: 200,
          headers: { etag: 'W/"abc123"' },
          body: { content: b64encodeUtf8('hello world'), encoding: 'base64', sha: 'deadbeef' },
        });
      },
      async () => {
        const result = await github.getFile({ owner: 'o', repo: 'r', ref: 'main', path: '_posts/a.md' });
        assert.deepEqual(result, { content: 'hello world', sha: 'deadbeef', etag: 'W/"abc123"' });
      }
    );
  });

  it('sends If-None-Match when an etag is supplied and returns "not-modified" on 304', async () => {
    await withStubFetch(
      (url, opts) => {
        assert.equal(opts.headers['If-None-Match'], 'W/"abc123"');
        return fakeResponse({ status: 304 });
      },
      async () => {
        const result = await github.getFile({ owner: 'o', repo: 'r', ref: 'main', path: 'a.md', etag: 'W/"abc123"' });
        assert.equal(result, 'not-modified');
      }
    );
  });

  it('returns null (not an error) on 404 — callers probe for existence', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 404, body: { message: 'Not Found' } }),
      async () => {
        const result = await github.getFile({ owner: 'o', repo: 'r', ref: 'main', path: 'missing.md' });
        assert.equal(result, null);
      }
    );
  });

  it('round-trips UTF-8 content (emoji + accents) through base64 decoding', async () => {
    const original = 'Café — 日本語 — 🎉 déjà vu';
    await withStubFetch(
      () => fakeResponse({
        status: 200,
        headers: { etag: '"e1"' },
        body: { content: b64encodeUtf8(original), encoding: 'base64', sha: 's1' },
      }),
      async () => {
        const result = await github.getFile({ owner: 'o', repo: 'r', ref: 'main', path: 'a.md' });
        assert.equal(result.content, original);
      }
    );
  });

  it('maps a 401 response to GitHubError kind:auth', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 401, body: { message: 'Bad credentials' } }),
      async () => {
        await expectGitHubError(
          github.getFile({ owner: 'o', repo: 'r', ref: 'main', path: 'a.md' }),
          { kind: 'auth', status: 401 }
        );
      }
    );
  });
});

// ── putFile ──────────────────────────────────────────────────────────────

describe('github: putFile', () => {
  it('PUTs base64-encoded UTF-8 content with message/branch/sha and returns the new sha', async () => {
    const original = 'Résumé — naïve — 🚀';
    await withStubFetch(
      (url, opts) => {
        assert.equal(url, 'https://api.github.com/repos/o/r/contents/_posts/a.md');
        assert.equal(opts.method, 'PUT');
        assert.equal(opts.headers['Content-Type'], 'application/json');
        const sent = JSON.parse(opts.body);
        assert.equal(sent.message, 'Update a.md');
        assert.equal(sent.branch, 'main');
        assert.equal(sent.sha, 'oldsha');
        assert.equal(b64decodeUtf8(sent.content), original);
        return fakeResponse({ status: 200, body: { content: { sha: 'newsha' } } });
      },
      async () => {
        const result = await github.putFile({
          owner: 'o', repo: 'r', branch: 'main', path: '_posts/a.md',
          content: original, message: 'Update a.md', sha: 'oldsha',
        });
        assert.deepEqual(result, { sha: 'newsha' });
      }
    );
  });

  it('omits sha from the request body when creating a new file', async () => {
    await withStubFetch(
      (url, opts) => {
        const sent = JSON.parse(opts.body);
        assert.ok(!('sha' in sent), 'sha should be omitted when not provided');
        return fakeResponse({ status: 201, body: { content: { sha: 'brandnew' } } });
      },
      async () => {
        const result = await github.putFile({
          owner: 'o', repo: 'r', branch: 'main', path: 'a.md', content: 'x', message: 'Create a.md',
        });
        assert.deepEqual(result, { sha: 'brandnew' });
      }
    );
  });

  it('maps a 409 sha conflict to GitHubError kind:conflict', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 409, body: { message: 'a.md does not match sha' } }),
      async () => {
        await expectGitHubError(
          github.putFile({ owner: 'o', repo: 'r', branch: 'main', path: 'a.md', content: 'x', message: 'm', sha: 's' }),
          { kind: 'conflict', status: 409 }
        );
      }
    );
  });

  it('maps a 422 sha-mismatch validation error to GitHubError kind:conflict', async () => {
    await withStubFetch(
      () => fakeResponse({
        status: 422,
        body: { message: 'Invalid request', errors: [{ resource: 'Content', field: 'sha', code: 'invalid' }] },
      }),
      async () => {
        await expectGitHubError(
          github.putFile({ owner: 'o', repo: 'r', branch: 'main', path: 'a.md', content: 'x', message: 'm', sha: 'stale' }),
          { kind: 'conflict', status: 422 }
        );
      }
    );
  });
});

// ── repo / branch metadata ──────────────────────────────────────────────

describe('github: getRepo / listBranches / getBranchHead / createBranch', () => {
  it('getRepo GETs /repos/{owner}/{repo}', async () => {
    await withStubFetch(
      (url) => {
        assert.equal(url, 'https://api.github.com/repos/o/r');
        return fakeResponse({ status: 200, body: { full_name: 'o/r', default_branch: 'main' } });
      },
      async () => {
        const repo = await github.getRepo({ owner: 'o', repo: 'r' });
        assert.equal(repo.full_name, 'o/r');
      }
    );
  });

  it('listBranches GETs the branches collection', async () => {
    await withStubFetch(
      (url) => {
        assert.ok(url.startsWith('https://api.github.com/repos/o/r/branches'));
        return fakeResponse({ status: 200, body: [{ name: 'main' }, { name: 'draft' }] });
      },
      async () => {
        const branches = await github.listBranches({ owner: 'o', repo: 'r' });
        assert.deepEqual(branches.map((b) => b.name), ['main', 'draft']);
      }
    );
  });

  it('getBranchHead GETs the ref and returns {sha}', async () => {
    await withStubFetch(
      (url) => {
        assert.equal(url, 'https://api.github.com/repos/o/r/git/ref/heads/main');
        return fakeResponse({ status: 200, body: { ref: 'refs/heads/main', object: { sha: 'headsha' } } });
      },
      async () => {
        const result = await github.getBranchHead({ owner: 'o', repo: 'r', branch: 'main' });
        assert.deepEqual(result, { sha: 'headsha' });
      }
    );
  });

  it('createBranch POSTs refs/heads/<name> with fromSha', async () => {
    await withStubFetch(
      (url, opts) => {
        assert.equal(url, 'https://api.github.com/repos/o/r/git/refs');
        assert.equal(opts.method, 'POST');
        const sent = JSON.parse(opts.body);
        assert.deepEqual(sent, { ref: 'refs/heads/feature-x', sha: 'basesha' });
        return fakeResponse({
          status: 201,
          body: { ref: 'refs/heads/feature-x', object: { sha: 'basesha' } },
        });
      },
      async () => {
        const result = await github.createBranch({ owner: 'o', repo: 'r', name: 'feature-x', fromSha: 'basesha' });
        assert.equal(result.sha, 'basesha');
        assert.equal(result.ref, 'refs/heads/feature-x');
      }
    );
  });

  it('getRepo maps a 404 to GitHubError kind:not-found (unlike getFile)', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 404, body: { message: 'Not Found' } }),
      async () => {
        await expectGitHubError(github.getRepo({ owner: 'o', repo: 'missing' }), { kind: 'not-found', status: 404 });
      }
    );
  });
});

// ── status → kind error mapping ─────────────────────────────────────────

describe('github: status → kind error mapping', () => {
  it('403 with x-ratelimit-remaining:0 maps to kind:rate-limit', async () => {
    await withStubFetch(
      () => fakeResponse({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
        body: { message: 'API rate limit exceeded' },
      }),
      async () => {
        await expectGitHubError(github.getRepo({ owner: 'o', repo: 'r' }), { kind: 'rate-limit', status: 403 });
      }
    );
  });

  it('403 without rate-limit signal maps to kind:auth', async () => {
    await withStubFetch(
      () => fakeResponse({ status: 403, body: { message: 'Resource not accessible by personal access token' } }),
      async () => {
        await expectGitHubError(github.getRepo({ owner: 'o', repo: 'r' }), { kind: 'auth', status: 403 });
      }
    );
  });

  it('network rejection (fetch throws) maps to kind:network', async () => {
    await withStubFetch(
      () => { throw new TypeError('Failed to fetch'); },
      async () => {
        await expectGitHubError(github.getRepo({ owner: 'o', repo: 'r' }), { kind: 'network' });
      }
    );
  });

  it('a request that never resolves times out to kind:network', async () => {
    const originalTimeout = github._internal.timeoutMs;
    github._internal.timeoutMs = 30; // shrink for the test; real default is 15000ms
    try {
      await withStubFetch(
        (url, opts) => new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
        async () => {
          await expectGitHubError(github.getRepo({ owner: 'o', repo: 'r' }), { kind: 'network' });
        }
      );
    } finally {
      github._internal.timeoutMs = originalTimeout;
    }
  }, { timeout: 2000 });
});

// ── security invariant: token never leaks ───────────────────────────────

describe('github: token never appears in URLs or error messages', () => {
  it('Authorization header carries the token; URL and headers otherwise do not', async () => {
    await withToken('ghp_SUPERSECRET999', async () => {
      await withStubFetch(
        (url, opts) => {
          assert.equal(opts.headers.Authorization, 'token ghp_SUPERSECRET999');
          assert.ok(!url.includes('ghp_SUPERSECRET999'), 'token leaked into URL');
          assert.ok(
            !JSON.stringify(opts.headers).includes('ghp_SUPERSECRET999') ||
              opts.headers.Authorization.includes('ghp_SUPERSECRET999'),
            'token appeared outside the Authorization header'
          );
          return fakeResponse({ status: 200, body: { full_name: 'o/r' } });
        },
        async () => {
          await github.getRepo({ owner: 'o', repo: 'r' });
        }
      );
    });
  });

  it('a thrown GitHubError never carries the token in message or serialized form, even on failure', async () => {
    await withToken('ghp_SUPERSECRET999', async () => {
      await withStubFetch(
        (url, opts) => {
          assert.ok(!url.includes('ghp_SUPERSECRET999'));
          return fakeResponse({ status: 401, body: { message: 'Bad credentials' } });
        },
        async () => {
          const err = await expectGitHubError(github.getRepo({ owner: 'o', repo: 'r' }), { kind: 'auth', status: 401 });
          assert.ok(!err.message.includes('ghp_SUPERSECRET999'), 'token leaked into error message');
          assert.ok(!String(err.stack || '').includes('ghp_SUPERSECRET999'), 'token leaked into error stack');
          const serialized = JSON.stringify({ message: err.message, status: err.status, kind: err.kind, name: err.name });
          assert.ok(!serialized.includes('ghp_SUPERSECRET999'), 'token leaked into serialized error');
        }
      );
    });
  });

  it('getFile never sends the token in the ref/path query string', async () => {
    await withToken('ghp_ANOTHERSECRET', async () => {
      await withStubFetch(
        (url) => {
          assert.ok(!url.includes('ghp_ANOTHERSECRET'));
          return fakeResponse({ status: 404 });
        },
        async () => {
          await github.getFile({ owner: 'o', repo: 'r', ref: 'main', path: 'a.md' });
        }
      );
    });
  });
});
