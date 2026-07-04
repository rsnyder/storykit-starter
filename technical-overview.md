# StoryKit Code Base Overview

StoryKit is a static-site authoring and display framework built on top of the Jekyll Chirpy theme. It extends a conventional Markdown-based Jekyll site into a lightweight interactive publishing environment for narrative web pages that combine prose, media, geospatial content, embedded viewers, and scroll-triggered interactions.

The primary goal of StoryKit is to support “minimal computing” authorship: non-technical and semi-technical authors should be able to create rich, interactive web stories using mostly Markdown, YAML front matter, and simple declarative markup, without needing to write JavaScript, HTML, or complex component code. The system is intended to preserve the simplicity, portability, and long-term maintainability of a static site while still enabling sophisticated reader experiences such as image exploration, maps, video embeds, audio, diagrams, and scrollytelling.

StoryKit builds on the standard Jekyll content model but introduces an extended authoring layer in which Markdown narratives can declare interactive viewer components using Liquid include tags. These viewer declarations are parsed during the Jekyll build and transformed into iframe-based embedded components. The iframe approach isolates viewer implementation details from the surrounding narrative page, allowing the framework to support multiple viewer types while keeping the authoring surface relatively simple.

The framework supports interactive viewers such as image viewers, map viewers, video viewers, and other embeddable components. These viewers can be placed inline in a traditional narrative page or associated with specific narrative sections for use in scroll-driven layouts. Viewers are typically configured declaratively through include parameters, front matter values, or structured data referenced by the page. The intention is that authors describe what they want to display and how it should behave, while the framework handles rendering, layout, iframe creation, and interaction wiring.

A key feature of StoryKit is the ability for narrative text to trigger viewer actions. Links can be configured to send commands to the active viewer. These commands may animate or update the viewer state, such as panning or zooming a map, focusing on a specific geographic feature, moving an image viewer to a region of interest, cueing a video segment, or otherwise changing the visual context in response to the reader’s progress through the text. This makes the prose itself an interface for guiding the reader through visual and spatial evidence.

StoryKit supports two primary display modes.

In **flat mode**, the page behaves like a traditional web page. Narrative text and viewer components typically appear in normal document flow. This mode is appropriate for simpler stories, documentation pages, tutorials, and pages where the interaction model does not require a fixed visual panel.  In cases where viewers are to be floated to the right or left of the page with text wrapped around the viewer, the ordering of the text and viewer declaration may reversed in the Markdown.

In **two-column mode**, the page provides a scrollytelling interface. The left column contains the narrative text. The right column contains one or more viewer components and remains fixed or sticky while the reader scrolls. As the reader moves through the narrative, the currently active text section determines which viewer is shown in the right column and what state or animation should be applied to it. This layout allows the text to guide the reader through a sequence of visual states while maintaining a stable viewing area.

The two-column mode pairs narrative text with viewers by document order: viewer declarations appear directly after the paragraph they accompany, and as the reader scrolls, the framework treats each narrative paragraph as a "step" (via scrollama) and mirrors the nearest preceding viewer declaration into the sticky right-column panel. The lookup is section-aware — when a step's own section contains no viewer, the search continues through enclosing and preceding sections. This interaction layer is responsible for observing scroll position, managing active states, switching or updating iframe viewers, and sending commands between the host page and the embedded components. Display-mode switching (including scrollytelling setup and teardown) is centralized in a single controller (`setViewMode`/`initStoryKit` in `assets/js/storykit.js`).

StoryKit is implemented as a Jekyll-based framework rather than a single-page application. Content authors write Markdown files, typically with YAML front matter, and use Liquid include tags to invoke StoryKit-specific components. The build process produces static HTML, CSS, JavaScript, and iframe pages that can be hosted on GitHub Pages or another static hosting environment. This architecture favors durability, inspectability, low hosting cost, and compatibility with existing static-site workflows.

Because StoryKit is layered on the Chirpy theme, it inherits Chirpy’s site structure, layout conventions, collections, navigation patterns, styling assumptions, and build pipeline. StoryKit extends this base with custom layouts, includes, JavaScript, CSS, collections, and possibly data files that support interactive storytelling. Refactoring work should therefore distinguish between inherited Chirpy behavior, StoryKit-specific extensions, and project-specific content or configuration.

The code base includes support for author-facing documentation and tutorials. These materials are stored in an `admin` collection and are intended to help authors learn the StoryKit syntax, available viewer types, layout modes, and interaction patterns. The documentation is part of the site itself, making the framework somewhat self-documenting and allowing authors to consult examples within the same environment they use for publishing.

A central architectural feature of StoryKit is that the Markdown document is transformed into a hierarchical layout model. Markdown heading levels are not treated merely as visual typography; they define nested semantic section blocks. For example, an `h1` establishes a top-level story section, an `h2` creates a subsection within that section, an `h3` creates a deeper nested subsection, and so on.

This heading-derived hierarchy becomes part of the page structure used by StoryKit for layout, navigation, scrollytelling behavior, viewer association, and interaction state management. Rather than treating the Markdown file as a flat stream of rendered HTML, the framework interprets the heading structure as a tree of narrative sections. Each section may contain prose, viewer declarations, interaction triggers, metadata, and child sections.

