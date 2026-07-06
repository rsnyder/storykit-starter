/**
 * editor/viewer-catalog.js  (WP-0.2, pure data — no imports, no DOM)
 *
 * Bundled attribute catalog for the six StoryKit viewer includes under
 * `_includes/embed/*.html`. Ground truth for attribute names is the
 * `include.<attr>` usages in those templates (see
 * `tools/check_viewer_catalog.py`, which fails CI on drift); the `doc`
 * strings are condensed from the matching `_admin/2026-02-15-storykit-*`
 * guides and `_admin/2026-02-15-storykit-action-links.md`.
 *
 * Consumed by editor/lang-storykit.js (WP-2.4) for:
 *   - FR-EDIT.3 attribute-name autocomplete (name, type, doc)
 *   - FR-EDIT.4 lint (unknown attribute; action-link id/action validation
 *     via the `actions` argument grammar)
 *
 * `catalog` below is written as a strict JSON object literal (double-quoted
 * keys/strings, no comments, no trailing commas, no template
 * interpolation) so that `tools/check_viewer_catalog.py` can extract it
 * with a brace-matcher and parse it with `json.loads` — do not introduce
 * JS-only syntax (single quotes, computed keys, comments, trailing commas)
 * inside the object literal below.
 */

// prettier-ignore
export const catalog = {
  "embed/image.html": {
    "doc": "Zoomable, pannable image viewer with first-class Wikimedia Commons and IIIF support.",
    "attrs": {
      "src": {"type": "string", "required": false, "doc": "Image to display — local path, full URL, or a wc:File_Name.jpg Wikimedia Commons shorthand. One of src or manifest is required."},
      "manifest": {"type": "string", "required": false, "doc": "IIIF manifest URL. One of src or manifest is required."},
      "seq": {"type": "number", "required": false, "doc": "Selects the Nth image in a multi-image IIIF manifest (default 1)."},
      "caption": {"type": "string", "required": false, "doc": "Text displayed below the image."},
      "attribution": {"type": "string", "required": false, "doc": "Credit line shown with the image (fetched automatically for Commons images)."},
      "class": {"type": "string", "required": false, "doc": "Size and position words, e.g. \"medium right float\"."},
      "cover": {"type": "boolean", "required": false, "doc": "Fills its space like a cover photo. Accepts true/1/yes/on."},
      "region": {"type": "string", "required": false, "doc": "Starting zoom region, IIIF-like: full | x,y,w,h | pct:x,y,w,h."},
      "rotate": {"type": "enum", "values": ["90", "180", "270"], "required": false, "doc": "Rotates the image in degrees; prefix with ! to flip first, e.g. !90."},
      "id": {"type": "string", "required": false, "doc": "Viewer id — required to target with a zoomto action link."},
      "aspect": {"type": "string", "required": false, "doc": "Width-to-height ratio, e.g. 1200/630 or 1."},
      "width": {"type": "number", "required": false, "doc": "Requested pixel width for the in-page image (the expanded high-res viewer is unaffected)."}
    },
    "actions": {
      "zoomto": {"args": "pct:x,y,w,h | x,y,w,h", "doc": "Zooms/pans to an image region and shows a label (the link text, or a custom label= attribute)."}
    }
  },
  "embed/image-compare.html": {
    "doc": "Before/after image comparison slider with a built-in alignment tool.",
    "attrs": {
      "before": {"type": "string", "required": true, "doc": "Filename or URL of the bottom (revealed-on-drag) image. Alignment params (bx, by, bs) may be appended by the alignment tool."},
      "after": {"type": "string", "required": true, "doc": "Filename or URL of the top (initially visible) image. Alignment params (ax, ay, as) may be appended by the alignment tool."},
      "caption": {"type": "string", "required": false, "doc": "Text displayed below the viewer."},
      "aspect": {"type": "string", "required": false, "doc": "Width-to-height ratio used to size the expanded dialog, e.g. 1.5."},
      "position": {"type": "number", "required": false, "doc": "Initial divider position, percent from the left edge (default 50)."},
      "width": {"type": "number", "required": false, "doc": "Explicit pixel width for the in-page viewer."},
      "height": {"type": "number", "required": false, "doc": "Explicit pixel height for the in-page viewer."},
      "id": {"type": "string", "required": false, "doc": "Viewer id. Image Compare does not currently support action links, so this is rarely needed."},
      "class": {"type": "string", "required": false, "doc": "Size and position words, e.g. \"medium right float\"."}
    }
  },
  "embed/map.html": {
    "doc": "Interactive Leaflet map with markers, GeoJSON/IIIF overlays, and flyto action links.",
    "attrs": {
      "center": {"type": "string", "required": true, "doc": "Map center — lat,lng coordinates or a Wikidata id (e.g. Q852197)."},
      "zoom": {"type": "number", "required": false, "doc": "Initial zoom level, 1-20 (default 8)."},
      "caption": {"type": "string", "required": false, "doc": "Text displayed below the map."},
      "aspect": {"type": "string", "required": false, "doc": "Width-to-height ratio of the map (default 1.0)."},
      "markers": {"type": "string", "required": false, "doc": "Pipe-delimited markers: lat,lng~label~image, or a Wikidata id, per marker."},
      "geojson": {"type": "string", "required": false, "doc": "Pipe-delimited GeoJSON layer URLs, each optionally ~layer-name tagged."},
      "src": {"type": "string", "required": false, "doc": "An image or IIIF resource to use as a map layer."},
      "width": {"type": "number", "required": false, "doc": "Pixel width used when sizing the optional src image/IIIF map layer. Undocumented in the map viewer guide; forwarded to media-url.html the same way embed/image.html uses it."},
      "allmaps": {"type": "string", "required": false, "doc": "An Allmaps id referencing a IIIF image to use as a historical map overlay."},
      "basemap": {"type": "enum", "values": ["OpenStreetMap", "OpenTopoMap", "Esri_WorldPhysical", "Esri_WorldImagery", "CartoDB_Positron"], "required": false, "doc": "Basemap tile layer(s); comma-separate multiple names to add a layer switcher (default OpenStreetMap)."},
      "id": {"type": "string", "required": false, "doc": "Viewer id — required to target with a flyto action link."},
      "class": {"type": "string", "required": false, "doc": "Size and position words, e.g. \"medium right float\"."}
    },
    "actions": {
      "flyto": {"args": "lat,lng,zoom | Qid,zoom", "doc": "Animates the map to coordinates or a Wikidata entity's location at a zoom level; clicking the same link again returns to the prior view."}
    }
  },
  "embed/vis-network.html": {
    "doc": "Node-and-edge network diagram rendered from a CSV data block on the same page.",
    "attrs": {
      "id": {"type": "string", "required": true, "doc": "Viewer id; also the default reference to its CSV data block (<id>-csv)."},
      "caption": {"type": "string", "required": false, "doc": "Text displayed below the diagram."},
      "dataid": {"type": "string", "required": false, "doc": "Id of the CSV data block to use, overriding the <id>-csv convention."},
      "aspect": {"type": "string", "required": false, "doc": "Width-to-height ratio of the viewer (default 1.0)."},
      "class": {"type": "string", "required": false, "doc": "Size and position words, e.g. \"medium right float\"."}
    }
  },
  "embed/youtube.html": {
    "doc": "YouTube video preview that opens a larger expanded player; supports playat/play/pause action links.",
    "attrs": {
      "vid": {"type": "string", "required": true, "doc": "YouTube video id, from ?v= in the video's URL."},
      "caption": {"type": "string", "required": false, "doc": "Text displayed below the video; defaults to the video's YouTube title if omitted."},
      "autoplay": {"type": "boolean", "required": false, "doc": "Begin playback automatically when the expanded viewer opens."},
      "start": {"type": "string", "required": false, "doc": "Playback start time — seconds or h:mm:ss (default 0)."},
      "end": {"type": "string", "required": false, "doc": "Playback stop time — seconds or h:mm:ss (default: plays to the end)."},
      "id": {"type": "string", "required": false, "doc": "Viewer id — required for playat/play/pause action links."},
      "aspect": {"type": "string", "required": false, "doc": "Width-to-height ratio of the in-page preview (default 1.55)."},
      "class": {"type": "string", "required": false, "doc": "Size and position words, e.g. \"medium right float\"."}
    },
    "actions": {
      "playat": {"args": "start[,end] — seconds or h:mm:ss", "doc": "Opens the expanded viewer and plays from start, optionally stopping at end."},
      "play": {"args": "[start] — optional seconds or h:mm:ss", "doc": "Resumes playback, optionally seeking to start first."},
      "pause": {"args": "", "doc": "Pauses playback."}
    }
  },
  "embed/iframe.html": {
    "doc": "General-purpose embed for external pages, exhibits, and widgets in a captioned figure.",
    "attrs": {
      "src": {"type": "string", "required": true, "doc": "URL of the external page to embed."},
      "caption": {"type": "string", "required": false, "doc": "Text displayed below the embedded page."},
      "aspect": {"type": "string", "required": false, "doc": "Width-to-height ratio, e.g. 1.5. If neither aspect nor height is set, the frame uses the browser's default height (usually too short)."},
      "height": {"type": "number", "required": false, "doc": "Explicit frame height in pixels, as an alternative to aspect."},
      "width": {"type": "number", "required": false, "doc": "Explicit frame width in pixels. Normally omitted — the frame fills the available width."},
      "class": {"type": "string", "required": false, "doc": "Size and position words, e.g. \"medium right float\"."},
      "id": {"type": "string", "required": false, "doc": "Frame id. The iframe viewer doesn't support action links, but this can be useful as a link target."}
    }
  }
};

/** Bundled include-path fallback offered by autocomplete before a connected repo's `_includes/embed/` listing is available (FR-EDIT.3). */
export const bundledIncludeList = Object.keys(catalog);

/** Verbatim copy of `_posts/.template.md` — used by editor/doclist.js (WP-2.5) as the new-document seed when unbound (FR-DOC.6). */
export const fallbackTemplate = `---
title: 
description: 
author: 
date: 2026-01-01
categories: [ ]
tags: [ ]
published: true
featured: false
media_subpath: /assets/img
image:
  path: 
  alt: 
---

`;
