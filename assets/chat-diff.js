/**
 * Pure chat diff model.
 *
 * Browser/Node-safe ESM: no DOM, no Prism, no network, no HTML-string sinks, no timers. The only platform
 * APIs are `TextEncoder`/`TextDecoder` (Node >= 20 and every supported browser).
 *
 * The worker, controller, and `chat.js` import these stable exports:
 * - constants: display/worker/stream caps from design sections 4.6, 5.1;
 * - `resolveLanguage(path)`, `streamCapBytes(language)`;
 * - `parseUnifiedDiff(text, options)`;
 * - `extractToolView(data, tool, status)`, `patchPartView(data)`;
 * - `clipDisplay(text, capBytes)`, `allocateView(view, options)`;
 * - `truncationNotice(part, status, view)`, `diffFilesFromView(view)`.
 *
 * A diff view is `{kind:"diff", field:"diff"|"patch", files: DiffFile[], diagnostics, filesTruncated,
 * display}`. A write view is `{kind:"write", field:"write", files:[WriteFile], ...}`. A read view is
 * `{kind:"read", field:"read", files:[ReadFile], ...}`. A file-list view is
 * `{kind:"files", field:"patch", files:[{path}], ...}`. A plain view is
 * `{kind:"plain", field, text, files:[]}`. Every view exposes `display`
 * `{write, perFile, total, lines, files}`; allocators seed them and `allocateView` applies the
 * remaining display caps.
 *
 * ReadFile: `{path, language, lineStart, lineEnd, lineCount, totalLines, statusLine,
 * sourceTruncated, truncated, content, lines}`. `lines` is `{number, text}[]`; numbers come from the
 * XML (`N: text`), not from the array index. `content` is the joined text of the parsed lines.
 * `statusLine` is the exact trailing parenthetical text without its outer `(...)`.
 *
 * DiffFile: `{path, oldPath, newPath, type, language, additions, deletions, statsPartial, binary,
 * headerOnly, truncated, hunks, patch, countsFromMetadata}`. Hunk: `{header, oldStart, oldCount,
 * newStart, newCount, lines}`. Line: `{kind, text, oldNumber, newNumber}`; a blank/zero side is
 * `null`.
 *
 * @typedef {"add" | "update" | "delete" | "move" | "binary" | "unknown"} DiffType
 * @typedef {{ serverFields: string[], serverLimit: string | undefined, omitted: boolean,
 *   display: DisplayTruncation }} TruncationView
 * @typedef {{ write: boolean, perFile: boolean, total: boolean, lines: boolean, files: boolean }} DisplayTruncation
 * @typedef {{ kind: "context" | "add" | "del" | "meta", text: string,
 *   oldNumber: number | null, newNumber: number | null }} DiffLine
 * @typedef {{ header: string, oldStart: number, oldCount: number, newStart: number,
 *   newCount: number, lines: DiffLine[] }} DiffHunk
 */

/** Per-file display allocation. */
export const MAX_DIFF_DISPLAY_BYTES = 64 * 1024;
/** Multi-file display allocation. */
export const MAX_DIFF_DISPLAY_TOTAL_BYTES = 128 * 1024;
/** `write` content display allocation. */
export const MAX_WRITE_DISPLAY_BYTES = 64 * 1024;
/** `read` content display allocation. */
export const MAX_READ_DISPLAY_BYTES = 64 * 1024;
/** Per-file render cap. */
export const MAX_RENDERED_LINES = 2_000;
/** Maximum file records accepted from any parsed source. */
export const MAX_DIFF_FILES = 50;
/** Default per-stream highlight cap. */
export const MAX_HIGHLIGHT_STREAM_BYTES_DEFAULT = 64 * 1024;
/** Explicit `write` cap; covered by the default. */
export const MAX_HIGHLIGHT_WRITE_BYTES = 64 * 1024;
/** Oracle-measured pathological grammars. */
export const HIGHLIGHT_STREAM_CAPS = Object.freeze({
  markdown: 8 * 1024,
  markup: 8 * 1024,
  bash: 8 * 1024,
});
/** A longer line renders that stream plain. */
export const MAX_HIGHLIGHT_LINE_CHARS = 1_000;
/** Worker `plain` threshold for one stream and the scheduler reservation unit. */
export const MAX_TOKEN_NODES_PER_REQUEST = 10_000;
/** Controller aggregate for one file. */
export const MAX_TOKEN_NODES_PER_FILE = 20_000;
/** Per-request/stream timeout. */
export const HIGHLIGHT_TIMEOUT_MS = 250;
/** Worker creation + Prism load timeout. */
export const WORKER_READY_TIMEOUT_MS = 2_000;
/** Active worker time per view. */
export const MAX_HIGHLIGHT_VIEW_WORK_MS = 1_000;
/** Active worker time per page. */
export const MAX_HIGHLIGHT_PAGE_WORK_MS = 3_000;
/** Circuit breaker per view/language. */
export const MAX_TIMEOUTS_PER_LANGUAGE = 2;
/** Streams holding a 10,000-node reservation. */
export const MAX_INFLIGHT_HIGHLIGHT_STREAMS = 12;
/** In-flight reservation budget. */
export const MAX_PAGE_TOKEN_NODES = 120_000;
/** Worker-ready admission queue only. */
export const MAX_PENDING_HIGHLIGHT_FILES = 50;
/** Per displayed/metadata path. */
export const MAX_DIFF_PATH_BYTES = 1_024;
/** Sum of displayed/metadata paths. */
export const MAX_DIFF_PATH_TOTAL_BYTES = 16 * 1024;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const REQUIRED_LANGUAGES = new Set([
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "json",
  "yaml",
  "bash",
  "markdown",
  "css",
  "markup",
  "python",
  "go",
  "rust",
  "sql",
  "docker",
  "diff",
]);
const OPTIONAL_LANGUAGES = new Set([
  "toml",
  "ini",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "kotlin",
  "swift",
  "scala",
  "lua",
  "makefile",
  "graphql",
  "powershell",
]);
const CANONICAL_LANGUAGES = new Set([...REQUIRED_LANGUAGES, ...OPTIONAL_LANGUAGES]);

/**
 * Every canonical language ID shipped by the vendored bundle. The worker and the resolver share
 * this allowlist; array order is the vendored component order (required before optional).
 */
export const VENDORED_LANGUAGES = Object.freeze([
  ...REQUIRED_LANGUAGES,
  ...OPTIONAL_LANGUAGES,
]);

const TOKEN_TYPE_PATTERN = /^[a-z0-9-]+$/;

