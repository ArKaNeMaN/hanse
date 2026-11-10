import { sanitizeProcessError } from "../../opencode/process-errors.js";

/** Rich messages allow 32768 UTF-8 characters; keep a code-point budget below it. */
export const RICH_CHAR_BUDGET = 30_000;
export const RICH_BYTE_BUDGET = 32_768;
/** `sendMessage` allows 4096 UTF-16 units; keep a margin for entities and emoji. */
export const PLAIN_CHAR_BUDGET = 4_000;
export const MAX_GROUP_CHUNKS = 20;
export const MAX_RICH_BLOCKS = 500;
export const MAX_TABLE_COLUMNS = 20;
export const TRUNCATED_MARKER = "[truncated]";

export type NotificationKind =
  | "turn_completed"
  | "question"
  | "permission"
  | "ssh_approval"
  | "handoff_approval"
  | "handoff_waiting_operator"
  | "handoff_failed"
  | "thread_message_waiting"
  | "agent_interrupted";

export interface TelegramLink {
  text: string;
  url: string;
}

export interface TelegramChunk {
  format: "rich" | "plain";
  text: string;
}

export interface PlainChunk {
  text: string;
  link?: TelegramLink;
}

export interface NotificationBodyInput {
  kind: NotificationKind;
  projectName: string;
  appName?: string | null;
  sessionTitle?: string | null;
  answer?: string | null;
  includeAnswer?: boolean;
  questionHeader?: string | null;
  question?: string | null;
  options?: readonly string[] | null;
  permission?: string | null;
  tool?: string | null;
  patterns?: readonly string[] | string | null;
  command?: string | null;
  host?: string | null;
  action?: string | null;
  commandPreview?: string | null;
  expiresAt?: string | Date | null;
  source?: string | null;
  target?: string | null;
  summary?: string | null;
  state?: string | null;
  reason?: string | null;
  message?: string | null;
}

export interface NotificationLinkInput {
  publicBaseUrl?: string | null;
  projectId?: string | null;
  appKey?: string | null;
  sessionId?: string | null;
}

export interface FormatMessageInput extends NotificationBodyInput, NotificationLinkInput {
  link?: TelegramLink | null;
  secrets?: Iterable<string | null | undefined>;
}

export interface FormattedTelegramMessage {
  body: string;
  chunks: TelegramChunk[];
  link?: TelegramLink;
  truncated: boolean;
}

interface FormattedPart {
  format: "rich" | "plain";
  text: string;
}

function codePoints(text: string): number {
  let count = 0;
  for (const _character of text) count += 1;
  return count;
}

/** Plain `sendMessage` counts both code points and UTF-16 units (emoji are two units). */
function plainLength(text: string): number {
  return Math.max(codePoints(text), text.length);
}

function richFits(text: string): boolean {
  return (
    codePoints(text) <= RICH_CHAR_BUDGET && Buffer.byteLength(text, "utf8") <= RICH_BYTE_BUDGET
  );
}

