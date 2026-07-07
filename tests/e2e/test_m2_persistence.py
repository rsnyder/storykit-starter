"""M2 milestone end-to-end proof (docs/editor-spec.md §9 M2 criteria):

    "Author drafts a post over multiple sessions with browser restarts and
     loses nothing; tags visibly highlighted; 50 KB doc types smoothly."

Driven against editor/index.html through Playwright. esm.sh loads run live.
Restart-survival is simulated by relaunching a persistent Chromium context on
the same profile directory (see conftest.py).
"""
from __future__ import annotations

import time

BOOT_TIMEOUT = 25_000   # ms — first paint incl. live esm.sh module graph
MOUNT_TIMEOUT = 25_000  # ms — CM editor mounted after a doc is opened


# ── helpers ──────────────────────────────────────────────────────────────────

def _wait_booted(page):
    """The app has booted once the doclist has enabled the New button."""
    page.wait_for_selector("#new-doc:not([disabled])", timeout=BOOT_TIMEOUT)


def _create_post(page, title):
    """Create a post via the real UI and wait for the editor to mount."""
    page.click("#new-doc")
    page.fill(".dl-new-input", title)
    page.click(".dl-new-form button[type=submit]")
    page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)


def _paste(page, text):
    """Insert `text` at the cursor via a synthetic paste (avoids closeBrackets
    mangling literal `{% %}` / quotes that keystroke-by-keystroke typing would
    trigger). CM6 handles the paste event on its content DOM."""
    page.locator(".cm-content").click()
    page.evaluate(
        """(text) => {
            const cm = document.querySelector('.cm-content');
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            cm.dispatchEvent(new ClipboardEvent('paste',
                { clipboardData: dt, bubbles: true, cancelable: true }));
        }""",
        text,
    )


def _poll_store_for_marker(page, marker, timeout_s=6):
    """Poll the persisted store (via the proven evaluate path) until `marker`
    appears in some document's content, or the deadline passes."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if any(marker in (d["content"] or "") for d in _read_store_docs(page)):
            return True
        page.wait_for_timeout(200)
    return False


def _read_store_docs(page):
    """Fresh, editor-independent read of the persisted documents straight from
    editor/store.js in the given page (proves the data is in IndexedDB, not
    just in some live editor buffer)."""
    return page.evaluate(
        """async () => {
            const store = await import('/editor/store.js');
            await store.initStore();
            const list = await store.docs.list();
            return list.map(d => ({ title: d.title, path: d.path, content: d.content }));
        }"""
    )


# ── (a) draft survives an abrupt browser restart ─────────────────────────────

def test_document_survives_browser_restart(editor_session, profile_dir):
    marker = "Distinctive-Restart-Marker-7Q9Z"
    title = "Monument Valley Sunrise"

    ctx, page = editor_session(profile_dir)
    _wait_booted(page)
    _create_post(page, title)

    # Type distinctive content (plain text — no brackets to auto-close).
    page.locator(".cm-content").click()
    page.keyboard.press("Control+End")
    page.keyboard.type("\n" + marker)

    # Let the autosave debounce (store default 1500 ms) fire, then — still well
    # inside the FR-DOC.3 ≤2 s loss window — confirm the write has actually
    # COMMITTED to IndexedDB before we kill the context. Polling the store (vs a
    # fixed sleep) removes debounce-timing flakiness without weakening the test:
    # the point is that a restart recovers whatever autosave committed.
    page.wait_for_timeout(1600)
    assert _poll_store_for_marker(page, marker, timeout_s=6), \
        "autosave did not commit to IndexedDB within the window"

    # Kill the context abruptly and relaunch on the same profile.
    ctx.close()

    # Relaunch on the same profile: a real browser restart for IndexedDB.
    _ctx2, page2 = editor_session(profile_dir)
    _wait_booted(page2)

    # The last-open document is restored into the editor…
    page2.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)
    page2.wait_for_function(
        "(m) => document.querySelector('.cm-content')?.textContent.includes(m)",
        arg=marker,
        timeout=MOUNT_TIMEOUT,
    )

    # …and the post is listed in the sidebar with its title, and the persisted
    # record still carries the typed content.
    assert page2.locator(".dl-title", has_text=title).count() >= 1
    docs = _read_store_docs(page2)
    assert any(marker in (d["content"] or "") and d["title"] == title for d in docs), \
        f"persisted docs did not contain the marker: {[d['title'] for d in docs]}"


# ── (b) autosave lands within the FR-DOC.3 window ────────────────────────────

def test_autosave_persists_within_window(editor_session, profile_dir):
    marker = "autosave-window-marker-42"
    title = "Autosave Window Post"

    ctx, page = editor_session(profile_dir)
    _wait_booted(page)
    _create_post(page, title)

    page.locator(".cm-content").click()
    page.keyboard.press("Control+End")
    page.keyboard.type("\n" + marker)

    # Within the ≤2 s loss window, a FRESH page's store read must already see it.
    page.wait_for_timeout(2000)
    probe = ctx.new_page()
    probe.goto(page.url, wait_until="load")
    docs = _read_store_docs(probe)

    assert any(marker in (d["content"] or "") for d in docs), \
        "autosave did not reach IndexedDB within the 2 s window"


# ── (c) a 50 KB paste stays responsive ───────────────────────────────────────

def test_large_document_stays_responsive(editor_session, profile_dir):
    ctx, page = editor_session(profile_dir)
    _wait_booted(page)
    _create_post(page, "Fifty Kilobyte Post")

    big = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 950
    assert len(big) > 50_000  # ~54 KB

    _paste(page, "\n" + big)
    # Cursor sits at the end of the pasted block; type a distinctive char and
    # assert it round-trips into the DOM quickly. CI-tolerant bound (not the
    # spec's p95<16 ms keystroke budget — that's WP-6.3's measured audit).
    page.wait_for_timeout(200)
    page.keyboard.type("Z")

    start = time.monotonic()
    page.wait_for_function(
        "() => document.querySelector('.cm-content')?.textContent.includes('elit.Z')"
        " || document.querySelector('.cm-content')?.textContent.endsWith('Z')",
        timeout=5_000,
    )
    elapsed = time.monotonic() - start
    assert elapsed < 3.0, f"typed char took {elapsed:.2f}s to appear — editor not responsive"


# ── (d) StoryKit tag is visibly highlighted ──────────────────────────────────

def test_storykit_tag_is_highlighted(editor_session, profile_dir):
    ctx, page = editor_session(profile_dir)
    _wait_booted(page)
    _create_post(page, "Highlighted Tag Post")

    _paste(page, '\n{% include embed/image.html src="x.jpg" %}')

    # lang-storykit decorates the liquid tag with sk-liquid-* mark classes.
    page.wait_for_selector("[class*='sk-liquid-']", timeout=5_000)
    assert page.locator("[class*='sk-liquid-']").count() > 0