/**
 * Sanitize a token type/alias for use as a CSS class. Anything that is not a lowercase
 * alphanumeric/hyphen identifier is dropped.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function sanitizeTokenType(value) {
  return typeof value === "string" && TOKEN_TYPE_PATTERN.test(value) ? value : null;
}

/** Longest suffix first so `*.d.ts` wins over `*.ts`. */
const EXTENSION_LANGUAGES = [
  [".d.ts", "typescript"],
  [".dockerfile", "docker"],
  [".graphqls", "graphql"],
  [".markdown", "markdown"],
  [".properties", "ini"],
  [".gitmodules", "ini"],
  [".editorconfig", "ini"],
  [".gemspec", "ruby"],
  [".jsonc", "json"],
  [".json5", "json"],
  [".jsonl", "json"],
  [".ndjson", "json"],
  [".yaml", "yaml"],
  [".css", "css"],
  [".html", "markup"],
  [".xhtml", "markup"],
  [".xml", "markup"],
  [".svg", "markup"],
  [".pyw", "python"],
  [".pyi", "python"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".sql", "sql"],
  [".diff", "diff"],
  [".patch", "diff"],
  [".toml", "toml"],
  [".ini", "ini"],
  [".cfg", "ini"],
  [".conf", "ini"],
  [".java", "java"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],
  [".c", "c"],
  [".h", "c"],
  [".cs", "csharp"],
  [".csx", "csharp"],
  [".rb", "ruby"],
  [".rake", "ruby"],
  [".php", "php"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".swift", "swift"],
  [".scala", "scala"],
  [".sc", "scala"],
  [".lua", "lua"],
  [".mk", "makefile"],
  [".mak", "makefile"],
  [".graphql", "graphql"],
  [".gql", "graphql"],
  [".ps1", "powershell"],
  [".psm1", "powershell"],
  [".psd1", "powershell"],
  [".js", "javascript"],
  [".jsx", "jsx"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".json", "json"],
  [".yml", "yaml"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".zsh", "bash"],
  [".ksh", "bash"],
  [".md", "markdown"],
  [".htm", "markup"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".mdx", "markdown"],
];

function specialLanguage(basename) {
  if (basename === "README") return "markdown";
  const lower = basename.toLowerCase();
  if (lower === "gemfile" || lower === "rakefile" || lower === "podfile") return "ruby";
  if (lower === "makefile" || lower === "gnumakefile") return "makefile";
  if (lower === ".editorconfig" || lower === ".gitconfig" || lower === ".gitmodules") return "ini";
  if (lower === ".npmrc" || lower === ".yarnrc") return "ini";
  if (lower === ".env" || lower.startsWith(".env.")) return "bash";
  if (
    lower === "dockerfile" ||
    lower === "containerfile" ||
    lower.startsWith("dockerfile.") ||
    lower.startsWith("containerfile.")
  ) {
    return "docker";
  }
  return null;
}

/**
 * Resolve the canonical Prism language for a path.
 *
 * The uncapped basename is used first; callers cap only the displayed path. Returns `null` for an
 * unknown extension, an extensionless name outside the special table, or a non-vendored language.
 *
 * @param {string | null | undefined} path
 * @returns {string | null}
 */
export function resolveLanguage(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  let basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const suffix = basename.search(/[?#]/);
  if (suffix !== -1) basename = basename.slice(0, suffix);
  if (basename.length === 0) return null;

  const special = specialLanguage(basename);
  if (special !== null) return CANONICAL_LANGUAGES.has(special) ? special : null;

  const lower = basename.toLowerCase();
  for (const [extension, language] of EXTENSION_LANGUAGES) {
    if (lower.endsWith(extension)) {
      return CANONICAL_LANGUAGES.has(language) ? language : null;
    }
  }
  return null;
}

/**
 * Per-stream byte cap for a resolved language. Unknown/plain views must not call the worker.
 *
 * @param {string | null | undefined} language
 * @returns {number}
 */
export function streamCapBytes(language) {
  if (typeof language === "string" && Object.hasOwn(HIGHLIGHT_STREAM_CAPS, language)) {
    return HIGHLIGHT_STREAM_CAPS[language];
  }
  return MAX_HIGHLIGHT_STREAM_BYTES_DEFAULT;
}

function utf8Bytes(value) {
  return UTF8_ENCODER.encode(value).length;
}

/**
 * UTF-8-safe head clip. Never splits a code point and keeps a partial last line.
 *
 * @param {string} text
 * @param {number} capBytes
 * @returns {{ text: string, clipped: boolean }}
 */
export function clipDisplay(text, capBytes) {
  const value = typeof text === "string" ? text : "";
  const cap =
    typeof capBytes === "number" && Number.isFinite(capBytes) && capBytes > 0
      ? Math.floor(capBytes)
      : 0;
  const bytes = UTF8_ENCODER.encode(value);
  if (bytes.length <= cap) return { text: value, clipped: false };
  if (cap === 0) return { text: "", clipped: true };
  let end = Math.min(cap, bytes.length);
  while (end > 0) {
    try {
      return { text: UTF8_DECODER.decode(bytes.subarray(0, end)), clipped: true };
    } catch {
      end -= 1;
    }
  }
  return { text: "", clipped: true };
}

function countLines(text) {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  if (!text.endsWith("\n")) lines += 1;
  return lines;
}

function emptyDisplay() {
  return { write: false, perFile: false, total: false, lines: false, files: false };
}

function displayOf(view) {
  return { ...emptyDisplay(), ...(view && typeof view.display === "object" ? view.display : {}) };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const VALID_DIFF_TYPES = new Set(["add", "update", "delete", "move", "binary", "unknown"]);

function stripPathDecorations(value) {
  let text = value.trim();
  const tab = text.indexOf("\t");
  if (tab !== -1) text = text.slice(0, tab);
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1);
  }
  if (text === "/dev/null") return null;
  if (text.startsWith("a/") || text.startsWith("b/")) text = text.slice(2);
  return text.length === 0 ? null : text;
}

function headerPath(line, prefix) {
  if (typeof line !== "string" || !line.startsWith(prefix)) return { present: false, path: null };
  return { present: true, path: stripPathDecorations(line.slice(prefix.length)) };
}

function splitQuotedTokens(value) {
  const tokens = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && (index === 0 || value[index - 1] !== "\\")) {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === " " && !quoted) {
      if (current.length > 0) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function gitDiffPaths(line) {
  const tokens = splitQuotedTokens(line.slice("diff --git ".length));
  if (tokens.length < 2) return { oldPath: null, newPath: null };
  return {
    oldPath: stripPathDecorations(tokens[0]),
    newPath: stripPathDecorations(tokens[1]),
  };
}

function lineNumber(start, offset) {
  return start === 0 ? null : start + offset;
}

function newFileRecord() {
  return {
    path: null,
    oldPath: null,
    newPath: null,
    indexPath: null,
    type: null,
    additions: 0,
    deletions: 0,
    statsPartial: false,
    binary: false,
    headerOnly: false,
    truncated: false,
    hunks: [],
    rawLines: [],
    oldNull: false,
    newNull: false,
    sawOldPath: false,
    sawNewPath: false,
    sawIndex: false,
    countsFromMetadata: false,
  };
}

function parsedCounts(file) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions += 1;
      else if (line.kind === "del") deletions += 1;
    }
  }
  return { additions, deletions };
}