function plainFits(text: string): boolean {
  return plainLength(text) <= PLAIN_CHAR_BUDGET;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

function textOf(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function joinLines(lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

/** Sanitize diagnostic text before it reaches a message (design §5.3). */
export function sanitizeNotificationText(
  value: unknown,
  secrets: Iterable<string | null | undefined> = [],
): string {
  return sanitizeProcessError(value, { secrets });
}

function patternsText(patterns: readonly string[] | string | null | undefined): string | undefined {
  if (typeof patterns === "string") return nonEmpty(patterns);
  if (!Array.isArray(patterns)) return undefined;
  const values = patterns.filter((pattern) => pattern.trim().length > 0);
  return values.length > 0 ? values.join(", ") : undefined;
}

function expiryText(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? nonEmpty(value) : parsed.toISOString();
}

function heading(projectName: string, appName: string | null | undefined): string {
  const project = nonEmpty(projectName) ?? "Project";
  const app = nonEmpty(appName);
  return app === undefined ? project : `${project} / ${app}`;
}

/** Build the plain-label message body for one notification kind (design §5.3). */
export function formatNotificationBody(
  input: NotificationBodyInput,
  options: { secrets?: Iterable<string | null | undefined> } = {},
): string {
  const secrets = options.secrets ?? [];
  const project = nonEmpty(input.projectName) ?? "Project";
  const app = nonEmpty(input.appName);
  const title = nonEmpty(input.sessionTitle);
  const header = heading(project, app);
  const sanitized = (value: unknown): string => sanitizeNotificationText(value, secrets);

  switch (input.kind) {
    case "turn_completed": {
      const answer = nonEmpty(input.answer);
      const body =
        input.includeAnswer === false || answer === undefined ? "Done" : textOf(input.answer);
      return joinLines([header, title, "", body]);
    }
    case "question": {
      const questionHeader = nonEmpty(input.questionHeader);
      const question = nonEmpty(input.question);
      const optionsList = (input.options ?? [])
        .filter((option) => option.trim().length > 0)
        .map((option) => `- ${option}`)
        .join("\n");
      return joinLines([
        `${header} - needs an answer`,
        title,
        "",
        questionHeader === undefined ? undefined : `**${questionHeader}**`,
        question,
        optionsList.length > 0 ? optionsList : undefined,
      ]);
    }
    case "permission": {
      const permission = nonEmpty(input.permission) ?? "Permission required";
      const tool = nonEmpty(input.tool);
      const patterns = patternsText(input.patterns);
      const command = nonEmpty(input.command);
      return joinLines([
        `${header} - permission required`,
        title,
        tool === undefined ? permission : `${permission} (${tool})`,
        patterns === undefined ? undefined : sanitized(patterns),
        command === undefined ? undefined : sanitized(command),
      ]);
    }
    case "ssh_approval": {
      const host = nonEmpty(input.host) ?? "Unknown host";
      const action = nonEmpty(input.action) ?? "approval";
      const preview = nonEmpty(input.commandPreview);
      const expires = expiryText(input.expiresAt);
      return joinLines([
        `${header} - SSH approval`,
        `${host} - ${action}`,
        preview === undefined ? undefined : sanitized(preview),
        expires === undefined ? undefined : `Expires ${expires}.`,
      ]);
    }
    case "handoff_approval":
      return joinLines([
        `${project} - handoff approval`,
        handoffRoute(input),
        nonEmpty(input.summary),
      ]);
    case "handoff_waiting_operator":
      return joinLines([
        `${project} - handoff reply needs an operator`,
        handoffRoute(input),
        nonEmpty(input.summary),
      ]);
    case "handoff_failed": {
      const state = nonEmpty(input.state);
      const reason = nonEmpty(input.reason);
      return joinLines([
        `${project} - handoff failed`,
        handoffRoute(input),
        state === undefined && reason === undefined
          ? undefined
          : sanitized([state, reason].filter((part) => part !== undefined).join(" / ")),
      ]);
    }
    case "thread_message_waiting":
      return joinLines([
        `${project} - thread message needs an operator`,
        handoffRoute(input),
        nonEmpty(input.summary) === undefined
          ? undefined
          : sanitized(nonEmpty(input.summary) ?? ""),
        nonEmpty(input.message) === undefined
          ? undefined
          : sanitized(nonEmpty(input.message) ?? ""),
      ]);
    case "agent_interrupted":
      return joinLines([
        `${header} - agent interrupted`,
        title,
        sanitized(nonEmpty(input.message) ?? "The agent stopped unexpectedly."),
      ]);
  }
}

function handoffRoute(input: NotificationBodyInput): string {
  const source = nonEmpty(input.source) ?? "source";
  const target = nonEmpty(input.target) ?? "target";
  return `${source} -> ${target}`;
}

/** Build the session/app/project link button (design §5.3). */
export function buildTelegramLink(input: NotificationLinkInput): TelegramLink | undefined {
  const base = nonEmpty(input.publicBaseUrl)?.replace(/\/+$/, "");
  if (base === undefined) return undefined;
  const projectId = nonEmpty(input.projectId);
  const appKey = nonEmpty(input.appKey);
  const sessionId = nonEmpty(input.sessionId);
  if (projectId !== undefined && appKey !== undefined && sessionId !== undefined) {
    return {
      text: "Open session",
      url: `${base}/chat?app=${encodeURIComponent(appKey)}&project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(sessionId)}`,
    };
  }
  if (projectId !== undefined && appKey !== undefined) {
    return {
      text: "Open app",
      url: `${base}/chat?app=${encodeURIComponent(appKey)}&project=${encodeURIComponent(projectId)}`,
    };
  }
  if (projectId !== undefined) {
    return { text: "Open project", url: `${base}/projects/${encodeURIComponent(projectId)}` };
  }
  return undefined;
}

function matchFence(line: string): { marker: string; lang: string } | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return undefined;
  const marker = match[1];
  if (marker === undefined) return undefined;
  const rest = match[2] ?? "";
  return { marker, lang: rest.trim().split(/\s+/)[0] ?? "" };
}

/** Split on blank-line blocks while keeping a fenced code block together. */
function splitBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };
  for (const line of markdown.split("\n")) {
    const fence = matchFence(line);
    if (fence !== undefined) inFence = !inFence;
    if (!inFence && line.trim().length === 0) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function openFenceAtEnd(text: string): { marker: string; lang: string } | undefined {
  let open: { marker: string; lang: string } | undefined;
  for (const line of text.split("\n")) {
    const fence = matchFence(line);
    if (fence === undefined) continue;
    if (open === undefined) {
      open = fence;
    } else if (fence.marker[0] === open.marker[0] && fence.marker.length >= open.marker.length) {
      open = undefined;
    }
  }
  return open;
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  if (trimmed.startsWith("|") || trimmed.endsWith("|")) return true;
  return trimmed.split("|").length >= 2;
}

function isTableBlock(block: string): boolean {
  return block.split("\n").some((line) => isTableRow(line));
}

function maxTableColumns(block: string): number {
  let max = 0;
  for (const line of block.split("\n")) {
    if (!isTableRow(line)) continue;
    const trimmed = line.trim();
    let columns = trimmed.split("|").length;
    if (trimmed.startsWith("|")) columns -= 1;
    if (trimmed.endsWith("|")) columns -= 1;
    max = Math.max(max, columns);
  }
  return max;
}

/** Approximate Telegram's block count: paragraphs, list items, table rows, quotes, headings. */
export function countRichBlocks(markdown: string): number {
  let count = 0;
  let paragraphOpen = false;
  let inFence = false;
  for (const line of markdown.split("\n")) {
    const fence = matchFence(line);
    if (fence !== undefined) {
      if (!inFence) count += 1;
      inFence = !inFence;
      paragraphOpen = false;
      continue;
    }
    if (inFence) continue;
    if (line.trim().length === 0) {
      paragraphOpen = false;
      continue;
    }
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("- ") ||
      trimmed.startsWith("* ") ||
      trimmed.startsWith("+ ") ||
      /^\d+[.)]\s/.test(trimmed) ||
      trimmed.startsWith(">") ||
      trimmed.startsWith("#") ||
      isTableRow(line)
    ) {
      count += 1;
      paragraphOpen = false;
      continue;
    }
    if (!paragraphOpen) {
      count += 1;
      paragraphOpen = true;
    }
  }
  return count;
}

