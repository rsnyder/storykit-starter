"""Pytest fixtures for the StoryKit editor M2 end-to-end suite.

Design (docs/editor-plan.md §2, WP-2.6):

* A free-port static HTTP server rooted at the repo (reusing the pattern from
  tools/run_browser_tests.py — never port 4000, which a local `jekyll serve`
  may occupy). esm.sh module loads run LIVE, exactly as the browser unit suite
  already does in CI.

* Browser restarts (the crux of the "loses nothing across sessions" milestone
  criterion) are simulated with Playwright's `launch_persistent_context` over a
  temp profile directory: closing the context and relaunching on the SAME
  profile dir is a real browser restart as far as IndexedDB and localStorage
  are concerned — both live inside that profile, so a debounced autosave that
  reached disk before the close survives into the next launch. A brand-new
  incognito context (the default `browser.new_context`) would start with an
  empty IndexedDB and could not prove persistence, which is why the persistent
  profile is the reliable route here.

Only `playwright` + `pytest` are required (no pytest-playwright): the sync API
is driven directly from these fixtures.
"""
from __future__ import annotations

import http.server
import socket
import threading
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
FORBIDDEN_PORTS = {4000}
EDITOR_PATH = "editor/index.html"


def _find_free_port() -> int:
    for _ in range(10):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in FORBIDDEN_PORTS:
            return port
    raise RuntimeError("could not find a free port after 10 attempts")


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature
        pass


def _serve_directory(root: Path, port: int) -> http.server.ThreadingHTTPServer:
    handler = lambda *a, **k: _QuietHandler(*a, directory=str(root), **k)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def _cached_chromium() -> str | None:
    """Well-known cache path used on the dev machine / CI when Playwright can't
    resolve a browser itself (mirrors tools/run_browser_tests.py)."""
    for cache_root in (
        Path.home() / "Library" / "Caches" / "ms-playwright",
        Path.home() / ".cache" / "ms-playwright",
    ):
        candidates = sorted(cache_root.glob("chromium-*/chrome-linux/chrome"))
        candidates += sorted(cache_root.glob("chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"))
        candidates += sorted(cache_root.glob("chromium_headless_shell-*/chrome-*/headless_shell"))
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
    return None


@pytest.fixture(scope="session")
def base_url():
    """A live static server over the repo root; yields its base URL."""
    port = _find_free_port()
    httpd = _serve_directory(REPO, port)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        httpd.shutdown()


@pytest.fixture(scope="session")
def playwright():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        yield p


@pytest.fixture
def profile_dir(tmp_path):
    """A fresh, empty persistent-profile directory for one test. Reused across
    that test's context relaunches to simulate browser restarts."""
    d = tmp_path / "profile"
    d.mkdir()
    return d


@pytest.fixture
def editor_session(playwright, base_url):
    """Factory: `open(profile_dir)` launches a persistent Chromium context on
    `profile_dir`, opens the editor page, and returns `(context, page)`.

    Call it more than once with the SAME `profile_dir` to model a restart. All
    contexts opened through the factory are closed at teardown (idempotent with
    an explicit `context.close()` inside a test)."""
    contexts = []

    def _open(profile_path):
        try:
            ctx = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile_path), headless=True
            )
        except Exception:
            exe = _cached_chromium()
            if not exe:
                raise
            ctx = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile_path), headless=True, executable_path=exe
            )
        contexts.append(ctx)
        page = ctx.new_page()
        page.goto(f"{base_url}/{EDITOR_PATH}", wait_until="load")
        return ctx, page

    yield _open

    for ctx in contexts:
        try:
            ctx.close()
        except Exception:
            pass
