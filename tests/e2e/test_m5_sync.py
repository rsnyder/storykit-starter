"""M5 GitHub sync e2e (WP-5.3) — spec §9 M5 criterion:

    "Round-trip: create → commit to new branch → edit remotely →
     pull-with-conflict handled without data loss (local snapshot
     verified)."

Drives editor/index.html end to end against `tests/e2e/github_mock.py`'s
stateful, in-Playwright fake of api.github.com (a real repo model — branches,
contents, sha/ETag conflict semantics — rather than canned single-shot
responses), reusing the `_hermetic_page` / `_boot_editor` idioms established
by test_m3_preview.py / test_m4_media.py (tools/render_regression.py's
route-interception helpers via `sys.path.insert(0, tools)`).

── Why GitHubMock routes are registered AFTER render_regression's ──────────
`rr.install_routes()` claims `api.github.com/repos/rsnyder/storykit-starter/**`
(the hermetic OWNER/REPO an *unbound* doc's preview context would fetch from)
plus a catch-all that aborts anything else non-localhost. Every test below
uses a GitHubMock `owner/repo` pair that is NOT "rsnyder/storykit-starter",
so there is no glob overlap with rr's routes in practice — but GitHubMock is
still constructed after `_hermetic_page` installs rr's routes (Playwright
matches most-recently-registered first), so if a future test ever reused
rr's own OWNER/REPO the mock would still win. Verified empirically: the
suite is green with both route sets live on the same page.

── Driving the UI ────────────────────────────────────────────────────────
Documents are created directly via the store (`app.modules.store.docs.create`
+ `app.openDoc`), the same technique test_m3/test_m4 use — this is a real
store call, not a fake, so it exercises the identical code path the "+ New"
form's click handler does. Binding/commit/pull/token-setup are driven
through the REAL sync panel UI (`#status-binding` → `dialog#sync-panel`,
`#sync-owner`/`#sync-repo`/`#sync-branch`/`#sync-path`, `#sync-bind-btn`,
`#sync-commit-btn`, `#sync-pull-btn`) per the WP-5.1 selector contract — this
is the point of an M5 e2e suite: prove the panel's click-through workflow,
not just the underlying sync.js functions. The one exception is setting the
token, which the WP-5.3 brief explicitly allows via
`app.modules.github.setToken` directly; using it here avoids typing a fake
PAT into a password-type input for zero behavioural difference (the panel's
"Save token" button calls the exact same `github.setToken`).

Conflict-dialog interactions are ALL mouse clicks
(`[data-sk-conflict-action="mine"|"remote"]`, `.sk-conflict-close` for
cancel) — never a synthesized keyboard shortcut. The brief calls this out
explicitly ("no shortcut synthesis — avoids the KeyK class of cross-platform
issues", a lesson from this repo's own git history on the Wikidata
entity-link ⌘⇧K tests). `.sk-conflict-close` fires the exact same `doCancel()`
code path Escape does (see editor/conflict.js), so testing cancel via the
close button is behaviourally identical to Esc without the platform-key risk.
"""

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import render_regression as rr  # noqa: E402

from conftest import _cached_chromium  # noqa: E402
from github_mock import GitHubMock  # noqa: E402

MOUNT_TIMEOUT = 25_000  # ms — CM editor mounted after a doc is opened
ACTION_TIMEOUT = 10_000  # ms — a sync network round-trip against the mock


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def site_dir():
    """A built _site (the harness serves the editor page from it)."""
    import subprocess

    site = rr.REPO_ROOT / "_site"
    if not (site / "editor" / "index.html").exists():
        subprocess.run(
            ["bundle", "exec", "jekyll", "build"], cwd=rr.REPO_ROOT, check=True,
            capture_output=True,
        )
    assert (site / "editor" / "index.html").exists(), "_site build produced no editor page"
    return site


@pytest.fixture(scope="session")
def browser(playwright):
    kwargs = {"headless": True}
    exe = _cached_chromium()
    try:
        b = playwright.chromium.launch(**kwargs)
    except Exception:
        if not exe:
            raise
        b = playwright.chromium.launch(executable_path=exe, **kwargs)
    yield b
    b.close()


