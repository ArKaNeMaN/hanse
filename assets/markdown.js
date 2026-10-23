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

export function renderMarkdown(container, text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
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
      const pre = element("pre");
      const code = element("code", "", codeLines.join("\n"));
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
