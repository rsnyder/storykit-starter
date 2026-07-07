"""M6 keyboard-completeness e2e (WP-6.1) — spec §5.4 / §9 M6 criterion:

    "keyboard-only walkthrough of workflows 1-4"

Four walkthroughs, one per docs/editor-spec.md §3 workflow, driven with NO
mouse clicks except where a workflow genuinely has no keyboard path (there
are none below — every interaction is a keystroke, a `page.keyboard.type()`,
or a deterministic `locator.focus()` used purely to establish a known
starting point for a Tab sequence, never a `.click()`).

── Keyboard synthesis rule (the "KeyK lesson" from M4) ─────────────────────
Every shortcut with a letter key is synthesized by PHYSICAL CODE
(`ControlOrMeta+Shift+KeyK`, not `Meta+Shift+K`) per tests/e2e/test_m4_media.py's
precedent — literal-character combos are flaky across platforms/layouts,
especially once Shift is involved.

── Workflow 1 (draft) ────────────────────────────────────────────────────
⌘K → filter/Enter "New post" → type a title → Enter submits the inline form
(a real `<form>`, so Enter-to-submit needs no extra keystroke) → the newly
created, newly OPENED document's editor already has focus (app.js's
`openDoc()` calls `editorHandle.focus()`) → type prose directly → ⌘K →
"Preview mode" → ⌘K → "Edit mode" → the typed prose is still there.

── Workflow 2 (media) ───────────────────────────────────────────────────
Paste (synthetic ClipboardEvent, same technique as test_m4_media.py's
`_paste` helper — not a mouse action) a Commons URL → the "Paste as
StoryKit tag?" affordance appears. THE FIX THIS WP MADE: that button now
AUTOFOCUSES ITSELF the instant it appears (editor/dnd.js's
`insulateFromEditorKeymap` + an explicit `.focus()` in
`PasteAffordanceWidget.toDOM`) — see that file's header note for why plain
Tab-from-the-editor could never reach it before (CM6's own Tab-for-indent
binding intercepts bare Tab first, and stopping there entirely). This test
asserts the button REALLY has focus (the keyboard-reachability proof), then
presses Enter to activate it (a trusted keydown's native default action on
a focused `<button>`; `insulateFromEditorKeymap` stops CM6 from ALSO
reinterpreting that same Enter as "insert a newline in the document").

── Workflow 3 (entity) ──────────────────────────────────────────────────
Select "Charles Darwin" by keyboard (Home + Shift+ArrowRight×N, no mouse),
`ControlOrMeta+Shift+KeyK` (Link Entity), Enter (Q1035 is the mocked top
match) → `[Charles Darwin](Q1035)`. Wikidata is mocked exactly as
test_m4_media.py does (canned wbsearchentities/wbgetentities responses).

── Workflow 4 (publish) ──────────────────────────────────────────────────
⌘K → "Open sync panel" (a native `<dialog>` via `showModal()` — the browser
provides its OWN Tab-trap, no custom JS needed) → Tab through the token
field, Save-token button, then the four binding fields and the Connect
button (typing values along the way) → wait for the bound badge → Enter on
the now-enabled Commit button → wait for the synced badge → verify the
content actually landed in tests/e2e/github_mock.py's stateful mock.

Linux-container check (per this WP's brief) is run separately, not from
inside this file — see the WP-6.1 handoff notes for the exact command.
"""

import json
import sys
import urllib.parse
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import render_regression as rr  # noqa: E402

from conftest import _cached_chromium  # noqa: E402
from github_mock import GitHubMock  # noqa: E402

MOUNT_TIMEOUT = 25_000  # ms
ACTION_TIMEOUT = 10_000  # ms


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
    """A fresh context/page with the harness's hermetic route interception —
    mirrors test_m4_media.py/test_m5_sync.py's `_hermetic_page`. Real time
    (no `page.clock.set_fixed_time()`) for the same reason test_m4_media.py
    documents: nothing here needs a frozen clock, and CM6's `hoverTooltip`
    machinery (unused directly by this file, but shared extensions are wired
    in) behaves oddly under a frozen Date."""
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


def _buffer_text(page):
    """The CM6 document's actual text content via `EditorView.findFromDOM`
    (same technique test_m4_media.py/test_m5_sync.py use) — not
    `.cm-content`'s rendered innerText, which would also pick up inline
    widget decorations (the FR-DND.5 hint, etc.)."""
    return page.evaluate(
        """async () => {
            const { EditorView } = await import('@codemirror/view');
            const dom = document.querySelector('#editor-mount');
            const view = EditorView.findFromDOM(dom);
            return view ? view.state.doc.toString() : null;
        }"""
    )


