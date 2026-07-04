/**
 * StoryKit component runtime
 * --------------------------
 * Shared messaging layer for the iframe viewer components in
 * /assets/components/. Loaded as a classic script so both module and
 * non-module component pages can use it:
 *
 *     <script src="../js/storykit-component.js"></script>
 *
 * Exposes a single global, window.StoryKit, implementing the component
 * side of the StoryKit postMessage protocol (see docs/postmessage-protocol.md).
 *
 * All messages use one envelope in both directions:
 *
 *     { type: "storykit:<name>", payload: { ... } }
 *
 * Components and the host page are always same-origin (components are
 * static pages served from the same site), so messages are sent to and
 * accepted from location.origin only. Set window.SK_TARGET_ORIGIN before
 * loading this script to override (e.g. for an unusual embedding setup).
 */
(function () {
  "use strict";

  var TARGET_ORIGIN = window.SK_TARGET_ORIGIN || window.location.origin;

  /** Tolerant message parse: accepts objects or JSON strings, never throws. */
  function safeParse(data) {
    if (!data) return null;
    if (typeof data === "object") return data;
    if (typeof data !== "string") return null;
    try { return JSON.parse(data); } catch (e) { return null; }
  }

  function isTrustedOrigin(origin) {
    return origin === TARGET_ORIGIN;
  }

  /** Send an enveloped message to the host page. */
  function sendToHost(type, payload) {
    if (window.parent === window) return; // not embedded; nothing to do
    window.parent.postMessage(
      { type: "storykit:" + type, payload: payload || {} },
      TARGET_ORIGIN
    );
  }

  /**
   * Listen for enveloped messages from the host. The handler receives
   * (name, payload, event) where name is the type without the
   * "storykit:" prefix. Messages from other origins or without the
   * prefix are ignored.
   */
  function onMessage(handler) {
    window.addEventListener("message", function (event) {
      if (!isTrustedOrigin(event.origin)) return;
      var msg = safeParse(event.data);
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type.indexOf("storykit:") !== 0) return;
      handler(msg.type.slice("storykit:".length), msg.payload || {}, event);
    });
  }

  /**
   * Register a handler for host-initiated viewer actions (trigger links).
   * The handler receives ({ action, args, label }) where action is
   * lower-cased and args is an array of strings (usually one element —
   * the raw argument segment of the action link).
   */
  function onAction(handler) {
    onMessage(function (name, payload) {
      if (name !== "action") return;
      handler({
        action: String(payload.action || "").toLowerCase(),
        args: Array.isArray(payload.args) ? payload.args : [],
        label: payload.label != null ? String(payload.label) : ""
      });
    });
  }

  /** Ask the host to open the expanded dialog on the given URL. */
  function showDialog(src, aspect) {
    sendToHost("showDialog", { src: src, aspect: aspect || 1.0 });
  }

  /** Report this component's desired iframe height (px) to the host. */
  function reportHeight(px) {
    var h = Number(px);
    if (!isFinite(h) || h <= 0) return;
    sendToHost("height", { height: Math.round(h) });
  }

  /**
   * Request/reply helper. Components can load and send before the host
   * page's module (which registers the reply handler) has executed, so
   * the request is re-sent periodically until a reply arrives or the
   * timeout elapses.
   */
  function requestFromHost(sendType, sendPayload, replyName, matchFn, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var interval = setInterval(function () {
        sendToHost(sendType, sendPayload);
      }, 400);
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        resolve(null);
      }, timeoutMs || 8000);
      onMessage(function (name, payload) {
        if (settled || name !== replyName || !matchFn(payload)) return;
        settled = true;
        clearInterval(interval);
        clearTimeout(timer);
        resolve(payload);
      });
      sendToHost(sendType, sendPayload);
    });
  }

  /**
   * Ask the host page for the id it assigned to this component's iframe.
   * Resolves to the id string (or null if the host doesn't answer).
   */
  function getHostId(timeoutMs) {
    return requestFromHost("getId", {}, "id", function () { return true; }, timeoutMs)
      .then(function (payload) {
        return payload && payload.id != null ? String(payload.id) : null;
      });
  }

  /**
   * Ask the host page for an element by id. Resolves to
   * { html, text } (values null if the element doesn't exist) or null
   * if the host doesn't answer.
   */
  function requestHostElement(id, timeoutMs) {
    return requestFromHost(
      "getElementById", { id: id }, "element",
      function (payload) { return payload.id === id; }, timeoutMs
    ).then(function (payload) {
      return payload
        ? { html: payload.html || null, text: payload.text || null }
        : null;
    });
  }

  window.StoryKit = {
    safeParse: safeParse,
    sendToHost: sendToHost,
    onMessage: onMessage,
    onAction: onAction,
    showDialog: showDialog,
    reportHeight: reportHeight,
    getHostId: getHostId,
    requestHostElement: requestHostElement
  };
})();
