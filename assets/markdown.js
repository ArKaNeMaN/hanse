/**
 * Shared safe Markdown renderer (design D10, plan 0017 phase 3).
 *
 * Browser ESM only. The renderer builds DOM nodes and never assigns Markdown text through
 * `innerHTML`; untrusted text becomes text nodes. It is imported by the chat client and, from
 * phase 4, by the skill preview module. Keeping one renderer is what makes the skill preview
 * match chat without a second Markdown implementation.
 *
 * Exports `renderMarkdown(container, text)` and the small `element` helper; the inline, block,
 * and table helpers stay private to this module.
 */

import { parseMarkdownTable } from "./chat-core.js";

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function renderInline(parent, text) {
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s]+)/g;
  let last = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > last) {
      parent.append(document.createTextNode(text.slice(last, match.index)));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      parent.append(element("code", "", token.slice(1, -1)));
    } else if (token.startsWith("**") && token.endsWith("**")) {
      const strong = element("strong");
      renderInline(strong, token.slice(2, -2));
      parent.append(strong);
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      const em = element("em");
      renderInline(em, token.slice(1, -1));
      parent.append(em);
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      if (linkMatch !== null) {
        const link = element("a", "", linkMatch[1]);
        link.href = linkMatch[2];
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        parent.append(link);
      } else {
        parent.append(document.createTextNode(token));
      }
    } else if (/^https?:\/\//.test(token)) {
      const trailing = /[.,;:!?]+$/.exec(token);
      const clean = trailing === null ? token : token.slice(0, -trailing[0].length);
      const link = element("a", "", clean);
      link.href = clean;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      parent.append(link);
      if (trailing !== null) parent.append(document.createTextNode(trailing[0]));
    } else {
      parent.append(document.createTextNode(token));
    }
    last = pattern.lastIndex;
    match = pattern.exec(text);
  }
  if (last < text.length) {
    parent.append(document.createTextNode(text.slice(last)));
  }
}

function startsBlock(line, lines, index) {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*(---|\*\*\*|___)\s*$/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*]|\d+\.)\s+/.test(line) ||
    (Array.isArray(lines) && parseMarkdownTable(lines, index) !== null)
  );
}

function renderTable(container, table) {
  const wrap = element("div", "message__table-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Table");
  const node = element("table", "message__table");
  const head = element("thead");
  const headRow = element("tr");
  for (const header of table.headers) {
    const cell = element("th");
    cell.setAttribute("scope", "col");
    cell.dataset.align = header.align;
    renderInline(cell, header.text);
    headRow.append(cell);
  }
  head.append(headRow);
  node.append(head);
  if (table.rows.length > 0) {
    const body = element("tbody");
    for (const row of table.rows) {
      const rowNode = element("tr");
      for (let column = 0; column < table.headers.length; column += 1) {
        const cell = element("td");
        cell.dataset.align = table.headers[column].align;
        renderInline(cell, row[column] || "");
        rowNode.append(cell);
      }
      body.append(rowNode);
    }
    node.append(body);
  }
  wrap.append(node);
  if (table.truncated) {
    wrap.append(element("p", "message__table-note", "Table truncated to 200 rows."));
  }
  container.append(wrap);
}

const MAX_DIAGRAM_CHARS = 32000;
const MAX_DIAGRAM_LINES = 400;
const MAX_DIAGRAMS_PER_CONTAINER = 8;
const MAX_SVG_CHARS = 1048576;
const MAX_DATA_URI_CHARS = 1572864;
const DIAGRAM_NOTE_ERROR = "Diagram could not be rendered.";
const DIAGRAM_NOTE_TOO_LARGE = "Diagram is too large to render.";
const DIAGRAM_NOTE_TOO_MANY = "Too many diagrams in this message; showing source.";
const DIAGRAM_NOTE_BUSY = "Diagram rendering is busy; showing source.";

const diagramTimers = new WeakMap();
let diagramRenderer = null;
let diagramSequence = 0;

/** Install (or clear, with `null`) the async renderer used for ```mermaid fences. */
export function setDiagramRenderer(renderer) {
  diagramRenderer = typeof renderer === "function" ? renderer : null;
}

export function hasDiagramRenderer() {
  return diagramRenderer !== null;
}

