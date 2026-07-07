"""tests/e2e/github_mock.py — stateful in-Playwright GitHub API mock (WP-5.3).

A minimal, in-memory fake of the four GitHub REST surfaces `editor/github.js`
calls, installed as `page.route()` handlers on a live Playwright page. One
`GitHubMock` instance == one fake `{owner}/{repo}` — instantiate a fresh one
per test so tests never share mutable GitHub state.

── State shape ────────────────────────────────────────────────────────────
    self.branches: { branch_name: { repo_path: {"content": str, "sha": str} } }

`self._branch_head_sha` tracks each branch's git-ref head sha (used only by
`GET .../git/ref/heads/<b>`, `GET .../branches`, and `POST .../git/refs` —
the file-level Contents API traffic that `editor/github.js` actually issues
for reads/writes doesn't touch it).

── Route registration order (LIFO) ────────────────────────────────────────
Call `GitHubMock(page, owner, repo)` AFTER `tools/render_regression.py`'s
`install_routes()` / `install_editor_extra_routes()` have already registered
their routes on the same page (see `tests/e2e/test_m5_sync.py`'s
`_hermetic_page`). Playwright matches the most-recently-registered route
first, so this mock's handlers win any URL they claim. In practice there is
no overlap to arbitrate: this mock only claims
`https://api.github.com/repos/{owner}/{repo}**`, and every M5 test uses an
`owner/repo` pair distinct from render_regression's hermetic
`OWNER`/`REPO` ("rsnyder"/"storykit-starter", used for the *unbound* preview
context an M3/M4-style doc would fetch) — registering last is simply the
documented, defensive-by-construction ordering, verified empirically by the
full suite passing with both route sets installed together.

── sha / ETag semantics (mirrors editor/github.js's contract) ─────────────
  * Every successful PUT (create or update) mints a NEW sha: a monotonic
    counter (so it's always unique, even for byte-identical content — real
    git commits are unique too) combined with a content hash (so a diff is
    visually obvious in failure output).
  * `GET .../contents/<path>?ref=<branch>` returns an `ETag` response header
    shaped like GitHub's own (`"<sha>"`, quoted). A request whose
    `If-None-Match` header equals that value gets `304` with no body —
    `editor/github.js`'s `getFile()` maps a 304 to the `'not-modified'`
    sentinel without reading anything else off the response.
  * PUT conflict semantics (FR-GH.4's 409/422 "sha mismatch" case, folded
    here into a single, simpler 409 per the WP-5.3 brief):
      - a `sha` in the request body that doesn't match the file's CURRENT
        sha (stale — someone else committed since the caller last read it)
        → 409;
      - a PUT with NO `sha` for a path that already has content on that
        branch (absent-but-exists — GitHub requires the current sha to
        overwrite an existing file) → 409;
      - a PUT with no `sha` for a genuinely new path → 200/201 (the
        first-commit-creates path).

── Token handling ──────────────────────────────────────────────────────────
`editor/github.js` only ever sends the PAT as an `Authorization: token <PAT>`
request header (never in a URL). This mock does NOT require that header to
be present (every endpoint here works equally well unauthenticated) — it
only *records* it, in `request_log`, so a test can assert the token never
leaked into a URL while still proving at least one request carried it.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import urllib.parse


class GitHubMock:
    """Stateful fake of `{owner}/{repo}` on api.github.com.

    Test-facing helpers:
      * `set_remote(branch, path, content)` — simulate a remote edit made
        outside of the app (e.g. "someone else pushed"; creates the branch
        if needed). Returns the new blob sha.
      * `get_remote(branch, path)` — `{"content": str, "sha": str}` or
        `None`.
      * `request_log` — list of `{"method", "url", "authorization"}` dicts,
        one per intercepted request, in arrival order.
    """

    def __init__(self, page, owner: str, repo: str, default_branch: str = "main"):
        self.page = page
        self.owner = owner
        self.repo = repo
        self.default_branch = default_branch
        self.branches: dict[str, dict[str, dict]] = {default_branch: {}}
        self._branch_head_sha: dict[str, str] = {}
        self._sha_counter = 0
        self.request_log: list[dict] = []

        self._branch_head_sha[default_branch] = self._next_sha("__init__")

        prefix = f"https://api.github.com/repos/{owner}/{repo}"
        # Two patterns: the bare repo URL (GET /repos/{o}/{r}, no trailing
        # segment) and everything under it. Registered in this order but
        # both land before any test call runs, so relative LIFO order
        # between the two doesn't matter — their glob patterns don't overlap
        # (the second requires a literal '/' after {repo}).
        page.route(prefix, self._handle)
        page.route(f"{prefix}/**", self._handle)

    # ── deterministic sha ──────────────────────────────────────────────────
    def _next_sha(self, content: str) -> str:
        self._sha_counter += 1
        digest = hashlib.sha1(content.encode("utf-8")).hexdigest()[:32]
        return f"{self._sha_counter:08x}{digest}"

    @staticmethod
    def _etag_for(sha: str) -> str:
        return f'"{sha}"'

    # ── test-facing helpers ─────────────────────────────────────────────────
    def set_remote(self, branch: str, path: str, content: str) -> str:
        """Simulate a remote edit (bypasses the app/mock's own PUT path
        entirely — writes straight into state). Creates `branch` if absent.
        Returns the new blob sha."""
        sha = self._next_sha(content)
        self.branches.setdefault(branch, {})[path] = {"content": content, "sha": sha}
        self._branch_head_sha[branch] = sha
        return sha

    def get_remote(self, branch: str, path: str) -> dict | None:
        entry = self.branches.get(branch, {}).get(path)
        return dict(entry) if entry else None

    # ── route handler ────────────────────────────────────────────────────
    def _handle(self, route):
        req = route.request
        parsed = urllib.parse.urlparse(req.url)
        headers = req.headers  # dict with lowercase keys (Playwright convention)
        self.request_log.append({
            "method": req.method,
            "url": req.url,
            "authorization": headers.get("authorization"),
        })

        prefix = f"/repos/{self.owner}/{self.repo}"
        if not parsed.path.startswith(prefix):
            route.fulfill(status=404, content_type="application/json; charset=utf-8",
                          body=json.dumps({"message": "Not Found"}))
            return
        suffix = parsed.path[len(prefix):].lstrip("/")
        qs = urllib.parse.parse_qs(parsed.query)

        try:
            if suffix == "" and req.method == "GET":
                self._get_repo(route)
            elif suffix == "branches" and req.method == "GET":
                self._list_branches(route)
            elif suffix.startswith("git/ref/heads/") and req.method == "GET":
                branch = urllib.parse.unquote(suffix[len("git/ref/heads/"):])
                self._get_branch_head(route, branch)
            elif suffix == "git/refs" and req.method == "POST":
                self._create_branch(route)
            elif suffix.startswith("contents/") and req.method == "GET":
                path = urllib.parse.unquote(suffix[len("contents/"):])
                ref = (qs.get("ref") or [self.default_branch])[0]
                self._get_contents(route, ref, path)
            elif suffix.startswith("contents/") and req.method == "PUT":
                path = urllib.parse.unquote(suffix[len("contents/"):])
                self._put_contents(route, path)
            else:
                route.fulfill(status=404, content_type="application/json; charset=utf-8",
                              body=json.dumps({"message": "Not Found"}))
        except Exception as exc:  # surface mock bugs loudly instead of a silent hang
            route.fulfill(status=500, content_type="application/json; charset=utf-8",
                          body=json.dumps({"message": f"github_mock internal error: {exc}"}))
            raise

    # ── endpoint impls ──────────────────────────────────────────────────────
    def _get_repo(self, route):
        route.fulfill(status=200, content_type="application/json; charset=utf-8",
                      body=json.dumps({
                          "name": self.repo,
                          "full_name": f"{self.owner}/{self.repo}",
                          "owner": {"login": self.owner},
                          "default_branch": self.default_branch,
                      }))

    def _list_branches(self, route):
        body = [
            {"name": name, "commit": {"sha": self._branch_head_sha.get(name, "0" * 40)}}
            for name in self.branches
        ]
        route.fulfill(status=200, content_type="application/json; charset=utf-8",
                      body=json.dumps(body))

    def _get_branch_head(self, route, branch):
        sha = self._branch_head_sha.get(branch)
        if sha is None:
            route.fulfill(status=404, content_type="application/json; charset=utf-8",
                          body=json.dumps({"message": "Not Found"}))
            return
        route.fulfill(status=200, content_type="application/json; charset=utf-8",
                      body=json.dumps({"ref": f"refs/heads/{branch}", "object": {"sha": sha}}))

    def _create_branch(self, route):
        body = json.loads(route.request.post_data or "{}")
        ref = body.get("ref", "")
        from_sha = body.get("sha")
        name = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        if not name:
            route.fulfill(status=422, content_type="application/json; charset=utf-8",
                          body=json.dumps({"message": "Invalid ref"}))
            return
        if name in self.branches:
            route.fulfill(status=422, content_type="application/json; charset=utf-8",
                          body=json.dumps({"message": "Reference already exists"}))
            return
        # "copy files from source": the new branch starts as a snapshot of
        # whichever existing branch's head sha matches `fromSha` (falls back
        # to the default branch — the only source bindDocument ever creates
        # from in practice, since it always passes getBranchHead(defaultBranch)).
        source = next((b for b, s in self._branch_head_sha.items() if s == from_sha),
                      self.default_branch)
        self.branches[name] = copy.deepcopy(self.branches.get(source, {}))
        self._branch_head_sha[name] = from_sha or self._next_sha(name)
        route.fulfill(status=201, content_type="application/json; charset=utf-8",
                      body=json.dumps({"ref": f"refs/heads/{name}",
                                       "object": {"sha": self._branch_head_sha[name]}}))

    def _get_contents(self, route, ref, path):
        entry = self.branches.get(ref, {}).get(path)
        if entry is None:
            route.fulfill(status=404, content_type="application/json; charset=utf-8",
                          body=json.dumps({"message": "Not Found"}))
            return
        etag = self._etag_for(entry["sha"])
        inm = route.request.headers.get("if-none-match")
        if inm and inm == etag:
            route.fulfill(status=304, headers={"ETag": etag})
            return
        content_b64 = base64.b64encode(entry["content"].encode("utf-8")).decode("ascii")
        route.fulfill(status=200, content_type="application/json; charset=utf-8",
                      headers={"ETag": etag},
                      body=json.dumps({
                          "path": path, "sha": entry["sha"],
                          "encoding": "base64", "content": content_b64,
                      }))

    def _put_contents(self, route, path):
        body = json.loads(route.request.post_data or "{}")
        branch = body.get("branch") or self.default_branch
        req_sha = body.get("sha")
        current = self.branches.get(branch, {}).get(path)

        if req_sha:
            if current is None or current["sha"] != req_sha:
                route.fulfill(status=409, content_type="application/json; charset=utf-8",
                              body=json.dumps({"message": "sha does not match the file's current sha"}))
                return
        else:
            if current is not None:
                route.fulfill(status=409, content_type="application/json; charset=utf-8",
                              body=json.dumps({"message": "path already exists; sha is required to update it"}))
                return

        content = base64.b64decode(body.get("content", "")).decode("utf-8")
        new_sha = self._next_sha(content)
        self.branches.setdefault(branch, {})[path] = {"content": content, "sha": new_sha}
        self._branch_head_sha[branch] = new_sha
        route.fulfill(status=200 if current else 201, content_type="application/json; charset=utf-8",
                      body=json.dumps({
                          "content": {"sha": new_sha, "path": path},
                          "commit": {"sha": new_sha, "message": body.get("message", "")},
                      }))