function finishFile(file, options) {
  let oldPath = file.oldPath;
  let newPath = file.newPath;
  if (options.oldPath !== undefined) {
    oldPath = options.oldPath;
    file.oldNull = false;
  }
  if (options.newPath !== undefined) {
    newPath = options.newPath;
    file.newNull = false;
  }

  const hasHeaders = oldPath !== null || newPath !== null;
  if (!hasHeaders && options.defaultPath) {
    if (!file.oldNull) oldPath = options.defaultPath;
    if (!file.newNull) newPath = options.defaultPath;
  } else {
    if (oldPath === null && !file.oldNull && options.defaultPath) oldPath = options.defaultPath;
    if (newPath === null && !file.newNull && options.defaultPath) newPath = options.defaultPath;
  }
  if (!hasHeaders && oldPath === null && newPath === null && file.indexPath !== null) {
    oldPath = file.indexPath;
    newPath = file.indexPath;
  }

  let type = file.type;
  if (options.type && VALID_DIFF_TYPES.has(options.type)) {
    type = options.type;
  } else if (type === null) {
    if (file.binary) type = "binary";
    else if (file.oldNull) type = "add";
    else if (file.newNull) type = "delete";
    else type = "update";
  }

  const counts = parsedCounts(file);
  const metadataAdditions = typeof options.additions === "number" ? options.additions : null;
  const metadataDeletions = typeof options.deletions === "number" ? options.deletions : null;
  const additions = metadataAdditions ?? counts.additions;
  const deletions = metadataDeletions ?? counts.deletions;
  const countsFromMetadata = metadataAdditions !== null && metadataDeletions !== null;
  const path = newPath ?? oldPath ?? file.indexPath ?? null;

  return {
    path,
    oldPath,
    newPath,
    type,
    language: resolveLanguage(path),
    additions,
    deletions,
    statsPartial: !countsFromMetadata && file.truncated,
    binary: file.binary,
    headerOnly: file.hunks.length === 0,
    truncated: file.truncated,
    hunks: file.hunks,
    patch: file.rawLines.join("\n"),
    countsFromMetadata,
  };
}

function endHunk(file, hunk) {
  if (hunk.ended === true) return;
  hunk.ended = true;
  if (hunk.oldConsumed !== hunk.oldCount || hunk.newConsumed !== hunk.newCount) {
    file.truncated = true;
  }
}

function metaLine(text) {
  return { kind: "meta", text, oldNumber: null, newNumber: null };
}

function addHunkLine(file, hunk, kind, text) {
  if (kind === "context") {
    hunk.lines.push({
      kind,
      text,
      oldNumber: lineNumber(hunk.oldStart, hunk.oldConsumed),
      newNumber: lineNumber(hunk.newStart, hunk.newConsumed),
    });
    hunk.oldConsumed += 1;
    hunk.newConsumed += 1;
    return;
  }
  if (kind === "add") {
    hunk.lines.push({
      kind,
      text,
      oldNumber: null,
      newNumber: lineNumber(hunk.newStart, hunk.newConsumed),
    });
    hunk.newConsumed += 1;
    return;
  }
  hunk.lines.push({
    kind: "del",
    text,
    oldNumber: lineNumber(hunk.oldStart, hunk.oldConsumed),
    newNumber: null,
  });
  hunk.oldConsumed += 1;
}

function isHunkBoundary(line) {
  return (
    line.startsWith("@@ ") ||
    line.startsWith("diff --git ") ||
    line.startsWith("Index: ")
  );
}

/**
 * Feed one line to an active hunk.
 *
 * @returns {"consumed" | "ended" | "reprocess"}
 */
function feedHunk(file, hunk, line) {
  const drained =
    hunk.oldConsumed >= hunk.oldCount && hunk.newConsumed >= hunk.newCount;

  if (line.startsWith("\\")) {
    hunk.lines.push(metaLine(line.slice(1).replace(/^ /, "")));
    return "consumed";
  }

  if (drained) {
    if (isHunkBoundary(line) || line.startsWith("--- ") || line.startsWith("+++ ")) {
      endHunk(file, hunk);
      return "reprocess";
    }
    if (line === "") {
      endHunk(file, hunk);
      return "ended";
    }
    hunk.lines.push(metaLine(line));
    file.truncated = true;
    endHunk(file, hunk);
    return "ended";
  }

  if (line === "") {
    addHunkLine(file, hunk, "context", "");
    return "consumed";
  }
  const prefix = line[0];
  if (prefix === " ") {
    addHunkLine(file, hunk, "context", line.slice(1));
    return "consumed";
  }
  if (prefix === "+") {
    addHunkLine(file, hunk, "add", line.slice(1));
    return "consumed";
  }
  if (prefix === "-") {
    addHunkLine(file, hunk, "del", line.slice(1));
    return "consumed";
  }
  if (isHunkBoundary(line)) {
    file.truncated = true;
    endHunk(file, hunk);
    return "reprocess";
  }
  hunk.lines.push(metaLine(line));
  file.truncated = true;
  endHunk(file, hunk);
  return "consumed";
}

/**
 * Parse unified diff text into the display model.
 *
 * Options: `{defaultPath, type, oldPath, newPath, additions, deletions, maxFiles}`. Explicit
 * metadata wins over `/dev/null`, rename headers, and parsed counts. `maxFiles` defaults to
 * `MAX_DIFF_FILES` and applies to combined and per-file sources alike.
 *
 * @param {string} text
 * @param {{ defaultPath?: string, type?: DiffType, oldPath?: string, newPath?: string,
 *   additions?: number, deletions?: number, maxFiles?: number }} [options]
 * @returns {{ files: ReturnType<typeof finishFile>[], truncated: boolean,
 *   filesTruncated: boolean, raw: boolean }}
 */
