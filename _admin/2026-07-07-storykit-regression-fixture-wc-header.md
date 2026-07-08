---
title: "StoryKit: wc: Header-Image Regression Fixture"
description: "Render-regression fixture (hidden from the admin index) exercising the Wikimedia Commons wc: shorthand in front-matter image.path and in a plain Markdown image. Not author documentation."
permalink: /admin/storykit-regression-fixture-wc-header
date: 2026-07-07
toc: false
order: 999
hidden: true
media_subpath: /assets/posts/monument-valley
storykit:
    mode: flat
    toolbar: false
image:
  path: wc:Sachsenheim_-_Ochsenbach_-_Geigersberg_-_nördlicher_Teil_von_SSO_im_März.jpg
  alt: Non-ASCII Commons filename header via the wc shorthand
---

This page is a **render-regression fixture** (`tests/render/corpus.json` →
`wc-header-fixture`). It pins the Wikimedia Commons `wc:` shorthand resolution
added to `_includes/refactor-content.html`:

1. The front-matter `image.path: wc:…` above must render the post header image
   from an `upload.wikimedia.org` thumb URL.
2. A plain Markdown image must resolve the same way:

![Monument Valley via the wc shorthand](wc:Monument_Valley,_Utah,_USA.jpg)

3. A viewer include with a **plain local filename** must resolve through
   `media_subpath` — a bare `Word.ext` value must NOT be mistaken for a
   dotted Liquid variable reference (skrender `evalLiquidValue`):

{% include embed/image.html src="Monument_Valley.jpg" %}

If any of these regress, `tools/render_regression.py --check` fails on this entry.

A non-ASCII filename in a Markdown image (UTF-8 md5 path regression —
`ö`/`ä` must hash like MediaWiki, not as mangled UTF-16 units):

![Geigersberg im März](wc:Sachsenheim_-_Ochsenbach_-_Geigersberg_-_nördlicher_Teil_von_SSO_im_März.jpg)
