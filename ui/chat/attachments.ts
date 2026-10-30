/**
 * Pure attachment transport helpers: client limits, header encoding, error text, and chip view
 * mapping. Upload I/O and lifecycle stay in `useChatComposer`; this module has no DOM or timers.
 */

import type { AttachmentView } from "../../assets/chat-core.js";

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_CONCURRENT_UPLOADS = 2;
export const ATTACHMENT_QUOTA_WARN_PERCENT = 80;

export type AttachmentChipStatus = "uploading" | "ready" | "error";

export interface AttachmentChip extends AttachmentView {
  readonly key: string;
  status: AttachmentChipStatus;
  progress: number;
  error: string | null;
  errorCode: string | null;
  started: boolean;
  sessionID: string | null;
  file: File | null;
}

export function attachmentErrorMessage(error: unknown): string {
  const base =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Upload failed";
  const code =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  return code.length > 0 && !base.includes(code) ? `${base} (${code})` : base;
}

export function contentDispositionFor(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function chipFromView(view: AttachmentView, key = view.id): AttachmentChip {
  return {
    ...view,
    key,
    status: "ready",
    progress: 100,
    error: null,
    errorCode: null,
    started: true,
    sessionID: null,
    file: null,
  };
}

export function chipFromFile(file: File, key: string): AttachmentChip {
  return {
    key,
    id: "",
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    kind: "file",
    mode: "auto",
    state: "draft",
    downloadURL: "",
    inline: false,
    status: "uploading",
    progress: 0,
    error: null,
    errorCode: null,
    started: false,
    sessionID: null,
    file,
  };
}

export function localAttachmentKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `local_att_${crypto.randomUUID()}`;
  }
  return `local_att_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function attachmentStateText(state: AttachmentChip["state"]): string {
  if (state === "missing") return "Missing";
  if (state === "in_flight") return "Sending…";
  if (state === "sent") return "Sent";
  return "";
}