export function parseUnifiedDiff(text, options = {}) {
  const config = options && typeof options === "object" ? options : {};
  const maxFiles =
    Number.isInteger(config.maxFiles) && config.maxFiles >= 0
      ? config.maxFiles
      : MAX_DIFF_FILES;
  const source = typeof text === "string" ? text : "";
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const files = [];
  let current = null;
  let hunk = null;
  let recognized = false;
  let filesTruncated = false;
  let stopped = false;
  let binaryPayload = false;

  function startFile() {
    if (current !== null) {
      files.push(finishFile(current, config));
      current = null;
    }
    if (files.length >= maxFiles) {
      filesTruncated = true;
      stopped = true;
      return null;
    }
    current = newFileRecord();
    binaryPayload = false;
    return current;
  }

  for (let index = 0; index < lines.length && !stopped; index += 1) {
    const line = lines[index];

    if (hunk !== null) {
      const action = feedHunk(current, hunk, line);
      if (action === "consumed") {
        current.rawLines.push(line);
        continue;
      }
      if (action === "ended") {
        current.rawLines.push(line);
        hunk = null;
        continue;
      }
      hunk = null;
    }

    if (line.startsWith("diff --git ")) {
      recognized = true;
      const file = startFile();
      if (file === null) continue;
      const paths = gitDiffPaths(line);
      file.oldPath = paths.oldPath;
      file.newPath = paths.newPath;
      file.oldNull = paths.oldPath === null;
      file.newNull = paths.newPath === null;
      file.rawLines.push(line);
      continue;
    }

    if (line.startsWith("Index: ")) {
      const header = headerPath(line, "Index: ");
      if (
        current === null ||
        current.sawIndex ||
        current.sawOldPath ||
        current.sawNewPath ||
        current.hunks.length > 0
      ) {
        recognized = true;
        if (startFile() === null) continue;
      }
      recognized = true;
      current.sawIndex = true;
      current.indexPath = header.path;
      current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("====")) {
      if (current !== null) current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("--- ")) {
      const header = headerPath(line, "--- ");
      if (
        current === null ||
        current.sawOldPath ||
        current.sawNewPath ||
        current.hunks.length > 0
      ) {
        recognized = true;
        if (startFile() === null) continue;
      }
      recognized = true;
      current.sawOldPath = true;
      current.oldNull = header.path === null;
      if (header.path !== null) current.oldPath = header.path;
      current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("+++ ")) {
      const header = headerPath(line, "+++ ");
      if (
        current === null ||
        current.sawNewPath ||
        current.hunks.length > 0
      ) {
        recognized = true;
        if (startFile() === null) continue;
      }
      recognized = true;
      current.sawNewPath = true;
      current.newNull = header.path === null;
      if (header.path !== null) current.newPath = header.path;
      current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("@@")) {
      const match = HUNK_HEADER.exec(line);
      if (match === null) {
        if (current !== null) {
          current.truncated = true;
          current.rawLines.push(line);
        }
        continue;
      }
      if (current === null) {
        recognized = true;
        if (startFile() === null) continue;
      }
      recognized = true;
      const oldCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
      const newCount = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
      hunk = {
        header: line,
        oldStart: Number.parseInt(match[1], 10),
        oldCount,
        newStart: Number.parseInt(match[3], 10),
        newCount,
        oldConsumed: 0,
        newConsumed: 0,
        ended: false,
        lines: [],
      };
      current.hunks.push(hunk);
      current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("new file mode")) {
      if (current === null) {
        recognized = true;
        if (startFile() === null) continue;
      }
      current.type = "add";
      current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("deleted file mode")) {
      if (current === null) {
        recognized = true;
        if (startFile() === null) continue;
      }
      current.type = "delete";
      current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("rename from ")) {
      if (current === null) {
        recognized = true;
        if (startFile() === null) continue;
      }
      current.type = "move";
      current.oldPath = stripPathDecorations(line.slice("rename from ".length));
      current.sawOldPath = true;
      current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("rename to ")) {
      if (current === null) {
        recognized = true;
        if (startFile() === null) continue;
      }
      current.type = "move";
      current.newPath = stripPathDecorations(line.slice("rename to ".length));
      current.sawNewPath = true;
      current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      if (current === null) {
        recognized = true;
        if (startFile() === null) continue;
      }
      recognized = true;
      current.binary = true;
      if (line.startsWith("Binary files ")) {
        const match = /^Binary files (.+) and (.+) differ$/.exec(line);
        if (match !== null) {
          const oldPath = stripPathDecorations(match[1]);
          const newPath = stripPathDecorations(match[2]);
          if (!current.sawOldPath) {
            current.oldNull = oldPath === null;
            current.oldPath = oldPath;
          }
          if (!current.sawNewPath) {
            current.newNull = newPath === null;
            current.newPath = newPath;
          }
        }
      } else {
        binaryPayload = true;
      }
      current.rawLines.push(line);
      continue;
    }

    if (
      line.startsWith("index ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ")
    ) {
      if (current !== null) current.rawLines.push(line);
      continue;
    }

    if (line.startsWith("\\") && current !== null) {
      const last = current.hunks[current.hunks.length - 1];
      if (last !== undefined) last.lines.push(metaLine(line.slice(1).replace(/^ /, "")));
      current.rawLines.push(line);
      continue;
    }

    if (binaryPayload) continue;
    if (current !== null) current.rawLines.push(line);
  }

  if (hunk !== null) endHunk(current, hunk);
  if (current !== null) files.push(finishFile(current, config));

  return {
    files,
    truncated: files.some((file) => file.truncated),
    filesTruncated,
    raw: !recognized,
  };
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    const text = stringValue(value);
    if (text !== null) return text;
  }
  return null;
}

function partState(data) {
  return data && typeof data === "object" && data.state && typeof data.state === "object"
    ? data.state
    : {};
}

function partInput(state) {
  return state.input && typeof state.input === "object" ? state.input : {};
}

function partMetadata(state) {
  return state.metadata && typeof state.metadata === "object" ? state.metadata : {};
}

function normalizeDiagnostics(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => diagnosticsEntry(entry, null)).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const lines = [];
    for (const [path, entries] of Object.entries(value)) {
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const text = diagnosticsEntry(entry, path);
          if (text.length > 0) lines.push(text);
        }
      } else {
        const text = diagnosticsEntry(entries, path);
        if (text.length > 0) lines.push(text);
      }
    }
    return lines.join("\n");
  }
  return "";
}

function diagnosticsEntry(entry, path) {
  if (typeof entry === "string") return path === null ? entry : `${path}: ${entry}`;
  if (entry && typeof entry === "object") {
    const message = firstString(entry.message, entry.text);
    if (message === null) return "";
    const prefix = firstString(entry.file, entry.path, path);
    return prefix === null ? message : `${prefix}: ${message}`;
  }
  return "";
}

function diffView(field, files, options = {}) {
  return {
    kind: "diff",
    field,
    files,
    diagnostics: options.diagnostics ?? "",
    filesTruncated: options.filesTruncated === true,
    display: { ...emptyDisplay(), ...(options.display ?? {}) },
  };
}

function plainView(field, text, options = {}) {
  return {
    kind: "plain",
    field,
    text,
    files: [],
    diagnostics: options.diagnostics ?? "",
    filesTruncated: false,
    display: { ...emptyDisplay(), ...(options.display ?? {}) },
  };
}

function fileListEntry(path) {
  return {
    path,
    oldPath: null,
    newPath: null,
    type: "unknown",
    language: resolveLanguage(path),
    additions: 0,
    deletions: 0,
    statsPartial: false,
    binary: false,
    headerOnly: true,
    truncated: false,
    hunks: [],
  };
}

function recordPatch(record) {
  return firstString(record.patch, record.diff);
}

function recordPath(record) {
  const type = typeof record.type === "string" ? record.type : "update";
  if (type === "move") {
    return firstString(record.relativePath, record.movePath, record.filePath);
  }
  return firstString(record.relativePath, record.filePath, record.movePath);
}

