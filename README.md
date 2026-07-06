# StoryKit Starter

A Jekyll website template for creating **interactive visual narratives** — essays that combine Markdown prose with zoomable images, maps, video, network diagrams, and text-driven media interactions. It is built on the **[Chirpy](https://github.com/cotes2020/jekyll-theme-chirpy)** theme and extended with the **StoryKit** component layer.

StoryKit evolved from [Juncture](https://labs.jstor.org/projects/juncture/), a digital humanities collaboration between JSTOR Labs and Dumbarton Oaks, with one straightforward goal: *enable students and scholars to create interactive visual narratives using Markdown — without requiring coding skills.*

The framework is explicitly designed for **web-only authoring**: authors need nothing but a browser and a GitHub account. Content is written in GitHub's web editor, previewed in seconds with a bookmarklet-based preview tool, and published automatically by GitHub Pages. No local installation of any kind is required to author and publish.

**Live demo and documentation:** <https://rsnyder.github.io/storykit-starter>

---

## Key Features

**Viewer components** — added to a post with a one-line Liquid include tag:

* **Image viewer** — click-to-open deep zoom and pan; built-in support for Wikimedia Commons (automatic captions, attribution, and licensing) and IIIF manifests
* **Image compare viewer** — before/after pairs with a draggable divider and an interactive alignment tool
* **Map viewer** — markers, multiple basemaps, GeoJSON overlays, and historical map layers via Allmaps; locations can be given as coordinates or Wikidata Q-ids
* **YouTube viewer** — clean click-to-play previews with timed start/end playback
* **Network viewer** — node-and-edge relationship diagrams from a few lines of CSV placed right in the post
* **Iframe viewer** — embed any external page (Timeline JS, Internet Archive, Datawrapper, …)

**Text-driven interaction:**

* **Action links** — ordinary Markdown links that control viewers: zoom an image to a region, fly a map to a location, jump a video to a timestamp
* **Entity popups** — link a phrase to a Wikidata Q-id and readers get an in-place information popover instead of a trip to Wikipedia

**Layout and workflow:**

* **Two display modes** — a traditional *flat* page layout (with automatic viewer floating) and a two-column *scrollytelling* layout where media stays pinned while the text scrolls
* **Live preview tool** — renders a committed post directly from the repository in seconds, bypassing the 1–5 minute GitHub Pages rebuild
* **Self-documenting** — the site ships with a full set of author guides at `/admin`, including a start-to-finish tutorial that assumes no prior GitHub, Jekyll, or Markdown experience
* **Everything Chirpy provides** — search, tags and categories, dark mode, Mermaid diagrams, MathJax equations, responsive typography

---

## Getting Started

### Option 1 — Copy the template (recommended)

Creating a repository from the template gives you a clean copy with no shared git history — the right choice for classes, projects, and production sites.

1. Go to <https://github.com/rsnyder/storykit-starter>, click **Use this template → Create a new repository**, and give your repository a name.
2. In the new repository, go to **Settings → Pages** and, under "Build and deployment", set **Source** to **GitHub Actions**.
3. Back on the **Code** tab, open `_config-template.yml` and click the pencil icon to edit it:
   * Change the filename to `_config.yml` in the filename input at the top of the page.
   * **url** — replace `<your-github-username>` with your GitHub username
   * **baseurl** — set to your repository name with a leading `/` (e.g. `/my-stories`); leave empty if publishing to `<username>.github.io` itself
   * **github.username** and **github.repository** — your GitHub username and repository name (these drive repository links and the preview tool)
   * **title**, **tagline**, **description**, **avatar** — optional site branding; all can be updated later
4. Commit the file. GitHub automatically builds and deploys the site — the first build takes a couple of minutes — after which it is live at `https://<your-github-username>.github.io/<repository-name>`.

### Option 2 — Fork

Fork the repository instead if you want to keep a git connection to this project so you can pull in future framework updates (**Sync fork** on GitHub). The configuration steps are the same as above, starting at step 2. Note that a fork is tied to the upstream repository and is less suited to diverging content-heavy sites; for most users the template copy is the better starting point.

### Adding authors

Give each content author write access under **Settings → Collaborators**. Authors work on their own branches and submit pull requests; the live site rebuilds only when changes are merged into `main`.

---

## Authoring Content

Authoring is designed to happen entirely on the web:

1. **Write** — create a Markdown file in `_posts` using GitHub's web editor (copy `_posts/.template.md` to start).
2. **Preview** — click the StoryKit preview bookmarklet to render the committed post in seconds, without waiting for a site rebuild.
3. **Publish** — set `published: true` and open a pull request; the site rebuilds automatically when it is merged.

The complete author documentation is published on the site itself at `/admin` (also reachable by clicking the README icon ![README icon](assets/posts/storykit/readme-icon.png) in the left sidebar footer):

* **[Authoring a Visual Narrative](https://rsnyder.github.io/storykit-starter/admin/storykit-authoring-a-visual-narrative)** — a start-to-finish tutorial assuming no prior GitHub, Jekyll, or Markdown experience
* **[Authors Guide](https://rsnyder.github.io/storykit-starter/admin/storykit-authors-guide)** — the day-to-day web authoring workflow
* **[Preview Setup](https://rsnyder.github.io/storykit-starter/admin/storykit-preview-setup)** — one-time bookmarklet installation
* Reference guides for every viewer, action links, formatting, display modes, and troubleshooting

For a working example that uses most of the framework's features on one page, see the [Monument Valley post](https://rsnyder.github.io/storykit-starter/monument-valley/) and its [source](_posts/2026-01-10-monument-valley.md).

---

## Running Locally (optional)

You do not need a local environment to author content — that is the point of the framework. A local Jekyll server is only useful if you are developing the framework itself or customizing layouts, includes, or styles.

Prerequisites: [Ruby](https://www.ruby-lang.org/) 3.x with Bundler.

```bash
bundle install
bundle exec jekyll serve --livereload
```

The site is served at `http://127.0.0.1:4000<baseurl>/` (e.g. `http://127.0.0.1:4000/storykit-starter/`) and rebuilds automatically as files change.

For framework development, the preview tool can also load JavaScript and CSS from your local server instead of the deployed site — append `?dev` to the preview URL (see the [Preview Setup guide](https://rsnyder.github.io/storykit-starter/admin/storykit-preview-setup)).

---

## Repository Structure

| Path | Contents |
|---|---|
| `_posts/` | Content posts, including `.template.md` and the Monument Valley example |
| `_admin/` | Author documentation published at `/admin` |
| `_includes/embed/` | Liquid include wrappers authors invoke (`image.html`, `map.html`, …) |
| `assets/components/` | Self-contained iframe viewer implementations |
| `assets/js/` | StoryKit runtime: DOM restructuring, action-link wiring, parent↔iframe messaging, display modes |
| `preview/` | The live preview tool |
| `_config.yml` / `_config-template.yml` | Site configuration and the template new sites start from |
| `docs/`, `technical-overview.md` | Developer documentation: architecture, dependencies, postMessage protocol |
| `tools/` | Maintenance scripts |

The design goal is separation of concerns: authors work in Markdown, viewer logic lives in isolated iframe pages, and Liquid includes bridge the two. Authors never need to understand how the components are implemented — only how to invoke them.

---

## Credits

* [Chirpy](https://github.com/cotes2020/jekyll-theme-chirpy) provides the theme foundation: layouts, navigation, typography, search, and the build pipeline.
* StoryKit's approach to Markdown-first visual narratives originated with [Juncture](https://labs.jstor.org/projects/juncture/) (JSTOR Labs / Dumbarton Oaks).