The section hierarchy is built client-side by `restructureMarkdownToSections` (assets/js/storykit.js) and runs in **both** display modes. Every generated section carries a stable id (kramdown's auto-generated heading id, moved to the section, or a deterministic `sk-section-<n>` fallback), making sections reliable targets for linking and navigation. In two-column mode the scroll steps are narrative paragraphs rather than whole sections, but the step selectors and the viewer-source lookup traverse the section tree, so the hierarchy determines which viewer is mirrored into the panel as the reader moves through nested sections.

The heading hierarchy also supports authoring simplicity. Authors can organize stories using familiar Markdown conventions, while StoryKit converts that structure into the more complex HTML, CSS, and JavaScript scaffolding required for interactive presentation. This preserves a Markdown-first authoring model while allowing the framework to generate semantically meaningful layout containers around the narrative content.

From a refactoring perspective, this heading-to-section transformation should be treated as a core part of the StoryKit rendering pipeline. It is not simply a styling concern. The logic that identifies headings, creates nested section containers, assigns section identifiers, preserves parent-child relationships, and attaches viewer or interaction metadata should be clearly separated, well documented, and consistently applied across display modes.

The framework also includes a preview tool designed to improve the authoring workflow. In a standard Jekyll/GitHub Pages workflow, authors may need to commit changes and wait for a remote build before seeing the result, which can take minutes and slows experimentation. StoryKit’s preview tool allows authors to view in-process changes more quickly, without waiting for the full Jekyll/GitHub rebuild cycle. This preview capability is important because interactive stories often require iterative adjustment of viewer parameters, scroll behavior, image regions, map extents, and narrative-triggered commands.

From a refactoring perspective, the code base should be understood as having several overlapping concerns:

1. **Static-site foundation**
   The underlying Jekyll and Chirpy structure, including layouts, includes, collections, configuration, assets, navigation, and theme inheritance.

2. **Authoring syntax layer**
   The StoryKit-specific conventions that extend Markdown through Liquid includes, front matter, structured parameters, and possibly data files.

3. **Viewer declaration and rendering layer**
   The logic that turns author declarations into rendered iframe components, viewer containers, placeholders, layout regions, and associated metadata.

4. **Viewer implementation layer**
   The individual iframe-based viewers and their supporting JavaScript, CSS, and configuration. Each viewer type may have its own internal behavior and command vocabulary.

5. **Narrative-to-viewer interaction layer**
   The JavaScript and markup conventions that allow narrative text to trigger viewer commands, animations, state changes, and active-section updates.

6. **Layout and display-mode layer**
   The rendering logic and CSS that support flat pages, two-column scrollytelling pages, fixed or sticky viewer panels, responsive behavior, and transitions between viewer states.

7. **Preview and authoring workflow layer**
   The tooling that lets authors preview changes quickly during drafting, independent of the normal GitHub Pages deployment cycle.

8. **Documentation and tutorial layer**
   The `admin` collection and related pages that explain how authors use StoryKit and provide canonical examples of supported patterns.

9. **Markdown structure and section hierarchy layer**
    The logic that transforms a Markdown document from a flat sequence of headings and content into a nested hierarchy of semantic section blocks. This layer interprets heading levels as structural boundaries, creates parent-child section relationships, assigns identifiers or metadata to generated sections, and provides the document structure used by layout, scrolling behavior, navigation, and viewer association.

The framework’s design intentionally separates author intent from implementation complexity. Authors should be able to express interactive story behavior declaratively, while the framework handles iframe embedding, layout, scroll tracking, message passing, viewer state management, and responsive presentation. Maintaining that separation is a major architectural priority.

Any analysis or refactoring of StoryKit should preserve the core authoring model: Markdown-first, declarative, static-site compatible, and friendly to authors who are not professional developers. Improvements should ideally simplify the code structure, clarify the boundaries between Chirpy and StoryKit, reduce duplication among viewer components, formalize the command/state model for viewer interactions, improve documentation consistency, and make the preview workflow more reliable.

The most important architectural questions for the code base are likely to include:

* How clearly are StoryKit-specific extensions separated from the underlying Chirpy theme?
* Are viewer declarations consistently parsed and rendered across viewer types?
* Is the iframe messaging or command mechanism documented and implemented consistently?
* Are flat mode and two-column mode handled through clean layout abstractions, or are they interwoven in ways that make maintenance difficult?
* Is the authoring syntax stable, predictable, and well documented?
* Are viewer parameters validated or normalized before rendering?
* Is scroll-triggered behavior centralized, or duplicated across layouts and components?
* Are there reusable abstractions for common viewer behavior such as initialization, command handling, resize handling, active-state management, and error handling?
* Does the preview tool use the same rendering path as the production site, or does it introduce parallel behavior that could drift over time?
* Are documentation examples treated as testable or semi-canonical examples of framework behavior?
* Is the Markdown heading hierarchy converted into a consistent nested section model?
* Are generated section IDs stable, predictable, and safe for linking, navigation, and interaction targeting?
* Is the heading-to-section transformation handled in one place, or duplicated across layouts, includes, JavaScript, and preview tooling?
* Does the generated section hierarchy remain valid when authors skip heading levels, repeat headings, or mix viewer declarations between headings?
* Are viewer declarations associated with the correct section in both flat and two-column modes?
* Does the preview tool use the same heading-to-section transformation as the production build?

StoryKit should be treated as both a static-site theme extension and an authoring framework. Its long-term maintainability depends on keeping those two roles aligned: the code should remain technically coherent for developers while preserving a simple, stable, and approachable authoring experience for content creators.