function recordOldPath(record) {
  const type = typeof record.type === "string" ? record.type : "update";
  if (type === "move") return firstString(record.filePath, record.relativePath, record.movePath);
  return firstString(record.filePath, record.relativePath, record.movePath);
}

function recordNewPath(record) {
  const type = typeof record.type === "string" ? record.type : "update";
  if (type === "move") return firstString(record.relativePath, record.movePath, record.filePath);
  return firstString(record.relativePath, record.filePath, record.movePath);
}

function headerOnlyRecord(record, rawText = "") {
  const path = recordPath(record);
  const type = typeof record.type === "string" ? record.type : "update";
  return {
    path,
    oldPath: recordOldPath(record),
    newPath: recordNewPath(record),
    type,
    language: resolveLanguage(path),
    additions: typeof record.additions === "number" ? record.additions : 0,
    deletions: typeof record.deletions === "number" ? record.deletions : 0,
    statsPartial: true,
    binary: false,
    headerOnly: true,
    truncated: false,
    hunks: [],
    patch: rawText,
    countsFromMetadata: typeof record.additions === "number" && typeof record.deletions === "number",
  };
}

function parseRecordPatch(record, patch) {
  const path = recordPath(record);
  const oldPath = recordOldPath(record);
  const newPath = recordNewPath(record);
  const parsed = parseUnifiedDiff(patch, {
    defaultPath: path ?? undefined,
    type: typeof record.type === "string" ? record.type : undefined,
    oldPath: oldPath ?? undefined,
    newPath: newPath ?? undefined,
    additions: typeof record.additions === "number" ? record.additions : undefined,
    deletions: typeof record.deletions === "number" ? record.deletions : undefined,
    maxFiles: 1,
  });
  if (parsed.files.length === 0) return headerOnlyRecord(record, patch);
  return parsed.files[0];
}

function recordsFromMetadata(metadata) {
  const files = metadata.files;
  if (!Array.isArray(files)) return [];
  return files.filter((record) => record && typeof record === "object");
}

function hasEveryPatch(records) {
  return records.length > 0 && records.every((record) => recordPatch(record) !== null);
}

function hasAnyPatch(records) {
  return records.some((record) => recordPatch(record) !== null);
}

function combinedEditPatch(input, metadata) {
  const filediff =
    metadata.filediff && typeof metadata.filediff === "object" ? metadata.filediff : {};
  const filediffPath = firstString(filediff.file, filediff.path, filediff.filePath);
  const filediffPatch = stringValue(filediff.patch);
  if (filediffPatch !== null && filediffPath !== null) return filediffPatch;
  return stringValue(metadata.diff);
}

function editView(state, input, metadata) {
  if (input.delete === true) return null;
  const filediff =
    metadata.filediff && typeof metadata.filediff === "object" ? metadata.filediff : {};
  const rename = stringValue(input.rename);
  const inputPath = firstString(input.filePath, input.path);
  const filediffPath = firstString(filediff.file, filediff.path, filediff.filePath);
  const title = stringValue(state.title);
  const isMove = rename !== null && rename !== inputPath;
  const oldPath = isMove ? inputPath : firstString(inputPath, filediffPath, title);
  const newPath = isMove
    ? firstString(filediffPath, rename, inputPath)
    : firstString(inputPath, filediffPath, title);
  const path = newPath ?? oldPath;

  const patch = combinedEditPatch(input, metadata);
  if (patch === null) return null;

  const clipped = clipDisplay(patch, MAX_DIFF_DISPLAY_BYTES);
  const parsed = parseUnifiedDiff(
    clipped.text,
    isMove
      ? {
          defaultPath: path ?? undefined,
          type: "move",
          oldPath: oldPath ?? undefined,
          newPath: newPath ?? undefined,
          maxFiles: 1,
        }
      : { defaultPath: path ?? undefined, maxFiles: 1 },
  );
  if (parsed.raw || parsed.files.length === 0) return null;
  const target = parsed.files[0];
  if (clipped.clipped) {
    target.truncated = true;
    target.statsPartial = true;
  }
  if (!isMove) {
    target.path = path ?? target.path;
    target.language = resolveLanguage(target.path);
  }

  const display = emptyDisplay();
  if (clipped.clipped) display.perFile = true;
  return diffView("diff", parsed.files, {
    diagnostics: normalizeDiagnostics(metadata.diagnostics),
    filesTruncated: parsed.filesTruncated,
    display,
  });
}

function applyPatchView(state, input, metadata, status) {
  const rawRecords = recordsFromMetadata(metadata);
  const fallbackPath = firstString(input.filePath, input.path, state.title);
  const records =
    rawRecords.length === 1 && fallbackPath !== null && recordPath(rawRecords[0]) === null
      ? [{ ...rawRecords[0], filePath: fallbackPath }]
      : rawRecords;
  const combined = stringValue(metadata.diff);
  const patchText = stringValue(input.patchText);
  const running = status === "running" || status === "pending";
  const diagnostics = normalizeDiagnostics(metadata.diagnostics);

  let files = [];
  let filesTruncated = false;
  const display = emptyDisplay();
  const parseLimited = (record, patch) => {
    const clipped = clipDisplay(patch, MAX_DIFF_DISPLAY_BYTES);
    if (clipped.clipped) display.perFile = true;
    const file = parseRecordPatch(record, clipped.text);
    if (clipped.clipped) {
      file.truncated = true;
      if (file.countsFromMetadata !== true) file.statsPartial = true;
    }
    return file;
  };

  if (hasEveryPatch(records)) {
    const limited = records.slice(0, MAX_DIFF_FILES);
    if (records.length > MAX_DIFF_FILES) {
      filesTruncated = true;
      display.files = true;
    }
    files = limited.map((record) => parseLimited(record, recordPatch(record)));
  } else if (combined !== null) {
    const clipped = clipDisplay(combined, MAX_DIFF_DISPLAY_TOTAL_BYTES);
    if (clipped.clipped) {
      display.total = true;
      filesTruncated = true;
    }
    const parsed = parseUnifiedDiff(clipped.text, { maxFiles: MAX_DIFF_FILES });
    if (parsed.filesTruncated) {
      filesTruncated = true;
      display.files = true;
    }
    const unmatched = new Set(records.keys());
    const merged = [];
    for (const file of parsed.files) {
      const key = file.newPath ?? file.path;
      let match = -1;
      for (let index = 0; index < records.length; index += 1) {
        if (!unmatched.has(index)) continue;
        if (recordPath(records[index]) === key) {
          match = index;
          break;
        }
      }
      if (match === -1) {
        merged.push(file);
        continue;
      }
      unmatched.delete(match);
      const record = records[match];
      const type = typeof record.type === "string" ? record.type : file.type;
      const nextOld = firstString(record.filePath, file.oldPath);
      const nextNew = firstString(
        record.relativePath,
        type === "move" ? record.movePath : null,
        file.newPath,
      );
      const nextPath = nextNew ?? nextOld ?? file.path;
      const countsFromMetadata =
        typeof record.additions === "number" && typeof record.deletions === "number";
      merged.push({
        ...file,
        path: nextPath,
        oldPath: nextOld,
        newPath: nextNew,
        type,
        language: resolveLanguage(nextPath),
        additions: typeof record.additions === "number" ? record.additions : file.additions,
        deletions: typeof record.deletions === "number" ? record.deletions : file.deletions,
        statsPartial: countsFromMetadata ? false : file.statsPartial,
        countsFromMetadata,
      });
    }
    for (const index of unmatched) {
      if (merged.length >= MAX_DIFF_FILES) {
        filesTruncated = true;
        break;
      }
      merged.push(headerOnlyRecord(records[index]));
    }
    files = merged.slice(0, MAX_DIFF_FILES);
    filesTruncated = filesTruncated || parsed.filesTruncated;
  } else if (hasAnyPatch(records)) {
    const limited = records.slice(0, MAX_DIFF_FILES);
    if (records.length > MAX_DIFF_FILES) {
      filesTruncated = true;
      display.files = true;
    }
    files = limited.map((record) => {
      const patch = recordPatch(record);
      return patch === null ? headerOnlyRecord(record) : parseLimited(record, patch);
    });
  } else if (records.length > 0) {
    const limited = records.slice(0, MAX_DIFF_FILES);
    if (records.length > MAX_DIFF_FILES) {
      filesTruncated = true;
      display.files = true;
    }
    files = limited.map((record) => headerOnlyRecord(record));
  } else if (running && patchText !== null) {
    return plainView("diff", patchText, { diagnostics });
  } else {
    return null;
  }

  if (files.length === 0) return null;
  return diffView("diff", files, { diagnostics, filesTruncated, display });
}