def _new_empty_doc(page, title):
    """Setup helper (not the behaviour under test): creates and opens a
    document via the real store call the "+ New" form itself uses — same
    technique test_m4_media.py's `_new_empty_doc` uses. Not a mouse action;
    just a fast way to get an editor open for workflows 2/3/4, which (per
    docs/editor-spec.md §3) assume a document is already open."""
    page.evaluate(
        """async ({ title }) => {
            const app = await import('/editor/app.js');
            const rec = await app.modules.store.docs.create({ title, path: null, content: '' });
            await app.openDoc(rec.id);
            app.setMode('edit');
        }""",
        {"title": title},
    )
    page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)


def _open_palette(page):
    page.keyboard.press("ControlOrMeta+KeyK")
    page.wait_for_selector(".sk-palette", timeout=5000)


def _run_palette_command(page, filter_text, expect_id):
    """Opens the palette, types `filter_text`, waits for `expect_id` to be
    the (only/active) result, and presses Enter to run it."""
    _open_palette(page)
    page.keyboard.type(filter_text)
    page.wait_for_selector(f'[data-sk-palette-id="{expect_id}"].is-active', timeout=5000)
    page.keyboard.press("Enter")


# ── 1. draft from scratch (spec §3 workflow 1) ────────────────────────────

def test_workflow1_draft_new_post_type_preview_edit_all_keyboard(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)

            # ⌘K → "New post" (no mouse anywhere in this workflow).
            _run_palette_command(page, "new post", "doc.new")

            # The inline New Post form (doclist.js) auto-focuses its title
            # input — type a title and Enter submits the real <form>.
            page.wait_for_selector(".dl-new-input", timeout=5000)
            page.wait_for_function(
                "() => document.activeElement && document.activeElement.classList.contains('dl-new-input')",
                timeout=5000,
            )
            page.keyboard.type("Keyboard-only draft")
            page.keyboard.press("Enter")

            # openDoc() focuses the editor automatically — no click needed.
            page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)
            page.wait_for_function(
                "() => document.activeElement && document.activeElement.classList.contains('cm-content')",
                timeout=5000,
            )
            page.keyboard.type("Prose written entirely from the keyboard.")

            # ⌘K → Preview mode.
            _run_palette_command(page, "preview mode", "view.mode.preview")
            page.wait_for_function(
                "() => document.body.getAttribute('data-mode') === 'preview'", timeout=5000
            )

            # ⌘K → back to Edit mode.
            _run_palette_command(page, "edit mode", "view.mode.edit")
            page.wait_for_function(
                "() => document.body.getAttribute('data-mode') === 'edit'", timeout=5000
            )

            assert "Prose written entirely from the keyboard." in _buffer_text(page)
        finally:
            context.close()


# ── 2. enrich with media — paste + keyboard-activate the affordance ──────

