/**
 * editor/github.js — GitHub Contents/Git API client (WP-3.1)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. Direct fetch (no Octokit).
 * Token stored in localStorage under 'jekyllPreviewPAT' (shared with the
 * preview tool). The PAT MUST only ever travel in Authorization headers to
 * api.github.com — never in URLs, logs, or error messages (spec §5.2 /
 * FR-GH.1). Every request built here sends the token, if any, as a header
 * only; no function in this module ever interpolates it into a URL string,
 * a thrown Error's message, or a GitHubError's serialized fields.
 *
 * Reference shapes (Contents API base64 handling, `Authorization: token
 * <PAT>` header style, shared localStorage key) mirror preview/index.html's
 * fetch layer (:243-455), adapted to the frozen signatures below and to the
 * modern `Accept: application/vnd.github+json` media type.
 */

const API_BASE = 'https://api.github.com';

/** localStorage key shared with the preview tool. */
export const TOKEN_KEY = 'jekyllPreviewPAT';

/**
 * Test-only knob: not part of the frozen contract. Lets
 * tests/unit/github.test.js shrink the request timeout to exercise the
 * timeout → GitHubError('network') path without a real 15 s wait.
 * @type {{ timeoutMs: number }}
 */
export const _internal = { timeoutMs: 15000 };

/** @returns {string|null} */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || null;
}

/** @param {string} t */
export function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}

export function forgetToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Structured GitHub error. `kind` classifies the failure for the UI.
 * @property {number} status
 * @property {'auth'|'conflict'|'rate-limit'|'not-found'|'network'} kind
 */
export class GitHubError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, kind?: 'auth'|'conflict'|'rate-limit'|'not-found'|'network' }} [meta]
   */
  constructor(message, { status, kind } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.kind = kind;
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Low-level fetch plumbing
// ─────────────────────────────────────────────────────────────────────────

function authHeaders(extra = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...extra };
  const t = getToken();
  if (t) headers['Authorization'] = `token ${t}`;
  return headers;
}

/**
 * Encode a repo-relative path for use in a Contents API URL, preserving '/'
 * as a segment separator (each segment percent-encoded individually so
 * spaces, unicode, and reserved characters round-trip correctly).
 */