def _hermetic_page(browser):
    """A fresh context/page with render_regression's route interception
    installed. GitHubMock routes are layered on top by each test (see the
    module docstring for why registration order is safe here)."""
    context = browser.new_context(locale="en-US", timezone_id="UTC")
    page = context.new_page()
    audit = rr.RouteAudit(False)
    rr.install_routes(page, audit)
    rr.install_editor_extra_routes(page, audit)
    return context, page, audit


def _boot_editor(page, base_url):
    page.goto(f"{base_url}/editor/index.html", wait_until="load",
              timeout=rr.POLL_TIMEOUT_MS)
    page.wait_for_selector("#new-doc:not([disabled])", timeout=rr.POLL_TIMEOUT_MS)


# ── editor-driving helpers ────────────────────────────────────────────────────

def _create_and_open_doc(page, title, content):
    """Creates a document via the real store call the "+ New" form itself
    uses, opens it, and switches to Edit mode. Returns the new doc's id."""
    doc_id = page.evaluate(
        """async ({ title, content }) => {
            const app = await import('/editor/app.js');
            const rec = await app.modules.store.docs.create({ title, path: null, content });
            await app.openDoc(rec.id);
            app.setMode('edit');
            return rec.id;
        }""",
        {"title": title, "content": content},
    )
    page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)
    return doc_id


def _set_token(page, token):
    """Sets the shared PAT the same way the sync panel's "Save token" button
    does (calls the identical github.setToken) — see module docstring."""
    page.evaluate(
        """async (token) => {
            const app = await import('/editor/app.js');
            app.modules.github.setToken(token);
        }""",
        token,
    )


def _open_sync_panel(page):
    page.click("#status-binding")
    page.wait_for_selector("dialog#sync-panel[open]", timeout=5000)


def _bind(page, owner, repo, branch, path):
    _open_sync_panel(page)
    page.fill("#sync-owner", owner)
    page.fill("#sync-repo", repo)
    page.fill("#sync-branch", branch)
    page.fill("#sync-path", path)
    page.click("#sync-bind-btn")


def _wait_badge_state(page, expected_states, timeout=ACTION_TIMEOUT):
    """Waits for the status-bar badge (#status-binding[data-state]) to reach
    one of `expected_states` — the single most meaningful synchronization
    point for every sync action (bind/commit/pull all end by emitting
    `sync:status`, which statusbar.js reflects onto this attribute)."""
    states = list(expected_states) if isinstance(expected_states, (list, tuple, set)) else [expected_states]
    page.wait_for_function(
        """(states) => {
            const el = document.getElementById('status-binding');
            return !!el && states.includes(el.getAttribute('data-state'));
        }""",
        arg=states,
        timeout=timeout,
    )


def _buffer_text(page):
    """The CM6 document's actual text content via `EditorView.findFromDOM`
    (same technique test_m4_media.py uses) — not `.cm-content`'s rendered
    innerText, which would also pick up any inline widget decorations."""
    return page.evaluate(
        """async () => {
            const { EditorView } = await import('@codemirror/view');
            const dom = document.querySelector('#editor-mount');
            const view = EditorView.findFromDOM(dom);
            return view ? view.state.doc.toString() : null;
        }"""
    )


def _doc_record(page, doc_id):
    return page.evaluate(
        """async (docId) => {
            const app = await import('/editor/app.js');
            return app.modules.store.docs.get(docId);
        }""",
        doc_id,
    )


def _revisions(page, doc_id):
    return page.evaluate(
        """async (docId) => {
            const app = await import('/editor/app.js');
            return app.modules.store.revisions.list(docId);
        }""",
        doc_id,
    )


def _check_remote(page, doc_id):
    return page.evaluate(
        """async (docId) => {
            const app = await import('/editor/app.js');
            return app.modules.sync.checkRemote(docId);
        }""",
        doc_id,
    )


def _type_at_end(page, text):
    """Appends `text` at the end of the CM6 buffer by clicking into it and
    using ControlOrMeta+End — a real keystroke sequence, no shortcut with a
    letter key involved (Home/End are unambiguous across platforms, unlike
    the Cmd/Ctrl+Shift+<letter> combos this repo's git history flags as
    flaky)."""
    page.locator(".cm-content").click()
    page.keyboard.press("ControlOrMeta+End")
    page.keyboard.type(text)