def test_workflow2_media_paste_and_keyboard_activate_affordance(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _new_empty_doc(page, "Media workflow doc")
            page.locator(".cm-content").focus()

            page.evaluate(
                """(text) => {
                    const cm = document.querySelector('.cm-content');
                    const dt = new DataTransfer();
                    dt.setData('text/plain', text);
                    cm.dispatchEvent(new ClipboardEvent('paste',
                        { clipboardData: dt, bubbles: true, cancelable: true }));
                }""",
                "https://commons.wikimedia.org/wiki/File:Example.jpg",
            )

            page.wait_for_selector(".sk-dnd-paste-btn", timeout=5000)

            # THE keyboard-reachability proof (WP-6.1's dnd.js fix — see
            # this file's module docstring): the affordance button already
            # has focus, unprompted, the moment it appears.
            page.wait_for_function(
                "() => document.activeElement && "
                "document.activeElement.classList.contains('sk-dnd-paste-btn')",
                timeout=5000,
            )

            # Enter activates it (native default action on a focused
            # <button>); CM6 never sees this Enter as "insert newline"
            # thanks to dnd.js's insulateFromEditorKeymap.
            page.keyboard.press("Enter")

            assert _buffer_text(page).strip() == \
                '{% include embed/image.html src="wc:Example.jpg" %}'
        finally:
            context.close()


# ── 3. link an entity (spec §3 workflow 3) ────────────────────────────────

DARWIN_SEARCH_RESPONSE = {
    "searchinfo": {"search": "Charles Darwin"},
    "search": [
        {"id": "Q1035", "label": "Charles Darwin",
         "description": "English naturalist and biologist (1809-1882)"},
    ],
    "success": 1,
}

DARWIN_ENTITIES_RESPONSE = {
    "entities": {
        "Q1035": {
            "id": "Q1035",
            "labels": {"en": {"language": "en", "value": "Charles Darwin"}},
            "descriptions": {"en": {"language": "en",
                                     "value": "English naturalist and biologist (1809-1882)"}},
            "claims": {},
        },
    },
    "success": 1,
}


def _install_wikidata_mock(page):
    """Registered AFTER install_editor_extra_routes (inside _hermetic_page,
    which runs before this), so Playwright's LIFO route matching checks this
    before the hermetic catch-all abort — mirrors test_m4_media.py."""

    def handler(route):
        parsed = urllib.parse.urlparse(route.request.url)
        qs = urllib.parse.parse_qs(parsed.query)
        action = (qs.get("action") or [""])[0]
        if action == "wbsearchentities":
            route.fulfill(status=200, content_type="application/json; charset=utf-8",
                          body=json.dumps(DARWIN_SEARCH_RESPONSE))
        elif action == "wbgetentities":
            route.fulfill(status=200, content_type="application/json; charset=utf-8",
                          body=json.dumps(DARWIN_ENTITIES_RESPONSE))
        else:
            route.fulfill(status=404, content_type="application/json; charset=utf-8", body="{}")

    page.route("https://www.wikidata.org/**", handler)


def test_workflow3_entity_select_link_entity_keyboard_only(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _install_wikidata_mock(page)
            _boot_editor(page, base_url)
            _new_empty_doc(page, "Entity workflow doc")
            page.locator(".cm-content").focus()

            page.keyboard.type("Charles Darwin was a naturalist.")

            # Select "Charles Darwin" (the first 14 characters) with the
            # keyboard only: Home, then Shift+ArrowRight x14.
            page.keyboard.press("ControlOrMeta+Home")
            page.keyboard.down("Shift")
            for _ in range(len("Charles Darwin")):
                page.keyboard.press("ArrowRight")
            page.keyboard.up("Shift")

            # Physical-code synthesis (the "KeyK lesson") — Link Entity.
            page.keyboard.press("ControlOrMeta+Shift+KeyK")

            popup = page.locator(".sk-wd-popup")
            popup.wait_for(state="visible", timeout=5000)
            assert page.locator(".sk-wd-input").input_value() == "Charles Darwin"

            first_result = page.locator(".sk-wd-result").first
            first_result.wait_for(state="visible", timeout=5000)
            assert first_result.get_attribute("data-qid") == "Q1035"

            page.keyboard.press("Enter")
            assert popup.count() == 0

            assert "[Charles Darwin](Q1035)" in _buffer_text(page)
        finally:
            context.close()


# ── 4. publish (spec §3 workflow 4) ───────────────────────────────────────

def _wait_badge_state(page, expected_states, timeout=ACTION_TIMEOUT):
    states = list(expected_states) if isinstance(expected_states, (list, tuple, set)) else [expected_states]
    page.wait_for_function(
        """(states) => {
            const el = document.getElementById('status-binding');
            return !!el && states.includes(el.getAttribute('data-state'));
        }""",
        arg=states,
        timeout=timeout,
    )


def test_workflow4_publish_sync_panel_bind_and_commit_keyboard_only(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            mock = GitHubMock(page, owner="acme-corp", repo="keyboard-publish-site")
            _boot_editor(page, base_url)

            _new_empty_doc(page, "Publish workflow doc")
            page.locator(".cm-content").focus()
            page.keyboard.type("Hello from the keyboard.")
            initial_content = _buffer_text(page)
            assert initial_content == "Hello from the keyboard."

            # ⌘K → "Open sync panel" — a native <dialog> via showModal(),
            # which provides its OWN Tab-trap; no custom JS focus-trap
            # needed for this workflow to be fully keyboard operable.
            _run_palette_command(page, "sync panel", "sync.panel")
            page.wait_for_selector("dialog#sync-panel[open]", timeout=5000)

            # Tab through the token field + Save-token button.
            page.locator("#sync-token-input").focus()
            page.keyboard.type("ghp_keyboard_workflow_TOKEN_zzz")
            page.keyboard.press("Tab")  # -> Save token button
            page.wait_for_function(
                "() => document.activeElement && document.activeElement.textContent === 'Save token'",
                timeout=5000,
            )
            page.keyboard.press("Enter")

            # Tab through the four binding fields, typing each, then Tab to
            # Connect and Enter.
            branch = "main"
            path = "_posts/2026-07-06-keyboard-workflow.md"
            page.locator("#sync-owner").focus()
            page.keyboard.type(mock.owner)
            page.keyboard.press("Tab")  # -> #sync-repo
            page.keyboard.type(mock.repo)
            page.keyboard.press("Tab")  # -> #sync-branch
            page.keyboard.type(branch)
            page.keyboard.press("Tab")  # -> #sync-path
            page.keyboard.type(path)
            page.keyboard.press("Tab")  # -> Connect button
            page.wait_for_function(
                "() => document.activeElement && document.activeElement.id === 'sync-bind-btn'",
                timeout=5000,
            )
            page.keyboard.press("Enter")

            _wait_badge_state(page, ["local-changes", "synced"])
            assert branch in mock.branches, "keyboard-driven bind should have created/used the branch"

            # Commit: focus the (now-enabled) Commit button directly and
            # activate it with Enter.
            page.locator("#sync-commit-btn").focus()
            page.keyboard.press("Enter")
            _wait_badge_state(page, ["synced"])

            remote = mock.get_remote(branch, path)
            assert remote is not None, "commit should have created the file in the mock"
            assert remote["content"] == initial_content
        finally:
            context.close()