function maxPrefixIndex(text: string, maxCodePoints: number, maxBytes: number): number {
  let index = 0;
  let points = 0;
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (points + 1 > maxCodePoints || bytes + size > maxBytes) break;
    points += 1;
    bytes += size;
    index += character.length;
  }
  return Math.max(1, index);
}

function linkRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /\[[^\]]*\]\([^)]*\)/g;
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) break;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/** Find the last safe split point before `maxIndex`, avoiding inline links and table rows. */
function findSplitIndex(text: string, maxIndex: number): number {
  const limit = Math.min(maxIndex, text.length);
  if (limit >= text.length) return text.length;
  let candidate = text.lastIndexOf("\n", limit - 1);
  if (candidate <= 0) candidate = text.lastIndexOf(" ", limit - 1);
  if (candidate <= 0) candidate = limit;
  for (const range of linkRanges(text)) {
    if (candidate > range.start && candidate < range.end) {
      candidate = range.start > 0 ? range.start : Math.min(range.end, text.length);
      break;
    }
  }
  const lineStart = text.lastIndexOf("\n", candidate - 1) + 1;
  const lineEnd = text.indexOf("\n", candidate);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  if (isTableRow(line) && candidate > lineStart) candidate = lineStart;
  if (candidate <= 0) candidate = limit;
  if (candidate > 0 && candidate < text.length) {
    const before = text.charCodeAt(candidate - 1);
    const after = text.charCodeAt(candidate);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      candidate -= 1;
    }
  }
  return candidate > 0 ? candidate : 1;
}

