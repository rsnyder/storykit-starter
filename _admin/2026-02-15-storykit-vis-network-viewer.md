---
title: "StoryKit: Network Viewer"
description: How to use the StoryKit Network Viewer to display graph and network diagrams in your Markdown posts.
permalink: /admin/storykit-vis-network-viewer
date: 2026-02-15
media_subpath: /assets/posts/storykit
toc: true
order: 26
storykit:
    mode: flat
    toolbar: false
---
<style>
    @media (min-width: 1650px) {
        #main-wrapper>.container {
            max-width: 1600px;
            padding-left: 1.75rem !important;
            padding-right: 1.75rem !important;
        }
    }
    .example {
        display: grid;
        gap: 1rem;
    }
    @media (min-width: 640px) {
        .example {
            grid-template-columns: 1fr 1fr;
        }
    }
    iframe {
        width: 100%;
    }
    pre .s2,
    pre .sx {
        white-space: pre-wrap;
        word-break: break-word;
    }
    .attribute > h2,
    .attribute > h3,
    .attribute > h4 {
        color: red;
        font-weight: bold;
    }
</style>

## Overview

The StoryKit Network Viewer renders interactive **node-and-edge diagrams** directly in your post. It is suited to any content where relationships between things matter: family trees, concept maps, dependency graphs, organisational charts, and similar structures.

The viewer is powered by [vis.js](https://visjs.github.io/vis-network/docs/network/), a library designed for large, interactive networks. Nodes can be dragged, the whole graph can be panned and zoomed, and the layout is computed automatically from the data you provide.

You define the graph using a simple CSV block placed in the same post. No separate files, no JSON configuration — just rows of comma-separated values written directly in Markdown.

### Preview Mode and Expanded Mode

The viewer operates in two modes:

**Preview mode** (default) shows the graph embedded in the page at a compact size. A set of controls in the caption bar lets the reader open additional information or expand the viewer.

**Expanded mode** opens when the reader clicks the expand icon in the caption bar. The graph is shown in a larger dialog at full screen width, making it easier to explore complex networks.

---

## Defining Graph Data

Graph data is written as a fenced code block in your post with the `id` matching the viewer's `dataid` attribute (with `-csv` appended). Each row in the block defines either a node or an edge.

### Node rows

```
node, id, label
```

| Column | Description |
|---|---|
| `node` | Literal word `node` — identifies this row as a node definition |
| `id` | A unique identifier for this node. Used when defining edges. |
| `label` | The text displayed on the node in the diagram |

### Edge rows

```
edge, from, to, label
```

| Column | Description |
|---|---|
| `edge` | Literal word `edge` — identifies this row as an edge definition |
| `from` | The `id` of the node where the edge starts |
| `to` | The `id` of the node where the edge ends |
| `label` | *(optional)* Text displayed on the edge itself |

Blank lines and lines that do not start with `node` or `edge` are ignored, so you can add spacing for readability.

---

## Attributes

### Required Attributes

You must provide a **dataid** attribute (or allow the viewer to locate its data automatically — see [Automatic Data Lookup](#automatic-data-lookup) below).

---

#### dataid
{: .attribute }

The identifier used to locate the CSV data block in the page. The viewer looks for an element with an `id` equal to this value followed by `-csv`.

    dataid="my-graph"

If your `dataid` is `my-graph`, name your data block `my-graph-csv`.

---

### Optional Attributes

---

#### caption
{: .attribute }

Text displayed in the caption bar below the viewer. Supports Markdown inline formatting.

    caption="Relationships between key figures"

---

#### aspect
{: .attribute }

Controls the height of the viewer iframe by setting its CSS `aspect-ratio`. Expressed as a decimal (width divided by height). Defaults to a wide landscape ratio if omitted.

    aspect="1.5"
    aspect="1"

Use `aspect="1"` for a square viewer, `aspect="0.75"` for a taller portrait layout.

---

#### id
{: .attribute }

An HTML `id` applied to the iframe element. Not normally required unless you need to target the viewer with CSS or JavaScript.

    id="network1"

---

## Automatic Data Lookup

If you omit `dataid`, the viewer asks the parent page for its own iframe `id` and then looks for a data element named `{id}-csv`. This means you can let StoryKit assign the id automatically and name your data block to match.

In practice it is simpler to set `dataid` explicitly so the relationship between viewer and data is obvious in your Markdown source.

---

## Examples

### Simple Example

This example draws a small graph showing three people and the relationships between them.

The data block uses the id `people-graph-csv` to match `dataid="people-graph"` on the viewer.

<div class="example">

<div markdown="1">
{% raw %}
```liquid
{% include embed/vis-network.html
    dataid="people-graph"
    caption="A simple relationship graph"
    aspect="1.2"
%}
```
{: .nolineno }
{% endraw %}

~~~markdown
```
{: #people-graph-csv }
node, alice, Alice
node, bob, Bob
node, carol, Carol
edge, alice, bob, knows
edge, bob, carol, manages
edge, alice, carol, mentors
```
~~~
{: .nolineno }

</div>

<div>
{% include embed/vis-network.html
    dataid="people-graph"
    caption="A simple relationship graph"
    aspect="1.2"
%}
</div>

</div>

```
{: #people-graph-csv }
node, alice, Alice
node, bob, Bob
node, carol, Carol
edge, alice, bob, knows
edge, bob, carol, manages
edge, alice, carol, mentors
```

The graph is interactive — nodes can be dragged to rearrange the layout. The viewer computes an initial layout automatically.

---

### Concept Map Example

This example shows a concept map connecting a central idea to related topics.

<div class="example">

<div markdown="1">
{% raw %}
```liquid
{% include embed/vis-network.html
    dataid="concepts"
    caption="Core concepts and their relationships"
    aspect="1"
%}
```
{: .nolineno }
{% endraw %}

~~~markdown
```
{: #concepts-csv }
node, core,    Digital Humanities
node, text,    Text Analysis
node, viz,     Visualization
node, data,    Data Curation
node, collab,  Collaboration
edge, core, text,   includes
edge, core, viz,    includes
edge, core, data,   requires
edge, core, collab, enables
edge, text, viz,    informs
edge, data, text,   supports
```
~~~
{: .nolineno }

</div>

<div>
{% include embed/vis-network.html
    dataid="concepts"
    caption="Core concepts and their relationships"
    aspect="1"
%}
</div>

</div>

```
{: #concepts-csv }
node, core,    Digital Humanities
node, text,    Text Analysis
node, viz,     Visualization
node, data,    Data Curation
node, collab,  Collaboration
edge, core, text,   includes
edge, core, viz,    includes
edge, core, data,   requires
edge, core, collab, enables
edge, text, viz,    informs
edge, data, text,   supports
```

Edge labels describe the nature of each relationship. Extra spaces in the CSV are ignored, so you can align columns for readability.

---

## Data Block Reference

The data block is a standard Markdown fenced code block with a Kramdown `id` attribute applied to it. The id must follow this naming convention:

```
{dataid}-csv
```

For example, if `dataid="family-tree"`, the block must be:

~~~markdown
```
{: #family-tree-csv }
node, ...
edge, ...
```
~~~

### Row Format Summary

| Row type | Format | Required columns |
|---|---|---|
| Node | `node, id, label` | All three |
| Edge | `edge, from, to` | First three; `label` is optional |
| Edge with label | `edge, from, to, label` | All four |

### Rules

- Each node `id` must be unique within the graph.
- Edge `from` and `to` values must match existing node ids.
- Column order is fixed — do not reorder columns.
- Leading and trailing whitespace around values is trimmed automatically.
- Lines that do not start with `node` or `edge` are silently ignored.