function writeView(state, input, metadata, status) {
  if (status === "error") return null;
  if (typeof input.content !== "string") return null;
  const path = firstString(
    input.filePath,
    input.path,
    metadata.filepath,
    state.title,
  );
  const type = metadata.exists === false ? "add" : "update";
  const content = input.content;
  return {
    kind: "write",
    field: "write",
    files: [
      {
        path,
        oldPath: path,
        newPath: path,
        type,
        language: resolveLanguage(path),
        additions: 0,
        deletions: 0,
        statsPartial: false,
        binary: false,
        headerOnly: false,
        truncated: false,
        hunks: [],
        content,
        lineCount: countLines(content),
      },
    ],
    diagnostics: normalizeDiagnostics(metadata.diagnostics),
    filesTruncated: false,
    display: emptyDisplay(),
  };
}

function xmlTagText(source, tag) {
  const open = source.indexOf(`<${tag}>`);
  if (open === -1) return null;
  const start = open + tag.length + 2;
  const close = source.indexOf(`</${tag}>`, start);
  if (close === -1) return null;
  return source.slice(start, close);
}

function numberedReadLine(value) {
  let end = 0;
  while (end < value.length) {
    const code = value.charCodeAt(end);
    if (code < 48 || code > 57) break;
    end += 1;
  }
  if (end === 0 || value[end] !== ":") return null;
  const number = Number.parseInt(value.slice(0, end), 10);
  if (!Number.isSafeInteger(number)) return null;
  let start = end + 1;
  if (value[start] === " ") start += 1;
  return { number, text: value.slice(start) };
}

function readStatusLine(value) {
  let text = value.trim();
  if (text.startsWith("(") && text.endsWith(")")) text = text.slice(1, -1).trim();

  const eof = /^End of file - total (\d+) lines?$/.exec(text);
  if (eof !== null) {
    return { statusLine: text, totalLines: Number.parseInt(eof[1], 10), sourceTruncated: false };
  }
  const range = /^(?:Output capped at \d+ KB\.\s+)?Showing lines (\d+)-(\d+)(?: of (\d+))?\.(?:\s+Use offset=\d+ to continue\.)?$/.exec(
    text,
  );
  if (range !== null) {
    return {
      statusLine: text,
      totalLines: range[3] === undefined ? null : Number.parseInt(range[3], 10),
      sourceTruncated: true,
    };
  }
  return null;
}

function parseReadFile(output, input) {
  const content = xmlTagText(output, "content");
  if (content === null) return null;

  const pathValue = xmlTagText(output, "path");
  const path = firstString(
    pathValue === null ? null : pathValue.trim(),
    input.filePath,
    input.path,
  );
  if (path === null) return null;

  const typeValue = xmlTagText(output, "type");
  const typeLanguage =
    typeValue !== null && CANONICAL_LANGUAGES.has(typeValue.trim()) ? typeValue.trim() : null;

  const raw = content.replace(/\r\n/g, "\n").split("\n");
  while (raw.length > 0 && raw[0].trim() === "") raw.shift();
  while (raw.length > 0 && raw[raw.length - 1].trim() === "") raw.pop();

  const lines = [];
  let status = null;
  let blankCount = 0;
  for (const value of raw) {
    if (value.trim() === "") {
      blankCount += 1;
      continue;
    }
    const numbered = numberedReadLine(value);
    if (numbered !== null) {
      if (blankCount > 0 || status !== null) return null;
      lines.push(numbered);
      continue;
    }
    const parsed = readStatusLine(value);
    if (parsed === null || status !== null) return null;
    status = parsed;
  }

  return {
    path,
    language: resolveLanguage(path) ?? typeLanguage,
    lineStart: lines.length > 0 ? lines[0].number : 0,
    lineEnd: lines.length > 0 ? lines[lines.length - 1].number : 0,
    lineCount: lines.length,
    totalLines: status === null ? null : status.totalLines,
    statusLine: status === null ? "" : status.statusLine,
    sourceTruncated: status !== null && status.sourceTruncated,
    truncated: false,
    content: lines.map((line) => line.text).join("\n"),
    lines,
  };
}

function readView(state, input, status) {
  if (status !== "completed") return null;
  const output = stringValue(state.output);
  if (output === null) return null;
  const file = parseReadFile(output, input);
  if (file === null) return null;
  return {
    kind: "read",
    field: "read",
    files: [file],
    diagnostics: "",
    filesTruncated: false,
    display: emptyDisplay(),
  };
}

/**
 * Build a normalized view from a tool part.
 *
 * Supports standard/hashline `edit`, `apply_patch`, `write`, and a completed `read`. Returns `null`
 * when the part has no usable source or when the tool status is `error`, so callers keep the
 * existing output `<pre>` fallback.
 *
 * @param {Record<string, unknown>} data
 * @param {string} tool
 * @param {"completed" | "running" | "pending" | "error" | string} status
 * @returns {Record<string, unknown> | null}
 */
export function extractToolView(data, tool, status) {
  if (status === "error") return null;
  const state = partState(data);
  const input = partInput(state);
  const metadata = partMetadata(state);

  if (tool === "read") return readView(state, input, status);
  if (tool === "edit" || tool === "hashline_edit") {
    return editView(state, input, metadata);
  }
  if (tool === "apply_patch") {
    return applyPatchView(state, input, metadata, status);
  }
  if (tool === "write") {
    return writeView(state, input, metadata, status);
  }
  return null;
}

