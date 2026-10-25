import path from "node:path";
import { MAX_FILENAME_BYTES, MAX_STORED_NAME_BYTES } from "./types.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: filename sanitizing removes C0/DEL/line separators.
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;
const SEPARATORS = /[\\/]+/g;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

/**
 * Produce a single-line, separator-free display name. Never throws for hostile bytes: an empty
 * result is rejected by the caller as `invalid_filename`.
 */
export function safeOriginalName(raw: string): string {
  const normalized = raw.normalize("NFC").replace(CONTROL, "").replace(SEPARATORS, "-");
  const base = path.posix.basename(normalized.replace(/\\/g, "/")).trim();
  // `.`/`..` are path segments, never filenames; leading dots would create hidden files.
  const withoutDots = base.replace(/^[.\s-]+/, "").replace(/[.\s]+$/, "");
  return truncateUtf8(withoutDots, MAX_FILENAME_BYTES);
}

/** Stored name is `<attachmentId>-<safeName>`, capped so the whole file name fits. */
export function storedNameFor(id: string, safeName: string): string {
  const prefix = `${id}-`;
  const remaining = Math.max(1, MAX_STORED_NAME_BYTES - Buffer.byteLength(prefix, "utf8"));
  const trimmed = truncateUtf8(safeName, remaining).replace(/^[.\s]+|[.\s]+$/g, "");
  return `${prefix}${trimmed.length > 0 ? trimmed : "file"}`;
}

function decodePercent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * Read a filename from a `Content-Disposition` header. `filename*` wins over the plain fallback and
 * is decoded as RFC 5987 UTF-8 when present.
 */
export function filenameFromContentDisposition(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(value);
  if (extended?.[1] !== undefined) {
    const decoded = decodePercent(extended[1].trim());
    if (decoded !== undefined) return decoded;
  }
  const extendedAny = /filename\*\s*=\s*([^;]+)/i.exec(value);
  if (extendedAny?.[1] !== undefined) {
    const raw = extendedAny[1].trim();
    const encoded = raw.replace(/^[^']*'[^']*'/, "");
    const decoded = decodePercent(encoded);
    if (decoded !== undefined) return decoded;
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(value);
  const candidate = plain?.[1] ?? plain?.[2];
  if (candidate === undefined) return undefined;
  const trimmed = candidate.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** RFC 5987 encoded header value; the original name is never placed raw in a header. */
export function encodeContentDisposition(
  disposition: "inline" | "attachment",
  name: string,
): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
