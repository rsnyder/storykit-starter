/**
 * editor/github.js — GitHub Contents/Git API client (WP-3.1)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2. Direct fetch (no Octokit).
 * Token stored in localStorage under 'jekyllPreviewPAT' (shared with the
 * preview tool). The PAT MUST only ever travel in Authorization headers to
 * api.github.com — never in URLs, logs, or error messages (spec §5.2).
 *
 * Stub behaviour: every network/token operation throws the marker.
 * `GitHubError` is a REAL exported class so callers and tests can reference
 * it before WP-3.1 lands.
 */

const NI = 'WP-3.1: not implemented';

/** localStorage key shared with the preview tool. */
export const TOKEN_KEY = 'jekyllPreviewPAT';

/** @returns {string|null} */
export function getToken() { throw new Error(NI); }
/** @param {string} t */
export function setToken(t) { throw new Error(NI); }
export function forgetToken() { throw new Error(NI); }

/**
 * @param {{ owner: string, repo: string, ref: string, path: string, etag?: string }} args
 * @returns {Promise<{ content: string, sha: string, etag: string } | 'not-modified' | null>}
 */
export async function getFile({ owner, repo, ref, path, etag } = {}) { throw new Error(NI); }

/**
 * @param {{ owner: string, repo: string, branch: string, path: string, content: string, message: string, sha?: string }} args
 * @returns {Promise<{ sha: string }>}
 */
export async function putFile({ owner, repo, branch, path, content, message, sha } = {}) { throw new Error(NI); }

/** @param {{ owner: string, repo: string }} args */
export async function getRepo({ owner, repo } = {}) { throw new Error(NI); }

/** @param {{ owner: string, repo: string }} args @returns {Promise<Array<object>>} */
export async function listBranches({ owner, repo } = {}) { throw new Error(NI); }

/** @param {{ owner: string, repo: string, branch: string }} args */
export async function getBranchHead({ owner, repo, branch } = {}) { throw new Error(NI); }

/** @param {{ owner: string, repo: string, name: string, fromSha: string }} args */
export async function createBranch({ owner, repo, name, fromSha } = {}) { throw new Error(NI); }

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
