import { INLINE_MAX_BYTES } from "./inline.js";
import { isInlineSafeMime } from "./mime.js";
import { safeOriginalName } from "./names.js";

/** The inline route waits this long for the history read budget before returning `inline_busy`. */
export const INLINE_READ_BUDGET_WAIT_MS = 10_000;

export interface InlineMediaTarget {
  appKey: string;
  projectId: string;
}

export interface InlineMediaIds {
  sessionID: string;
  messageID: string;
  partID: string;
}

export interface ParsedInlineDataUrl {
  mime: string;
  base64: string;
  base64Length: number;
  size: number;
}

const INLINE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

/** Same-origin route that serves one persisted message part on demand. */
export function inlineMediaRoute(target: InlineMediaTarget, ids: InlineMediaIds): string {
  const encode = encodeURIComponent;
  return `/api/apps/${encode(target.appKey)}/sessions/${encode(ids.sessionID)}/messages/${encode(ids.messageID)}/parts/${encode(ids.partID)}/inline?project=${encode(target.projectId)}`;
}

/**
 * Parse a strict inline image data URL. Only the four inline-safe MIMEs with a canonical base64
 * payload are accepted; the decoded size is estimated without allocating the payload.
 */
export function parseInlineDataUrl(value: unknown): ParsedInlineDataUrl | null {
  if (typeof value !== "string") return null;
  const match = INLINE_DATA_URL.exec(value);
  if (match === null) return null;
  const mime = match[1];
  const base64 = match[2];
  if (mime === undefined || base64 === undefined) return null;
  if (base64.length === 0) return null;
  if (base64.length % 4 !== 0) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  if (padding > 0 && base64.length < 4) return null;
  const size = (base64.length / 4) * 3 - padding;
  if (size <= 0) return null;
  return { mime, base64, base64Length: base64.length, size };
}

/**
 * Decode a parsed data URL. A caller that passes `maxBytes` (the HEAD sniff) decodes only the base64
 * characters that could carry that many bytes.
 */
export function decodeInlineDataUrl(parsed: ParsedInlineDataUrl, maxBytes?: number): Buffer {
  const base64 =
    maxBytes === undefined ? parsed.base64 : parsed.base64.slice(0, Math.ceil(maxBytes / 3) * 4);
  return Buffer.from(base64, "base64");
}

/**
 * Rewrite an unknown image `file` part into an inline attachment view. Returns `null` for anything
 * that does not qualify; never throws on hostile input.
 */
export function inlineImagePart(
  part: Record<string, unknown>,
  ids: InlineMediaIds,
  target: InlineMediaTarget,
): Record<string, unknown> | null {
  try {
    const partID = typeof part.id === "string" && part.id.length > 0 ? part.id : undefined;
    if (partID === undefined) return null;
    if (ids.sessionID.length === 0 || ids.messageID.length === 0) return null;
    const mime = part.mime;
    if (typeof mime !== "string" || !isInlineSafeMime(mime)) return null;
    const parsed = parseInlineDataUrl(part.url);
    if (parsed === null) return null;
    if (parsed.size < 1 || parsed.size > INLINE_MAX_BYTES) return null;
    const rawName = typeof part.filename === "string" ? part.filename : "";
    return {
      ...part,
      filename: safeOriginalName(rawName) || "image",
      url: inlineMediaRoute(target, {
        sessionID: ids.sessionID,
        messageID: ids.messageID,
        partID,
      }),
      attachment: { id: partID, size: parsed.size, mode: "inline", kind: "image", inline: true },
    };
  } catch {
    return null;
  }
}
