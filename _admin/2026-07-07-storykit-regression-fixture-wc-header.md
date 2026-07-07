---
title: "StoryKit: wc: Header-Image Regression Fixture"
description: "Render-regression fixture (hidden from the admin index) exercising the Wikimedia Commons wc: shorthand in front-matter image.path and in a plain Markdown image. Not author documentation."
permalink: /admin/storykit-regression-fixture-wc-header
date: 2026-07-07
toc: false
order: 999
hidden: true
storykit:
    mode: flat
    toolbar: false
image:
  path: wc:Monument_Valley,_Utah,_USA.jpg
  alt: Monument Valley header via the wc shorthand
---

This page is a **render-regression fixture** (`tests/render/corpus.json` →
`wc-header-fixture`). It pins the Wikimedia Commons `wc:` shorthand resolution
added to `_includes/refactor-content.html`:

1. The front-matter `image.path: wc:…` above must render the post header image
   from an `upload.wikimedia.org` thumb URL.
2. A plain Markdown image must resolve the same way:

![Monument Valley via the wc shorthand](wc:Monument_Valley,_Utah,_USA.jpg)

If either regresses, `tools/render_regression.py --check` fails on this entry.
