/**
 * editor/welcome.js — the first-run sample document.
 *
 * Seeded ONCE by app.js when the document store is empty on first visit
 * (prefs.welcomeSeeded guards re-creation, so deleting it is respected).
 * Opens in Split view: the Markdown source and the rendered page teach
 * side by side. Every tag below must stay AUDIT-CLEAN — the unit suite
 * runs computeDiagnostics over this content and fails on any finding.
 */

export const WELCOME_TITLE = 'Welcome to StoryKit';

export const WELCOME_CONTENT = `---
title: Welcome to StoryKit
description: A working tour of the StoryKit editor — edit anything and watch the preview.
image:
  path: wc:Monument_Valley,_Utah,_USA.jpg
  alt: Monument Valley at dusk
---

## What you're looking at

**StoryKit** turns Markdown into interactive visual narratives — essays that mix
prose with zoomable images, maps, video, and text-driven interactions. This
editor is the whole workshop: write on the left, see the published page on the
right, and commit straight to GitHub when you're happy.

This document is a *working example*. Edit anything — the preview updates as
you type. Delete it whenever you like; it won't come back.

## Markdown, briefly

Plain paragraphs with **bold**, *italics*, and [links](https://www.markdownguide.org/basic-syntax/)
work as you'd expect. Lists too:

- Headings create the page outline (and drive scroll sync in Split view)
- A footnote looks like this[^1]
- Spelling is checked in prose only — tags and code are left alone

[^1]: Footnotes collect at the bottom of the published page.

New to Markdown, or want the full syntax? The [Markdown Guide](https://www.markdownguide.org/)
is an excellent reference.

## Viewers: where StoryKit begins

An image viewer, straight from Wikimedia Commons via the \`wc:\` shorthand —
**click it** in the preview to open the zoomable version:

{% include embed/image.html id="valley" src="wc:Monument_Valley,_Utah,_USA.jpg" caption="Monument Valley — click to zoom, shift-drag in the expanded view to copy region coordinates" %}

A map viewer:

{% include embed/map.html id="tour" center="36.9980, -110.0985" zoom="10" caption="Monument Valley Navajo Tribal Park" %}

## Action links: text that drives the media

These links target the viewers above by their \`id\` — try them in the preview.
Zoom the image to [the western butte](valley/zoomto/pct:10,20,35,55), or fly the
map to [Gouldings Lodge](tour/flyto/37.0068,-110.2049,14).

## Linked entities

Name-drop with context: [Ansel Adams](Q60809) renders with an info popup on the
published page (select any text and press ⌘⇧K to link your own).

## Where to go next

- **Open your own post**: the *Open…* button above the document list takes a
  GitHub URL — or drag a file link straight in from GitHub.
- **Connect GitHub**: any document's *Sync with GitHub* button walks you
  through the one-time token setup.
- **Audit**: the toolbar's *Audit* button checks tags, links, front matter,
  and spelling in one report.
- **Help**: the **?** in the top bar covers everything else.
`;
