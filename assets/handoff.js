/**
 * Handoff modal progressive enhancement.
 *
 * The server renders the handoff spec, result, and operator note as escaped text
 * inside `[data-markdown]` containers. This module hydrates each one with the
 * shared safe renderer from `./markdown.js`, which builds DOM nodes and never
 * assigns user text through `innerHTML`.
 *
 * Dialogs sit in the document before they are opened, so a single page-wide
 * query covers closed and open dialogs alike.
 */

import { renderMarkdown } from "./markdown.js";

function hydrate(root) {
  for (const node of root.querySelectorAll("[data-markdown]")) {
    const text = node.textContent ?? "";
    // Remove first so a repeat pass can never hydrate the same element twice.
    node.removeAttribute("data-markdown");
    node.replaceChildren();
    if (text.trim().length > 0) {
      renderMarkdown(node, text);
    }
  }
}

function onReady(callback) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
    return;
  }
  callback();
}

onReady(() => hydrate(document));