function encodePath(path) {
  return String(path)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Issue a request against api.github.com. Never throws for HTTP error
 * statuses (callers decide how to map 304/404/etc.); throws GitHubError
 * kind:'network' on timeout or any fetch-level failure (DNS, offline, CORS).
 * @returns {Promise<Response>}
 */
async function apiFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), _internal.timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      headers: authHeaders(headers),
      body,
      signal: controller.signal,
    });
  } catch {
    // Covers both AbortController-driven timeouts (fetch rejects with an
    // AbortError) and genuine network failures (offline, DNS, CORS). Never
    // surface the underlying error's message verbatim — it's not
    // token-bearing, but keep the mapping uniform and predictable instead.
    throw new GitHubError('GitHub request failed: network error or timeout', { kind: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a non-ok Response into a GitHubError per the frozen status
 * mapping. Reads (and discards) the JSON body, if any, only to distinguish
 * rate-limit 403s from plain auth 403s — never to build a message that
 * could echo a token (GitHub never echoes the Authorization header back).
 * @returns {Promise<GitHubError>}
 */
async function errorFromResponse(resp) {
  let bodyJson = null;
  try {
    const text = await resp.clone().text();
    bodyJson = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON or unreadable body — fall through with bodyJson = null.
  }

  const status = resp.status;
  const apiMessage = (bodyJson && typeof bodyJson.message === 'string') ? bodyJson.message : '';

  let kind = 'network';
  if (status === 401) {
    kind = 'auth';
  } else if (status === 403) {
    const rateLimited =
      resp.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(apiMessage);
    kind = rateLimited ? 'rate-limit' : 'auth';
  } else if (status === 404) {
    kind = 'not-found';
  } else if (status === 409 || status === 422) {
    // 409 = direct sha conflict on Contents API PUT. 422 = validation
    // failure, which for this API's write paths is the sha-mismatch/branch
    // case (FR-GH.4) — treated uniformly as 'conflict' per the frozen
    // status-mapping table.
    kind = 'conflict';
  }

  const message = apiMessage
    ? `GitHub API error (${status}): ${apiMessage}`
    : `GitHub API error (${status})`;
  return new GitHubError(message, { status, kind });
}

/**
 * Base64-decode a GitHub API response, handling UTF-8 multibyte characters.
 * The standard atob() only handles Latin-1; this converts to proper UTF-8.
 * (Same approach as preview/index.html's decodeBase64Utf8.)
 */
function decodeBase64Utf8(b64) {
  return decodeURIComponent(
    atob(String(b64).replace(/\n/g, ''))
      .split('')
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** UTF-8-safe base64 encode, the inverse of decodeBase64Utf8. */
function encodeBase64Utf8(str) {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Contents API
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {{ owner: string, repo: string, ref: string, path: string, etag?: string }} args
 * @returns {Promise<{ content: string, sha: string, etag: string } | 'not-modified' | null>}
 */
export async function getFile({ owner, repo, ref, path, etag } = {}) {
  const headers = {};
  if (etag) headers['If-None-Match'] = etag;
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const resp = await apiFetch(`/repos/${owner}/${repo}/contents/${encodePath(path)}${qs}`, { headers });

  if (resp.status === 304) return 'not-modified';
  // 404 is a normal "file doesn't exist" outcome for this contract (callers
  // probe for existence) — not an error.
  if (resp.status === 404) return null;
  if (!resp.ok) throw await errorFromResponse(resp);

  const json = await resp.json();
  if (json.encoding !== 'base64' || typeof json.content !== 'string') {
    throw new GitHubError('Unexpected response shape from GitHub Contents API', {
      status: resp.status,
      kind: 'network',
    });
  }

  return {
    content: decodeBase64Utf8(json.content),
    sha: json.sha,
    etag: resp.headers.get('etag') || '',
  };
}

/**
 * @param {{ owner: string, repo: string, branch: string, path: string, content: string, message: string, sha?: string }} args
 * @returns {Promise<{ sha: string }>}
 */
export async function putFile({ owner, repo, branch, path, content, message, sha } = {}) {
  const body = JSON.stringify({
    message,
    content: encodeBase64Utf8(content),
    branch,
    ...(sha ? { sha } : {}),
  });
  const resp = await apiFetch(`/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) throw await errorFromResponse(resp);
  const json = await resp.json();
  return { sha: json.content && json.content.sha };
}

// ─────────────────────────────────────────────────────────────────────────
//  Repo / branch metadata
// ─────────────────────────────────────────────────────────────────────────

/** @param {{ owner: string, repo: string }} args */
export async function getRepo({ owner, repo } = {}) {
  const resp = await apiFetch(`/repos/${owner}/${repo}`);
  if (!resp.ok) throw await errorFromResponse(resp);
  return resp.json();
}

/** @param {{ owner: string, repo: string }} args @returns {Promise<Array<object>>} */
export async function listBranches({ owner, repo } = {}) {
  const resp = await apiFetch(`/repos/${owner}/${repo}/branches?per_page=100`);
  if (!resp.ok) throw await errorFromResponse(resp);
  return resp.json();
}

/** @param {{ owner: string, repo: string, branch: string }} args */
export async function getBranchHead({ owner, repo, branch } = {}) {
  const resp = await apiFetch(`/repos/${owner}/${repo}/git/ref/heads/${encodePath(branch)}`);
  if (!resp.ok) throw await errorFromResponse(resp);
  const json = await resp.json();
  return { sha: json.object && json.object.sha };
}

/** @param {{ owner: string, repo: string, name: string, fromSha: string }} args */
export async function createBranch({ owner, repo, name, fromSha } = {}) {
  const resp = await apiFetch(`/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${name}`, sha: fromSha }),
  });
  if (!resp.ok) throw await errorFromResponse(resp);
  const json = await resp.json();
  return { sha: json.object && json.object.sha, ref: json.ref };
}
