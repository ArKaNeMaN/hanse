import {
  MAX_HIGHLIGHT_LINE_CHARS,
  MAX_TOKEN_NODES_PER_REQUEST,
  sanitizeTokenType,
  streamCapBytes,
  VENDORED_LANGUAGES,
} from "./chat-diff.js";

const LANGUAGES = new Set(VENDORED_LANGUAGES);
const ENCODER = new TextEncoder();

let Prism = null;
let ready = false;
let initializing = false;

function plain(jobID, streamID, reason) {
  self.postMessage({ type: "plain", jobID, streamID, reason });
}

function error(jobID, streamID, reason) {
  self.postMessage({ type: "error", jobID, streamID, reason });
}

function lineTooLong(text) {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      if (length > MAX_HIGHLIGHT_LINE_CHARS) return true;
      length = 0;
    } else {
      length += 1;
    }
  }
  return length > MAX_HIGHLIGHT_LINE_CHARS;
}

function flatten(root) {
  const leaves = [];
  const stack = [{ node: root, types: [] }];

  while (stack.length > 0) {
    const entry = stack.pop();
    const node = entry.node;

    if (typeof node === "string") {
      if (node.length === 0) continue;
      leaves.push({ text: node, types: entry.types });
      if (leaves.length > MAX_TOKEN_NODES_PER_REQUEST) return null;
      continue;
    }

    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node[index], types: entry.types });
      }
      continue;
    }

    if (node !== null && typeof node === "object") {
      const types = entry.types.slice();
      const type = sanitizeTokenType(node.type);
      if (type !== null) types.push(type);
      const aliases =
        node.alias === undefined
          ? []
          : Array.isArray(node.alias)
            ? node.alias
            : [node.alias];
      for (const alias of aliases) {
        const clean = sanitizeTokenType(alias);
        if (clean !== null) types.push(clean);
      }
      stack.push({ node: node.content, types });
    }
  }

  return leaves;
}

function mapLines(leaves) {
  const lines = [];
  let current = [];
  let endedWithNewline = false;

  for (const leaf of leaves) {
    const text = leaf.text;
    let start = 0;
    while (start <= text.length) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        if (start < text.length) {
          current.push([text.slice(start), leaf.types]);
          endedWithNewline = false;
        }
        break;
      }
      current.push([text.slice(start, newline), leaf.types]);
      lines.push(current);
      current = [];
      endedWithNewline = true;
      start = newline + 1;
    }
  }

  if (current.length > 0) {
    lines.push(current);
    endedWithNewline = false;
  } else if (endedWithNewline) {
    lines.push([]);
  }

  for (const line of lines) {
    let chars = 0;
    for (const segment of line) chars += segment[0].length;
    if (chars > MAX_HIGHLIGHT_LINE_CHARS) return null;
  }
  return lines;
}

async function initialize() {
  if (ready || initializing) return;
  initializing = true;
  try {
    globalThis.Prism = { manual: true, disableWorkerMessageHandler: true };
    const bundle = await import("./vendor/prism/prism-1.30.0.min.js");
    const loaded = bundle !== null && typeof bundle === "object" ? bundle.default : null;
    if (loaded === null || typeof loaded !== "object" || typeof loaded.tokenize !== "function") {
      throw new Error("invalid Prism bundle");
    }
    Prism = loaded;
    ready = true;
    initializing = false;
    self.postMessage({ type: "ready" });
  } catch {
    initializing = false;
    self.postMessage({ type: "error", reason: "init-failed" });
  }
}

function tokenize(data) {
  const jobID = typeof data.jobID === "string" ? data.jobID : "";
  const streamID = typeof data.streamID === "string" ? data.streamID : "";
  const language = typeof data.language === "string" ? data.language : "";
  const text = typeof data.text === "string" ? data.text : null;

  if (!ready || Prism === null) {
    error(jobID, streamID, "not-ready");
    return;
  }
  if (!LANGUAGES.has(language) || Prism.languages[language] === undefined) {
    plain(jobID, streamID, "language");
    return;
  }
  if (text === null) {
    plain(jobID, streamID, "text");
    return;
  }
  if (ENCODER.encode(text).length > streamCapBytes(language)) {
    plain(jobID, streamID, "bytes");
    return;
  }
  if (lineTooLong(text)) {
    plain(jobID, streamID, "line");
    return;
  }

  let tree;
  try {
    tree = Prism.tokenize(text, Prism.languages[language]);
  } catch {
    plain(jobID, streamID, "tokenize");
    return;
  }

  const leaves = flatten(tree);
  if (leaves === null) {
    plain(jobID, streamID, "tokens");
    return;
  }
  const lines = mapLines(leaves);
  if (lines === null) {
    plain(jobID, streamID, "line");
    return;
  }

  self.postMessage({
    type: "tokens",
    jobID,
    streamID,
    lines,
    tokenNodes: leaves.length,
  });
}

function onMessage(event) {
  const data = event === null || event === undefined ? null : event.data;
  if (data === null || typeof data !== "object") return;
  if (data.type === "init") {
    initialize();
    return;
  }
  if (data.type === "tokenize") tokenize(data);
}

if (typeof self !== "undefined") {
  self.onmessage = onMessage;
}