/**
 * Normalize the legacy `patch` part without assuming its body is a diff.
 *
 * Precedence: `data.patch` string > `data.files` string list > `data.text` string. A body is parsed;
 * unparseable text becomes a plain view. `data.files` alone is a file-list view.
 *
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
export function patchPartView(data) {
  const record = data && typeof data === "object" ? data : {};
  const patch = stringValue(record.patch);
  if (patch !== null) {
    const parsed = parseUnifiedDiff(patch);
    if (parsed.raw || parsed.files.length === 0) return plainView("patch", patch);
    return diffView("patch", parsed.files, {
      filesTruncated: parsed.filesTruncated,
    });
  }

  if (Array.isArray(record.files)) {
    const paths = record.files.filter((path) => typeof path === "string" && path.length > 0);
    if (paths.length > 0) {
      const limited = paths
        .slice(0, MAX_DIFF_FILES)
        .map((path) => clipDisplay(path, MAX_DIFF_PATH_BYTES).text);
      return {
        kind: "files",
        field: "patch",
        files: limited.map((path) => fileListEntry(path)),
        diagnostics: "",
        filesTruncated: paths.length > MAX_DIFF_FILES,
        display: { ...emptyDisplay(), files: paths.length > MAX_DIFF_FILES },
      };
    }
  }

  const text = stringValue(record.text);
  if (text !== null) {
    const parsed = parseUnifiedDiff(text);
    if (parsed.raw || parsed.files.length === 0) return plainView("patch", text);
    return diffView("patch", parsed.files, {
      filesTruncated: parsed.filesTruncated,
    });
  }

  return plainView("patch", "No patch body");
}

/**
 * Files in a view; always an array.
 *
 * @param {Record<string, unknown> | null | undefined} view
 * @returns {Array<Record<string, unknown>>}
 */
export function diffFilesFromView(view) {
  return view && Array.isArray(view.files) ? view.files : [];
}

