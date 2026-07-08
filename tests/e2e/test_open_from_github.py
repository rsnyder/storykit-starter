"""Open-from-GitHub feature (doclist "Open…", ?open= boot param, link drop).

Drives editor/index.html against the stateful GitHubMock, hermetically:
  a. booting with ?repo/&branch/&open= opens the remote file as a bound,
     sha-anchored document and strips the params from the URL,
  b. a second boot with the same params reuses the existing document
     (dedupe — no duplicate list entries, local content preserved),
  c. dropping a github.com blob URL onto the document list opens the file
     (the bookmarklet emits exactly the URL form this exercises).
"""

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_regression as rr  # noqa: E402
from github_mock import GitHubMock  # noqa: E402

from test_m5_sync import (  # noqa: E402  (shared fixtures/helpers)
    browser, site_dir, _hermetic_page,
)

REMOTE = "---\ntitle: Already on GitHub\n---\n\nRemote body.\n"
PATH = "_posts/2026-03-03-existing.md"
OWNER, REPO_NAME = "acme-corp", "open-site"


def _doc_summary(page):
    return page.evaluate(
        """async () => {
            const app = await import('/editor/app.js');
            const docs = await app.modules.store.docs.list();
            return docs.map((d) => ({
                path: d.path, title: d.title, content: d.content,
                bound: !!(d.github && d.github.owner),
                sha: d.github && d.github.sha,
            }));
        }""")


def test_open_param_boots_into_the_remote_file(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            mock = GitHubMock(page, owner=OWNER, repo=REPO_NAME)
            mock.set_remote("main", PATH, REMOTE)
            page.goto(
                f"{base_url}/editor/index.html?repo={OWNER}/{REPO_NAME}&branch=main&open={PATH}",
                wait_until="load", timeout=rr.POLL_TIMEOUT_MS)
            page.wait_for_selector(".cm-content", timeout=30_000)

            docs = _doc_summary(page)
            assert len(docs) == 1 and docs[0]["path"] == PATH
            assert docs[0]["title"] == "Already on GitHub"
            assert docs[0]["content"] == REMOTE
            assert docs[0]["bound"] and docs[0]["sha"]

            # params stripped so a later plain reload behaves normally
            assert "open=" not in page.url and "repo=" not in page.url
        finally:
            context.close()


def test_second_boot_with_same_params_dedupes(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            mock = GitHubMock(page, owner=OWNER, repo=REPO_NAME)
            mock.set_remote("main", PATH, REMOTE)
            url = f"{base_url}/editor/index.html?repo={OWNER}/{REPO_NAME}&branch=main&open={PATH}"
            page.goto(url, wait_until="load", timeout=rr.POLL_TIMEOUT_MS)
            page.wait_for_selector(".cm-content", timeout=30_000)

            # local edit distinguishes the record from a re-fetched copy
            page.evaluate(
                """async () => {
                    const app = await import('/editor/app.js');
                    const [d] = await app.modules.store.docs.list();
                    await app.modules.store.docs.update(d.id, { content: d.content + 'LOCAL EDIT\\n' });
                }""")

            page.goto(url, wait_until="load", timeout=rr.POLL_TIMEOUT_MS)
            page.wait_for_selector(".cm-content", timeout=30_000)
            docs = _doc_summary(page)
            assert len(docs) == 1, f"expected dedupe, got {len(docs)} docs"
            assert docs[0]["content"].endswith("LOCAL EDIT\n"), "local content preserved"
        finally:
            context.close()


def test_dropping_a_github_blob_url_on_the_doclist_opens_it(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            mock = GitHubMock(page, owner=OWNER, repo=REPO_NAME)
            mock.set_remote("main", PATH, REMOTE)
            page.goto(f"{base_url}/editor/index.html", wait_until="load",
                      timeout=rr.POLL_TIMEOUT_MS)
            page.wait_for_selector("#new-doc:not([disabled])", timeout=rr.POLL_TIMEOUT_MS)

            blob = f"https://github.com/{OWNER}/{REPO_NAME}/blob/main/{PATH}"
            page.evaluate(
                """(blob) => {
                    const dt = new DataTransfer();
                    dt.setData('text/uri-list', blob);
                    document.getElementById('doclist-mount').dispatchEvent(
                        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
                }""", blob)
            page.wait_for_selector(".cm-content", timeout=30_000)

            docs = _doc_summary(page)
            assert len(docs) == 1 and docs[0]["path"] == PATH and docs[0]["bound"]
            assert docs[0]["content"] == REMOTE
        finally:
            context.close()
