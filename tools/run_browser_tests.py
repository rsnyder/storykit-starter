#!/usr/bin/env python3
"""Run tests/unit/index.html in a real browser (Playwright/Chromium) and
report pass/fail as a process exit code, for local use and CI.

Per docs/editor-plan.md §0.6 / §2 (WP-0.1): the dev machine has no Node.js,
so unit tests execute in-browser and are driven headlessly via Python
Playwright. This script:

  1. Serves the repo (or a built _site) over HTTP on a free local port
     (never 4000 — that port may be occupied by a live `jekyll serve`).
  2. Opens tests/unit/index.html in headless Chromium.
  3. Polls `window.__testResults` until `{ done: true, ... }`.
  4. Prints a summary and exits 0 if `failed == 0`, else 1.

First-time setup (no Node.js required — pure Python):
    python3 -m venv venv
    venv/bin/pip install playwright
    venv/bin/python tools/run_browser_tests.py
    # If Chromium isn't already cached under ~/Library/Caches/ms-playwright,
    # `playwright install chromium` will download it (~150 MB); that's fine
    # in a networked environment. venv/bin/playwright install chromium

Usage:
    python3 tools/run_browser_tests.py
    python3 tools/run_browser_tests.py --root _site
    python3 tools/run_browser_tests.py --selftest-fail     # verify failure detection
    python3 tools/run_browser_tests.py --url http://localhost:4000/tests/unit/index.html
    python3 tools/run_browser_tests.py --port 8931 --timeout 30
"""
from __future__ import annotations

import argparse
import http.server
import socket
import sys
import threading
from pathlib import Path
from urllib.parse import urlencode

REPO = Path(__file__).resolve().parent.parent
DEFAULT_TEST_PAGE = "tests/unit/index.html"
FORBIDDEN_PORTS = {4000}  # the main working tree's `jekyll serve` may be running here


def find_free_port() -> int:
    """Pick an OS-assigned free port, avoiding FORBIDDEN_PORTS."""
    for _ in range(10):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in FORBIDDEN_PORTS:
            return port
    raise RuntimeError("could not find a free port after 10 attempts")


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature
        pass  # keep test output readable; errors still surface via Playwright


def serve_directory(root: Path, port: int) -> http.server.ThreadingHTTPServer:
    """Start a background static file server rooted at `root`."""
    handler = lambda *args, **kwargs: _QuietHandler(*args, directory=str(root), **kwargs)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def run(args: argparse.Namespace) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "ERROR: playwright is not installed in this Python environment.\n"
            "Set up a venv first:\n"
            "  python3 -m venv venv\n"
            "  venv/bin/pip install playwright\n"
            "  venv/bin/playwright install chromium   # if not already cached\n"
            "  venv/bin/python tools/run_browser_tests.py",
            file=sys.stderr,
        )
        return 1

    httpd = None
    target_url = args.url

    if target_url is None:
        root = (REPO / args.root).resolve()
        if not root.is_dir():
            print(f"ERROR: serve root does not exist: {root}", file=sys.stderr)
            return 1
        page_path = args.page.lstrip("/")
        if not (root / page_path).is_file():
            print(f"ERROR: test page not found: {root / page_path}", file=sys.stderr)
            return 1

        port = args.port or find_free_port()
        if port in FORBIDDEN_PORTS:
            print(f"ERROR: --port {port} is reserved (may collide with jekyll serve)", file=sys.stderr)
            return 1

        httpd = serve_directory(root, port)
        query = {"selftest": "fail"} if args.selftest_fail else {}
        qs = f"?{urlencode(query)}" if query else ""
        target_url = f"http://127.0.0.1:{port}/{page_path}{qs}"
        print(f"Serving {root} at http://127.0.0.1:{port}/ ...")
    elif args.selftest_fail:
        sep = "&" if "?" in target_url else "?"
        target_url = f"{target_url}{sep}selftest=fail"

    print(f"Opening {target_url}")

    exit_code = 1
    try:
        with sync_playwright() as p:
            browser = launch_chromium(p)
            page = browser.new_page()

            console_errors = []
            page.on("pageerror", lambda exc: console_errors.append(str(exc)))
            page.on(
                "console",
                lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
            )

            page.goto(target_url, wait_until="load")

            try:
                page.wait_for_function(
                    "window.__testResults && window.__testResults.done === true",
                    timeout=args.timeout * 1000,
                )
            except Exception:
                print(
                    f"ERROR: tests did not complete within {args.timeout}s "
                    "(window.__testResults never reached done:true).",
                    file=sys.stderr,
                )
                if console_errors:
                    print("Console/page errors observed:", file=sys.stderr)
                    for err in console_errors:
                        print(f"  {err}", file=sys.stderr)
                browser.close()
                return 1

            results = page.evaluate("window.__testResults")
            browser.close()

        exit_code = print_summary(results, console_errors)
    finally:
        if httpd is not None:
            httpd.shutdown()

    return exit_code


def launch_chromium(playwright_instance):
    """Launch Chromium, falling back to the well-known cache path used on
    this machine if the installed Playwright package can't locate a browser
    (e.g. offline environments where `playwright install` cannot run)."""
    try:
        return playwright_instance.chromium.launch()
    except Exception as first_error:
        cache_root = Path.home() / "Library" / "Caches" / "ms-playwright"
        candidates = sorted(cache_root.glob("chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"))
        candidates += sorted(cache_root.glob("chromium_headless_shell-*/chrome-mac*/headless_shell"))
        for candidate in candidates:
            if candidate.is_file():
                try:
                    return playwright_instance.chromium.launch(executable_path=str(candidate))
                except Exception:
                    continue
        raise RuntimeError(
            "Could not launch Chromium and no usable cached executable was found under "
            f"{cache_root}. Run: venv/bin/playwright install chromium"
        ) from first_error


def print_summary(results: dict | None, console_errors: list[str]) -> int:
    if not results:
        print("ERROR: window.__testResults was empty/undefined.", file=sys.stderr)
        return 1

    passed = results.get("passed", 0)
    failed = results.get("failed", 0)
    total = results.get("total", passed + failed)
    failures = results.get("failures", [])

    print(f"\n{passed}/{total} passed, {failed} failed\n")

    if failures:
        print("Failures:")
        for f in failures:
            print(f"  FAIL {f.get('suite')} > {f.get('name')}")
            print(f"       {f.get('error')}")

    if console_errors and failed:
        print("\nConsole/page errors observed during the run:")
        for err in console_errors:
            print(f"  {err}")

    return 0 if failed == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--root",
        default=".",
        help="Directory to serve as the HTTP document root, relative to the repo root "
        "(default: repo root; use '_site' to test against a built Jekyll site). Ignored if --url is given.",
    )
    parser.add_argument(
        "--page",
        default=DEFAULT_TEST_PAGE,
        help=f"Path to the test page, relative to --root (default: {DEFAULT_TEST_PAGE}).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Port to serve on (default: an OS-assigned free port). Never 4000.",
    )
    parser.add_argument(
        "--url",
        default=None,
        help="Full URL of an already-running server's test page; skips starting a local server.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=60,
        help="Seconds to wait for window.__testResults.done before failing (default: 60).",
    )
    parser.add_argument(
        "--selftest-fail",
        action="store_true",
        help="Append ?selftest=fail so the deliberately-failing test loads too "
        "(verifies the harness detects failures / exits 1).",
    )
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
