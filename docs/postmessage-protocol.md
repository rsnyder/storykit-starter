# StoryKit postMessage protocol

Maintainer-facing specification of the messaging between a StoryKit host
page (a post rendered by `_layouts/post.html`, logic in
`assets/js/storykit.js`) and the iframe viewer components
(`assets/components/*.html`, shared runtime `assets/js/storykit-component.js`).

## Envelope

Every message, in both directions, is a plain object (structured clone —
not a JSON string, though receivers tolerate JSON strings for robustness):

```js
{ type: "storykit:<name>", payload: { ... } }
```

Messages whose `type` does not start with `storykit:` are ignored.

## Origins

Host and components are always same-origin (components are static pages
served by the same site), so:

- Components send to and accept from `location.origin` only
  (override: set `window.SK_TARGET_ORIGIN` before loading the runtime).
- The host accepts messages from `location.origin` only
  (override: edit `allowedMessageOrigins` in `storykit.js`; `null`
  disables the check).

There is no cross-version compatibility concern: host and components
deploy atomically from the same site, so protocol changes are safe as a
single commit that updates both sides.

## Host → component

### `storykit:action`

Sent when a reader clicks an action (trigger) link. See the author-facing
[Action Links reference](/admin/storykit-action-links) for link syntax.

```js
{ type: "storykit:action",
  payload: {
    action: "zoomto" | "flyto" | "playat" | "play" | "pause",
    args:   ["<argument segment>", ...],  // slash-separated link segments after the action
    label:  "<link text or label attribute>"
  } }
```

`args` is a real array of the path segments after the action name.
Because action arguments themselves contain commas (`pct:1,2,3,4`,
`37.02,-110.23,11`, `42,75`), an argument string arrives as **one**
array element; components split it internally as their action requires.

Actions by component:

| Component | Action | args[0] format |
|---|---|---|
| image | `zoomto` | IIIF-style region: `pct:x,y,w,h` or `x,y,w,h`; `label` shown as region label |
| map | `flyto` | `lat,lng,zoom` or `Qxxxx[,zoom]`; repeating the same target restores the prior view |
| youtube | `playat` | `start[,end]`, seconds or `h:mm:ss` |
| youtube | `play` | optional `start` |
| youtube | `pause` | (none) |
| image-compare, vis-network, iframe | — | no actions |

### `storykit:id` (reply to `storykit:getId`)

```js
{ type: "storykit:id", payload: { id: "<iframe id or data-id>" } }
```

### `storykit:element` (reply to `storykit:getElementById`)

```js
{ type: "storykit:element",
  payload: { id: "<requested id>", html: "<outerHTML>"|null, text: "<textContent>"|null } }
```

## Component → host

### `storykit:showDialog`

Ask the host to open the expanded (max-mode) dialog.

```js
{ type: "storykit:showDialog", payload: { src: "<url>", aspect: 1.5 } }
```

The payload is flat — `src`/`aspect` at the top level of `payload`.
(Historical note: the map component once wrapped these in a `props` object
the host never read, which silently broke its dialog. The runtime's
`showDialog(src, aspect)` makes the wrong shape impossible.)

### `storykit:height`

Ask the host to resize this component's iframe (used by image-compare
when its alignment panel opens and closes).

```js
{ type: "storykit:height", payload: { height: 640 } }  // px, positive number
```

### `storykit:getId`

Ask the host for the id it assigned to this component's iframe. Used by
vis-network to derive its data-block id. Host replies with `storykit:id`.

### `storykit:getElementById`

Ask the host for an element's content by id. Used by vis-network to fetch
its hidden CSV data block (by convention the element id is the viewer's
`id` + `-csv`; the block is hidden by the `[id$="-csv"]` rule in
`storykit.css`). Host replies with `storykit:element`.

## Component runtime API

`assets/js/storykit-component.js` (classic script; exposes `window.StoryKit`):

| Function | Purpose |
|---|---|
| `StoryKit.onAction(fn)` | Register handler for `storykit:action`; receives `{ action, args, label }` with `action` lower-cased |
| `StoryKit.onMessage(fn)` | Lower-level handler for any `storykit:*` message: `fn(name, payload, event)` |
| `StoryKit.sendToHost(type, payload)` | Send an enveloped message to the parent page |
| `StoryKit.showDialog(src, aspect)` | Request the expanded dialog |
| `StoryKit.reportHeight(px)` | Request an iframe resize |
| `StoryKit.getHostId()` | Promise for the host-assigned iframe id (null on timeout) |
| `StoryKit.requestHostElement(id)` | Promise for `{ html, text }` of a host element (null on timeout) |
| `StoryKit.safeParse(data)` | Tolerant object/JSON-string parse, never throws |

Component pages load the runtime before their own scripts:

```html
<script src="../js/storykit-component.js"></script>
```

(Classic scripts execute in document order and before module scripts, so
`window.StoryKit` is available to both kinds of component code.)

## Host behavior notes (`storykit.js`)

- Trigger-link clicks post `storykit:action` to the iframe resolved by
  `.col2 [data-id="<target>"]` (the cloned viewer in two-column mode)
  falling back to `getElementById(target)`. If neither exists the click
  is a no-op and a `console.warn` names the missing id — the most common
  authoring error (viewer include missing its `id`).
- `storykit:height` and the `storykit:getId` reply resolve the sending
  iframe by matching `event.source` against iframe `contentWindow`s.
- Unknown `storykit:*` types are ignored.