/** Cheap pre-scan used by components before they load the sandbox client. */
export function hasDiagramFence(text) {
  return /^```[ \t]*mermaid[ \t]*$/im.test(String(text).replace(/\r\n?/g, "\n"));
}

/** Extract a leading `title:` from a Mermaid frontmatter block for the image alt text. */
export function frontmatterTitle(text) {
  const frontmatter = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text));
  if (frontmatter === null) return undefined;
  const title = /^\s*title\s*:\s*(.+?)\s*$/m.exec(frontmatter[1]);
  if (title === null) return undefined;
  let value = title[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.length === 0 ? undefined : value.slice(0, 120);
}

function clearDiagramTimers(container) {
  const timers = diagramTimers.get(container);
  if (timers === undefined) return;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

function rememberDiagramTimer(container, timer) {
  let timers = diagramTimers.get(container);
  if (timers === undefined) {
    timers = new Set();
    diagramTimers.set(container, timers);
  }
  timers.add(timer);
}

function forgetDiagramTimer(container, timer) {
  const timers = diagramTimers.get(container);
  if (timers === undefined) return;
  timers.delete(timer);
  if (timers.size === 0) diagramTimers.delete(container);
}

function diagramNote(text) {
  return element("p", "message__diagram-note", text);
}

function diagramSource(source) {
  const details = element("details", "message__diagram-source");
  const summary = element("summary", "", "Diagram source");
  const pre = element("pre");
  const code = element("code", "", source);
  code.dataset.language = "mermaid";
  pre.append(code);
  details.append(summary, pre);
  return details;
}

function svgSource(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function scheduleDiagram(container, frame, source, pre, options) {
  const delay = Math.max(0, Number(options.diagramDelayMs ?? 0));
  const diagramId = frame.dataset.diagramId;
  const isCancelled = () =>
    !frame.isConnected || frame.dataset.diagramId !== diagramId;
  const timer = setTimeout(async () => {
    forgetDiagramTimer(container, timer);
    if (isCancelled()) return;
    let svg;
    try {
      svg = await diagramRenderer(source, isCancelled);
    } catch {
      if (isCancelled()) return;
      frame.dataset.mermaid = "error";
      frame.append(diagramNote(DIAGRAM_NOTE_ERROR));
      return;
    }
    if (isCancelled()) return;
    if (typeof svg !== "string" || svg.length === 0) {
      frame.dataset.mermaid = "error";
      frame.append(diagramNote(DIAGRAM_NOTE_ERROR));
      return;
    }
    if (svg.length > MAX_SVG_CHARS) {
      frame.dataset.mermaid = "too-large";
      frame.append(diagramNote(DIAGRAM_NOTE_TOO_LARGE));
      return;
    }
    let src;
    try {
      src = svgSource(svg);
    } catch {
      frame.dataset.mermaid = "error";
      frame.append(diagramNote(DIAGRAM_NOTE_ERROR));
      return;
    }
    if (src.length > MAX_DATA_URI_CHARS) {
      frame.dataset.mermaid = "too-large";
      frame.append(diagramNote(DIAGRAM_NOTE_TOO_LARGE));
      return;
    }
    const image = element("img", "message__diagram-image");
    image.setAttribute("data-mermaid-image", "");
    image.alt = frontmatterTitle(source) ?? "Mermaid diagram";
    const details = diagramSource(source);
    let restored = false;
    const restore = () => {
      if (restored || isCancelled()) return;
      restored = true;
      frame.dataset.mermaid = "image-error";
      frame.replaceChildren(pre, details, diagramNote(DIAGRAM_NOTE_ERROR));
    };
    image.addEventListener("error", restore, { once: true });
    frame.dataset.mermaid = "ready";
    frame.replaceChildren(image, details);
    image.src = src;
    if (typeof image.decode === "function") {
      void image.decode().catch(restore);
    }
  }, delay);
  rememberDiagramTimer(container, timer);
}

export function renderMarkdown(container, text, options = {}) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const diagrams = options.diagrams === true && diagramRenderer !== null;
  let diagramCount = 0;
  let tooManyNoted = false;
  clearDiagramTimers(container);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const source = codeLines.join("\n");
      if (diagrams && language.toLowerCase() === "mermaid") {
        const pre = element("pre");
        const code = element("code", "", source);
        code.dataset.language = language;
        pre.append(code);
        if (source.length > MAX_DIAGRAM_CHARS || codeLines.length > MAX_DIAGRAM_LINES) {
          const frame = element("div", "message__diagram");
          frame.dataset.mermaid = "too-large";
          frame.append(pre, diagramNote(DIAGRAM_NOTE_TOO_LARGE));
          container.append(frame);
          continue;
        }
        diagramCount += 1;
        if (diagramCount > MAX_DIAGRAMS_PER_CONTAINER) {
          const frame = element("div", "message__diagram");
          frame.dataset.mermaid = "too-many";
          frame.append(pre);
          if (!tooManyNoted) {
            frame.append(diagramNote(DIAGRAM_NOTE_TOO_MANY));
            tooManyNoted = true;
          }
          container.append(frame);
          continue;
        }
        const frame = element("div", "message__diagram");
        frame.dataset.mermaid = "pending";
        diagramSequence += 1;
        frame.dataset.diagramId = String(diagramSequence);
        frame.append(pre);
        container.append(frame);
        scheduleDiagram(container, frame, source, pre, options);
        continue;
      }
      const pre = element("pre");
      const code = element("code", "", source);
      if (language.length > 0) code.dataset.language = language;
      pre.append(code);
      container.append(pre);
      continue;
    }
    const table = parseMarkdownTable(lines, index);
    if (table !== null) {
      renderTable(container, table);
      index = table.nextIndex;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      const tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
      const node = element(tag);
      renderInline(node, heading[2]);
      container.append(node);
      index += 1;
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      container.append(element("hr"));
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = element("blockquote");
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        if (quote.childNodes.length > 0) quote.append(element("br"));
        renderInline(quote, lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      container.append(quote);
      continue;
    }
    const listMatch = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch !== null) {
      const ordered = /\d+\./.test(listMatch[1]);
      const list = element(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(lines[index]);
        if (item === null || /\d+\./.test(item[1]) !== ordered) break;
        const li = element("li");
        renderInline(li, item[2]);
        list.append(li);
        index += 1;
      }
      container.append(list);
      continue;
    }
    const paragraph = element("p");
    let first = true;
    while (
      index < lines.length &&
      lines[index].trim().length > 0 &&
      !startsBlock(lines[index], lines, index)
    ) {
      if (!first) paragraph.append(element("br"));
      renderInline(paragraph, lines[index]);
      first = false;
      index += 1;
    }
    container.append(paragraph);
  }
}