function numberOption(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function applyPathCaps(files, pathBytes, pathTotalBytes) {
  let remaining = pathTotalBytes;
  for (const file of files) {
    for (const key of ["path", "oldPath", "newPath"]) {
      if (typeof file[key] !== "string") continue;
      const cap = Math.min(pathBytes, remaining);
      const clipped = clipDisplay(file[key], cap);
      file[key] = clipped.text;
      remaining = Math.max(0, remaining - utf8Bytes(clipped.text));
    }
  }
}

function clipFilePatch(file, cap) {
  if (typeof file.patch !== "string" || utf8Bytes(file.patch) <= cap) return false;
  const clipped = clipDisplay(file.patch, cap);
  if (file.binary === true) {
    file.patch = clipped.text;
    file.truncated = true;
    file.statsPartial = true;
    return true;
  }
  const parsed = parseUnifiedDiff(clipped.text, {
    defaultPath: file.path ?? undefined,
    type: file.type === "binary" ? undefined : file.type,
    oldPath: file.oldPath ?? undefined,
    newPath: file.newPath ?? undefined,
    additions: file.countsFromMetadata === true ? file.additions : undefined,
    deletions: file.countsFromMetadata === true ? file.deletions : undefined,
    maxFiles: 1,
  });
  const fresh = parsed.files[0];
  if (fresh === undefined) {
    file.patch = clipped.text;
    file.truncated = true;
    file.statsPartial = true;
    file.hunks = [];
    file.headerOnly = true;
    return true;
  }
  const countsFromMetadata = file.countsFromMetadata === true;
  Object.assign(file, fresh, {
    patch: clipped.text,
    truncated: true,
    statsPartial: countsFromMetadata ? false : true,
  });
  return true;
}

function capHunkLines(file, maxLines, display) {
  if (!Array.isArray(file.hunks) || file.hunks.length === 0) return;
  let remaining = maxLines;
  let cut = false;
  const hunks = [];
  for (const hunk of file.hunks) {
    if (remaining <= 0) {
      cut = true;
      break;
    }
    const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
    if (lines.length <= remaining) {
      hunks.push({ ...hunk, lines: lines.map((line) => ({ ...line })) });
      remaining -= lines.length;
      continue;
    }
    hunks.push({ ...hunk, lines: lines.slice(0, remaining).map((line) => ({ ...line })) });
    remaining = 0;
    cut = true;
    break;
  }
  if (!cut) return;
  file.hunks = hunks;
  file.truncated = true;
  file.statsPartial = true;
  display.lines = true;
}

function capReadContent(file, capBytes, maxLines, display) {
  const sourceLines = Array.isArray(file.lines) ? file.lines : [];
  const originalCount = sourceLines.length;
  const kept = [];
  let used = 0;
  let cutByBytes = false;
  for (const line of sourceLines) {
    const text = typeof line.text === "string" ? line.text : "";
    const size = utf8Bytes(text) + (kept.length === 0 ? 0 : 1);
    if (used + size > capBytes) {
      cutByBytes = true;
      break;
    }
    kept.push({ ...line, text });
    used += size;
  }
  if (cutByBytes) {
    file.truncated = true;
    display.write = true;
  }
  if (originalCount > maxLines) {
    if (kept.length > maxLines) kept.length = maxLines;
    file.truncated = true;
    display.lines = true;
  }
  file.lines = kept;
  file.lineCount = kept.length;
  file.content = kept.map((line) => line.text).join("\n");
  file.lineStart = kept.length > 0 ? kept[0].number : 0;
  file.lineEnd = kept.length > 0 ? kept[kept.length - 1].number : 0;
}

function capWriteContent(file, capBytes, maxLines, display) {
  if (typeof file.content !== "string") return;
  const clipped = clipDisplay(file.content, capBytes);
  if (clipped.clipped) {
    file.content = clipped.text;
    file.truncated = true;
    display.write = true;
  }
  const lineCount = countLines(file.content);
  if (lineCount > maxLines) {
    file.content = file.content.split("\n").slice(0, maxLines).join("\n");
    file.truncated = true;
    file.lineCount = countLines(file.content);
    display.lines = true;
    return;
  }
  file.lineCount = lineCount;
}

/**
 * Apply the one display allocation rule.
 *
 * Per-file bytes, 128 KiB total by dropping whole trailing records, 50 files, 2,000 lines, and path
 * caps. Never clips an individual patch to fit the total. Input is not mutated.
 *
 * @param {Record<string, unknown>} view
 * @param {{ perFileBytes?: number, totalBytes?: number, writeBytes?: number, readBytes?: number,
 *   maxLines?: number, maxFiles?: number, pathBytes?: number, pathTotalBytes?: number }} [options]
 * @returns {Record<string, unknown>}
 */
export function allocateView(view, options = {}) {
  const source = view && typeof view === "object" ? view : plainView("output", "");
  const out = {
    ...source,
    files: Array.isArray(source.files) ? source.files.map((file) => ({ ...file })) : [],
    display: displayOf(source),
    filesTruncated: source.filesTruncated === true,
  };
  const perFileBytes = numberOption(options.perFileBytes, MAX_DIFF_DISPLAY_BYTES);
  const totalBytes = numberOption(options.totalBytes, MAX_DIFF_DISPLAY_TOTAL_BYTES);
  const writeBytes = numberOption(options.writeBytes, MAX_WRITE_DISPLAY_BYTES);
  const readBytes = numberOption(options.readBytes, MAX_READ_DISPLAY_BYTES);
  const maxLines = numberOption(options.maxLines, MAX_RENDERED_LINES);
  const maxFiles = numberOption(options.maxFiles, MAX_DIFF_FILES);
  const pathBytes = numberOption(options.pathBytes, MAX_DIFF_PATH_BYTES);
  const pathTotalBytes = numberOption(options.pathTotalBytes, MAX_DIFF_PATH_TOTAL_BYTES);

  if (out.files.length > maxFiles) {
    out.files = out.files.slice(0, maxFiles);
    out.filesTruncated = true;
    out.display.files = true;
  }

  if (out.kind === "read") {
    for (const file of out.files) {
      capReadContent(file, readBytes, maxLines, out.display);
    }
    applyPathCaps(out.files, pathBytes, pathTotalBytes);
    return out;
  }

  if (out.kind === "files") {
    applyPathCaps(out.files, pathBytes, pathTotalBytes);
    return out;
  }

  if (out.kind === "write") {
    for (const file of out.files) {
      capWriteContent(file, writeBytes, maxLines, out.display);
    }
    applyPathCaps(out.files, pathBytes, pathTotalBytes);
    return out;
  }

  if (out.kind !== "diff") return out;

  for (const file of out.files) {
    const clipped = clipFilePatch(file, perFileBytes);
    if (clipped) out.display.perFile = true;
  }

  let remaining = totalBytes;
  for (let index = 0; index < out.files.length; index += 1) {
    const file = out.files[index];
    const bytes = typeof file.patch === "string" ? utf8Bytes(file.patch) : 0;
    if (bytes > remaining) {
      out.files = out.files.slice(0, index);
      out.filesTruncated = true;
      out.display.total = true;
      break;
    }
    remaining -= bytes;
  }

  for (const file of out.files) {
    capHunkLines(file, maxLines, out.display);
  }
  applyPathCaps(out.files, pathBytes, pathTotalBytes);
  return out;
}

const LIVE_FIELD_TEXT = {
  diff: "Diff",
  write: "Content",
  read: "File content",
  content: "Content",
  patch: "Diff",
  output: "Output",
};
const SNAPSHOT_FIELD_TEXT = {
  diff: "diff",
  write: "content",
  read: "file content",
  content: "content",
  patch: "diff",
  output: "output",
};

function noticeField(serverFields, view) {
  if (view && view.field === "read") return "read";
  if (serverFields.includes("state.input.content")) return "write";
  if (
    serverFields.some(
      (field) =>
        field === "state.metadata.diff" ||
        field === "state.metadata.filediff.patch" ||
        field === "state.input.patchText" ||
        field === "state.metadata.files.length" ||
        /^state\.metadata\.files(\[|\.)/.test(field),
    )
  ) {
    return "diff";
  }
  if (serverFields.includes("patch")) return "patch";
  if (serverFields.includes("state.output")) return "output";
  if (serverFields.includes("more")) return "diff";
  if (view && typeof view.field === "string") return view.field;
  const kind = view && typeof view.kind === "string" ? view.kind : "";
  if (kind === "write") return "write";
  if (kind === "read") return "read";
  if (kind === "diff") return "diff";
  if (kind === "files") return "patch";
  return "output";
}

/**
 * Select the exact truncation notice from design section 5.5.
 *
 * @param {Record<string, unknown>} part
 * @param {string} status
 * @param {TruncationView | Record<string, unknown> | null | undefined} view
 * @returns {string}
 */
export function truncationNotice(part, status, view) {
  const record = part && typeof part === "object" ? part : {};
  const truncation =
    record.truncation && typeof record.truncation === "object" ? record.truncation : {};
  const serverFields = Array.isArray(view?.serverFields)
    ? view.serverFields
    : Array.isArray(truncation.fields)
      ? truncation.fields
      : [];
  const serverLimit =
    typeof view?.serverLimit === "string"
      ? view.serverLimit
      : typeof truncation.limit === "string"
        ? truncation.limit
        : undefined;
  const omitted = view?.omitted === true || record.omitted === true;
  const display = {
    ...emptyDisplay(),
    ...(view && typeof view.display === "object" ? view.display : {}),
  };
  if (serverLimit === "per-file") display.perFile = true;
  else if (serverLimit === "total") display.total = true;
  else if (serverLimit === "content") display.write = true;
  else if (serverLimit === "files") display.files = true;

  if (omitted) return "Result omitted; it exceeded the 256 KiB stream budget.";

  const field = noticeField(serverFields, view);
  const partial = record.partial === true || record.truncated === true;
  if ((status === "running" || status === "pending") && partial) {
    const label = LIVE_FIELD_TEXT[field] ?? "Diff";
    return `${label} truncated for live view; the full result may load when the turn ends.`;
  }
  const snapshot =
    view?.sessionSnapshotTooLarge === true || record.sessionSnapshotTooLarge === true;
  if (status === "completed" && snapshot) {
    const label = SNAPSHOT_FIELD_TEXT[field] ?? "diff";
    return `Full ${label} unavailable; session snapshot exceeds 8 MiB.`;
  }

  const seeded =
    display.write || display.total || display.perFile || display.lines || display.files;
  if (!partial && !seeded && serverLimit === undefined) return "";

  if (display.write) {
    return field === "read"
      ? "File content truncated at 64 KiB."
      : "Content truncated at 64 KiB.";
  }
  if (display.total) return "Diff truncated at the 128 KiB total limit.";
  if (display.perFile) return "Diff truncated at 64 KiB per file.";
  if (display.lines) {
    if (field === "read") return "File content truncated at 2,000 lines.";
    return field === "write"
      ? "Content truncated at 2,000 lines."
      : "Diff truncated at 2,000 lines.";
  }
  if (display.files) return "Additional files omitted from the view.";

  if (field === "diff" && serverLimit === "per-file") {
    return "Diff truncated at 64 KiB per file.";
  }
  if (field === "diff" && serverLimit === "total") {
    return "Diff truncated at the 128 KiB total limit.";
  }
  if (field === "write" || serverLimit === "content") return "Content truncated at 64 KiB.";
  if (field === "read") return "File content truncated at 64 KiB.";
  if (field === "patch" || serverLimit === "patch") return "Patch truncated at 64 KiB.";
  if (field === "output" || serverLimit === "output") return "Output truncated at 64 KiB.";
  return "";
}