function splitLongRichBlock(block: string): string[] {
  const parts: string[] = [];
  let rest = block;
  while (!richFits(rest)) {
    const limit = maxPrefixIndex(rest, RICH_CHAR_BUDGET - 10, RICH_BYTE_BUDGET - 20);
    const index = findSplitIndex(rest, limit);
    let prefix = rest.slice(0, index).trimEnd();
    let suffix = rest.slice(index).replace(/^\s+/, "");
    const open = openFenceAtEnd(prefix);
    if (open !== undefined) {
      prefix = `${prefix}\n${open.marker}`;
      suffix = `${open.marker}${open.lang}\n${suffix}`;
    }
    parts.push(prefix);
    rest = suffix;
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

function splitLongPlainBlock(block: string, budget = PLAIN_CHAR_BUDGET): string[] {
  const parts: string[] = [];
  let rest = block;
  while (plainLength(rest) > budget) {
    const limit = maxPrefixIndex(rest, budget, budget);
    const index = findSplitIndex(rest, limit);
    parts.push(rest.slice(0, index).trimEnd());
    rest = rest.slice(index).replace(/^\s+/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

function tableCells(row: string): string[] {
  const trimmed = row.trim();
  const cells = trimmed.split("|").map((cell) => cell.trim());
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|")) cells.pop();
  return cells;
}

function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  return /^\|?[\s:|-]+\|?$/.test(trimmed);
}

function splitOversizedTableRow(row: string, maxLength = PLAIN_CHAR_BUDGET): string[] {
  const trimmed = row.trim();
  const cells = tableCells(row);
  if (cells.length <= 1) return splitLongPlainBlock(row, maxLength);
  const leading = trimmed.startsWith("|") ? "| " : "";
  const trailing = trimmed.endsWith("|") ? " |" : "";
  const cellBudget = Math.max(1, maxLength - leading.length - trailing.length);
  const parts: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    parts.push(`${leading}${current.join(" | ")}${trailing}`);
    current = [];
  };
  for (const cell of cells) {
    if (plainLength(cell) > cellBudget) {
      flush();
      for (const piece of splitLongPlainBlock(cell, cellBudget)) parts.push(piece);
      continue;
    }
    if (current.length === 0) {
      current.push(cell);
      continue;
    }
    const candidate = `${leading}${[...current, cell].join(" | ")}${trailing}`;
    if (plainLength(candidate) <= maxLength) {
      current.push(cell);
    } else {
      flush();
      current.push(cell);
    }
  }
  flush();
  return parts;
}

function chunkTablePlain(block: string): string[] {
  const lines = block.split("\n").filter((line) => line.trim().length > 0);
  const header = lines[0];
  if (header === undefined) return [];
  const separator = lines[1] !== undefined && isSeparatorRow(lines[1]) ? lines[1] : undefined;
  const dataRows = lines.slice(separator === undefined ? 1 : 2);
  const headerText = separator === undefined ? header : `${header}\n${separator}`;
  if (!plainFits(headerText)) return splitLongPlainBlock(headerText);
  const rowBudget = Math.max(1, PLAIN_CHAR_BUDGET - plainLength(headerText) - 1);
  const parts: string[] = [];
  let currentRows: string[] = [];
  const flush = (): void => {
    if (currentRows.length === 0) return;
    parts.push([headerText, ...currentRows].join("\n"));
    currentRows = [];
  };
  for (const row of dataRows) {
    if (plainFits([headerText, ...currentRows, row].join("\n"))) {
      currentRows.push(row);
      continue;
    }
    flush();
    if (plainFits([headerText, row].join("\n"))) {
      currentRows.push(row);
      continue;
    }
    for (const piece of splitOversizedTableRow(row, rowBudget)) {
      if (plainFits([headerText, ...currentRows, piece].join("\n"))) {
        currentRows.push(piece);
      } else {
        flush();
        currentRows.push(piece);
      }
    }
  }
  flush();
  return parts.length > 0 ? parts : [headerText];
}

/** Split plain text into 4000-character rows, keeping table headers on every part. */
export function chunkPlainText(text: string): string[] {
  const parts: string[] = [];
  for (const block of splitBlocks(text)) {
    if (isTableBlock(block)) {
      parts.push(...chunkTablePlain(block));
    } else if (plainFits(block)) {
      parts.push(block);
    } else {
      parts.push(...splitLongPlainBlock(block));
    }
  }
  if (parts.length === 0) return [text];
  return parts;
}

/** Re-chunk the remaining rich suffix into a new plain group (design §5.1). */
export function planPlainFallback(
  richChunks: readonly string[],
  link?: TelegramLink,
): PlainChunk[] {
  const combined = richChunks.filter((chunk) => chunk.trim().length > 0).join("\n\n");
  const rows = chunkPlainText(combined);
  const chunks: PlainChunk[] = rows.map((text) => ({ text }));
  const last = chunks[chunks.length - 1];
  if (last !== undefined && link !== undefined) last.link = link;
  return chunks;
}

function packParts(parts: readonly FormattedPart[]): TelegramChunk[] {
  const chunks: TelegramChunk[] = [];
  let current: FormattedPart | undefined;
  for (const part of parts) {
    if (current === undefined) {
      current = { ...part };
      continue;
    }
    if (current.format !== part.format) {
      chunks.push(current);
      current = { ...part };
      continue;
    }
    const candidate = `${current.text}\n\n${part.text}`;
    const fits = current.format === "rich" ? richFits(candidate) : plainFits(candidate);
    if (fits) {
      current.text = candidate;
    } else {
      chunks.push(current);
      current = { ...part };
    }
  }
  if (current !== undefined) chunks.push(current);
  return chunks;
}

/** Chunk a Markdown body into rich rows, with plain rows where Telegram's limits require it. */
export function chunkTelegramMarkdown(markdown: string): {
  chunks: TelegramChunk[];
  truncated: boolean;
} {
  const parts: FormattedPart[] = [];
  for (const block of splitBlocks(markdown)) {
    const table = isTableBlock(block);
    const rowTooLarge =
      table && block.split("\n").some((line) => isTableRow(line) && !richFits(line));
    if (table && (maxTableColumns(block) > MAX_TABLE_COLUMNS || rowTooLarge)) {
      for (const text of chunkTablePlain(block)) parts.push({ format: "plain", text });
      continue;
    }
    if (countRichBlocks(block) > MAX_RICH_BLOCKS) {
      for (const text of chunkPlainText(block)) parts.push({ format: "plain", text });
      continue;
    }
    if (!richFits(block)) {
      for (const text of splitLongRichBlock(block)) parts.push({ format: "rich", text });
      continue;
    }
    parts.push({ format: "rich", text: block });
  }

  let chunks = packParts(parts);
  if (chunks.length === 0) chunks = [{ format: "rich", text: markdown }];
  if (chunks.length <= MAX_GROUP_CHUNKS) return { chunks, truncated: false };

  const kept = chunks.slice(0, MAX_GROUP_CHUNKS - 1);
  const lastFormat = kept[kept.length - 1]?.format ?? "rich";
  kept.push({
    format: lastFormat,
    text: lastFormat === "rich" ? `\n\n_${TRUNCATED_MARKER}_` : `\n\n${TRUNCATED_MARKER}`,
  });
  return { chunks: kept, truncated: true };
}

/** Build the complete notification body, chunk rows, and link button. */
export function formatTelegramMessage(input: FormatMessageInput): FormattedTelegramMessage {
  const body = formatNotificationBody(input, { secrets: input.secrets });
  const link = input.link ?? buildTelegramLink(input);
  const { chunks, truncated } = chunkTelegramMarkdown(body);
  return link === undefined ? { body, chunks, truncated } : { body, chunks, link, truncated };
}