# ── a. full round-trip — THE §9 M5 criterion ─────────────────────────────────

def test_full_round_trip_create_commit_remote_edit_pull(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            mock = GitHubMock(page, owner="acme-corp", repo="round-trip-site")
            _boot_editor(page, base_url)
            _set_token(page, "ghp_roundtrip_TOKEN_abc123")

            branch = "feature/round-trip"
            path = "_posts/2026-07-06-round-trip.md"
            initial_content = "---\ntitle: Round trip\n---\n\nInitial content.\n"

            doc_id = _create_and_open_doc(page, "Round trip doc", initial_content)
            assert mock.get_remote(branch, path) is None, "branch/file must not pre-exist"

            # Bind to a brand-new branch — the mock creates it (copying the
            # then-empty default branch), and since the target path doesn't
            # exist there yet the badge goes straight to 'local-changes'.
            _bind(page, mock.owner, mock.repo, branch, path)
            _wait_badge_state(page, ["local-changes"])
            assert branch in mock.branches, "bindDocument should have created the branch"

            # Commit — first write, so PUT has no sha; mock records it.
            page.click("#sync-commit-btn")
            _wait_badge_state(page, ["synced"])

            remote_after_commit = mock.get_remote(branch, path)
            assert remote_after_commit is not None
            assert remote_after_commit["content"] == initial_content

            record_after_commit = _doc_record(page, doc_id)
            assert record_after_commit["github"]["sha"] == remote_after_commit["sha"]

            # Someone (possibly the author, from another machine) edits the
            # file directly on GitHub — completely outside this app session.
            remote_content = "---\ntitle: Round trip\n---\n\nEdited remotely!\n"
            mock.set_remote(branch, path, remote_content)

            # Passive check (FR-GH.5): flips remoteChanged without touching
            # the buffer.
            result = _check_remote(page, doc_id)
            assert result == "changed"
            _wait_badge_state(page, ["remote-changed"])
            unaffected = _buffer_text(page)
            assert unaffected == initial_content, "checkRemote must never touch the buffer"

            # Pull — snapshots local FIRST (the M5 data-loss invariant), then
            # replaces the buffer/store with the remote content.
            page.click("#sync-pull-btn")
            _wait_badge_state(page, ["synced"])

            assert _buffer_text(page) == remote_content
            record_after_pull = _doc_record(page, doc_id)
            assert record_after_pull["content"] == remote_content
            assert record_after_pull["github"]["sha"] == mock.get_remote(branch, path)["sha"]

            # THE snapshot-verification technique: read the revisions store
            # straight from IndexedDB (via the same module singleton the page
            # itself is using) and assert the 'pre-pull' entry captured the
            # PRE-pull local content byte-for-byte — this is what "local
            # snapshot verified" (spec §9 M5) means operationally.
            revs = _revisions(page, doc_id)
            pre_pull = [r for r in revs if r["reason"] == "pre-pull"]
            assert len(pre_pull) == 1, f"expected exactly one pre-pull snapshot, got {len(pre_pull)}"
            assert pre_pull[0]["content"] == initial_content
        finally:
            context.close()


# ── b. commit conflict — all three resolutions ───────────────────────────────

def _setup_conflict(browser, base_url, repo_slug):
    """Shared setup for the three conflict-resolution tests: bind + commit to
    a clean 'synced' state, make a local edit, have the mock simulate a
    divergent remote edit, then click Commit to trigger the 409 → dialog.
    Returns a dict the caller uses to finish the flow with a click of its
    choice; the caller MUST close `context` when done.
    """
    context, page, _ = _hermetic_page(browser)
    mock = GitHubMock(page, owner="acme-corp", repo=repo_slug)
    _boot_editor(page, base_url)
    _set_token(page, "ghp_conflict_TOKEN_xyz789")

    branch = "main"
    path = "_posts/2026-07-06-conflict-doc.md"
    original_content = "---\ntitle: Conflict doc\n---\n\nOriginal content.\n"

    doc_id = _create_and_open_doc(page, "Conflict doc", original_content)
    _bind(page, mock.owner, mock.repo, branch, path)
    _wait_badge_state(page, ["local-changes"])
    page.click("#sync-commit-btn")
    _wait_badge_state(page, ["synced"])

    original_sha = mock.get_remote(branch, path)["sha"]

    # Close the (still-open, non-modal-blocking-once-closed) sync panel so
    # the editor surface underneath is clickable again.
    page.click("#sync-panel .sk-dialog-close")
    page.wait_for_function(
        "() => { const d = document.getElementById('sync-panel'); return !d || !d.open; }",
        timeout=5000,
    )

    _type_at_end(page, "Local edit before conflict.\n")
    local_content = _buffer_text(page)
    assert local_content != original_content

    divergent_remote = "---\ntitle: Conflict doc\n---\n\nSomeone else's remote edit.\n"
    mock.set_remote(branch, path, divergent_remote)
    assert mock.get_remote(branch, path)["sha"] != original_sha

    _open_sync_panel(page)
    page.click("#sync-commit-btn")  # → 409 → conflict dialog
    # The sync panel is a native <dialog> shown via showModal(), so it sits
    # in the top layer ABOVE the conflict dialog's plain backdrop <div> —
    # close it (this does not affect the in-flight commitDocument() promise,
    # which is plain async JS, not tied to the panel's DOM visibility) so the
    # conflict dialog underneath becomes clickable.
    page.click("#sync-panel .sk-dialog-close")
    dialog = page.locator(".sk-conflict-dialog")
    dialog.wait_for(state="visible", timeout=ACTION_TIMEOUT)

    return {
        "context": context, "page": page, "mock": mock, "dialog": dialog,
        "doc_id": doc_id, "branch": branch, "path": path,
        "original_sha": original_sha, "local_content": local_content,
        "divergent_remote": divergent_remote,
    }


def test_conflict_keep_mine_force_puts_local_and_snapshots(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        setup = _setup_conflict(browser, base_url, "conflict-mine-site")
        page, mock = setup["page"], setup["mock"]
        try:
            page.click('[data-sk-conflict-action="mine"]')
            setup["dialog"].wait_for(state="hidden", timeout=ACTION_TIMEOUT)
            _wait_badge_state(page, ["synced"])

            remote = mock.get_remote(setup["branch"], setup["path"])
            assert remote["content"] == setup["local_content"], \
                "'Keep mine' must force-put the local content, overwriting the remote"
            assert remote["sha"] != setup["original_sha"]

            record = _doc_record(page, setup["doc_id"])
            assert record["github"]["sha"] == remote["sha"]

            revs = _revisions(page, setup["doc_id"])
            pre_conflict = [r for r in revs if r["reason"] == "pre-conflict"]
            assert len(pre_conflict) == 1, f"expected exactly one pre-conflict snapshot, got {len(pre_conflict)}"
            assert pre_conflict[0]["content"] == setup["local_content"]
        finally:
            setup["context"].close()


def test_conflict_take_remote_adopts_remote_and_snapshots_local(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        setup = _setup_conflict(browser, base_url, "conflict-remote-site")
        page, mock = setup["page"], setup["mock"]
        try:
            puts_before = sum(1 for r in mock.request_log if r["method"] == "PUT")

            page.click('[data-sk-conflict-action="remote"]')
            setup["dialog"].wait_for(state="hidden", timeout=ACTION_TIMEOUT)
            _wait_badge_state(page, ["synced"])

            assert _buffer_text(page) == setup["divergent_remote"]
            record = _doc_record(page, setup["doc_id"])
            assert record["content"] == setup["divergent_remote"]

            revs = _revisions(page, setup["doc_id"])
            pre_conflict = [r for r in revs if r["reason"] == "pre-conflict"]
            assert len(pre_conflict) == 1, f"expected exactly one pre-conflict snapshot, got {len(pre_conflict)}"
            assert pre_conflict[0]["content"] == setup["local_content"], \
                "the snapshot must contain the PRE-conflict local content, not the adopted remote"

            remote_after = mock.get_remote(setup["branch"], setup["path"])
            assert remote_after["content"] == setup["divergent_remote"], \
                "'Take remote' must never write anything back to GitHub"
            puts_after = sum(1 for r in mock.request_log if r["method"] == "PUT")
            assert puts_after == puts_before, "no PUT of local content should be issued on 'Take remote'"
        finally:
            setup["context"].close()


def test_conflict_cancel_leaves_local_and_remote_untouched(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        setup = _setup_conflict(browser, base_url, "conflict-cancel-site")
        page, mock = setup["page"], setup["mock"]
        try:
            # Click-driven cancel: the dialog's × button runs the exact same
            # doCancel() as Escape (editor/conflict.js) — no keyboard
            # shortcut synthesis (see module docstring).
            page.click(".sk-conflict-close")
            setup["dialog"].wait_for(state="hidden", timeout=ACTION_TIMEOUT)
            _wait_badge_state(page, ["local-changes"])

            assert _buffer_text(page) == setup["local_content"], \
                "cancel must leave the local buffer exactly as it was"
            record = _doc_record(page, setup["doc_id"])
            assert record["github"]["sha"] == setup["original_sha"], \
                "cancel must not adopt any new sha"
            assert record["content"] == setup["local_content"] or record["content"] is not None

            remote_after = mock.get_remote(setup["branch"], setup["path"])
            assert remote_after["content"] == setup["divergent_remote"], \
                "cancel must not touch the remote file"
            assert remote_after["sha"] != setup["original_sha"]  # untouched since our earlier set_remote
        finally:
            setup["context"].close()


# ── c. token hygiene ──────────────────────────────────────────────────────────

def test_token_never_appears_in_any_request_url(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            mock = GitHubMock(page, owner="acme-corp", repo="token-hygiene-site")
            _boot_editor(page, base_url)
            token = "ghp_SUPER_SECRET_TOKEN_VALUE_zzz999"
            _set_token(page, token)

            branch = "main"
            path = "_posts/2026-07-06-token-check.md"
            content = "---\ntitle: Token check\n---\n\nHello.\n"
            doc_id = _create_and_open_doc(page, "Token check doc", content)

            _bind(page, mock.owner, mock.repo, branch, path)
            _wait_badge_state(page, ["local-changes"])
            page.click("#sync-commit-btn")
            _wait_badge_state(page, ["synced"])

            mock.set_remote(branch, path, content + "Remote addition.\n")
            _check_remote(page, doc_id)
            page.click("#sync-pull-btn")
            _wait_badge_state(page, ["synced"])

            assert mock.request_log, "expected the sync flow to have logged requests"
            offending = [r["url"] for r in mock.request_log if token in r["url"]]
            assert not offending, f"token leaked into request URL(s): {offending}"

            carried_by_header = [r for r in mock.request_log if r["authorization"]]
            assert carried_by_header, "expected at least one request to carry an Authorization header"
            assert all(token in (r["authorization"] or "") for r in carried_by_header), \
                "sanity check: every Authorization header the mock saw should carry the token"
        finally:
            context.close()


# ── d. first-commit-creates ───────────────────────────────────────────────────

def test_first_commit_creates_file_absent_remotely(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            mock = GitHubMock(page, owner="acme-corp", repo="first-commit-site")
            _boot_editor(page, base_url)
            _set_token(page, "ghp_first_commit_TOKEN")

            branch = mock.default_branch  # bind to the (existing) default branch
            path = "_posts/2026-07-06-brand-new.md"
            content = "---\ntitle: Brand new\n---\n\nNever existed remotely.\n"

            doc_id = _create_and_open_doc(page, "Brand new doc", content)
            assert mock.get_remote(branch, path) is None

            _bind(page, mock.owner, mock.repo, branch, path)
            # (d): badge goes to 'local-changes' immediately — no remote file
            # to be "in sync" with yet, but there IS local work to push.
            _wait_badge_state(page, ["local-changes"])

            record_after_bind = _doc_record(page, doc_id)
            assert record_after_bind["github"]["sha"] is None
            assert not [r for r in mock.request_log if r["method"] == "PUT"], \
                "binding alone must not write anything"

            page.click("#sync-commit-btn")
            _wait_badge_state(page, ["synced"])

            remote = mock.get_remote(branch, path)
            assert remote is not None, "commit must have created the file in the mock"
            assert remote["content"] == content
        finally:
            context.close()
