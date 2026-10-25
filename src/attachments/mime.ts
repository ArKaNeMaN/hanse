import type { AttachmentKind } from "./types.js";

export interface SniffedFile {
  mime: string;
  kind: AttachmentKind;
}

function startsWith(head: Buffer, bytes: readonly number[]): boolean {
  if (head.length < bytes.length) return false;
  return bytes.every((byte, index) => head[index] === byte);
}

function ascii(head: Buffer, offset: number, length: number): string {
  return head.subarray(offset, offset + length).toString("latin1");
}

const TEXT_EXTENSIONS: Record<string, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
};

/**
 * Sniff the MIME type from magic bytes. SVG and HTML are deliberately `file`, never `image`; the
 * repository treats them as untrusted documents and serves them as attachments.
 */
export function sniffMime(head: Buffer, filename: string): SniffedFile {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", kind: "image" };
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", kind: "image" };
  }
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") {
    return { mime: "image/gif", kind: "image" };
  }
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") {
    return { mime: "image/webp", kind: "image" };
  }
  if (ascii(head, 0, 5) === "%PDF-") {
    return { mime: "application/pdf", kind: "pdf" };
  }

  const brand = ascii(head, 4, 4);
  if (["ftyp", "moov", "mdat", "wide"].includes(brand)) {
    return { mime: "video/mp4", kind: "video" };
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mime: "video/webm", kind: "video" };
  }
  if (ascii(head, 0, 4) === "OggS") {
    return { mime: "video/ogg", kind: "video" };
  }

  const textHead = head.subarray(0, Math.min(head.length, 512));
  const text = textHead.toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<?xml") || text.startsWith("<svg") || text.startsWith("<!doctype svg")) {
    return { mime: "image/svg+xml", kind: "file" };
  }
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) {
    return { mime: "text/html", kind: "file" };
  }

  // Keep recognized text formats useful to the agent; everything else is an opaque file.
  const extension = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  const textMime = TEXT_EXTENSIONS[extension];
  if (textMime !== undefined) {
    return { mime: textMime, kind: "file" };
  }
  return { mime: "application/octet-stream", kind: "file" };
}

/** Only these four image types may ever be served inline. */
export function isInlineSafeMime(mime: string | null): boolean {
  return (
    mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp"
  );
}
