/** Attachment storage, quota, and delivery constants (design §D8). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 250 * 1024 * 1024;
export const ATTACHMENT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_CONCURRENT_UPLOADS_PER_APP = 2;
export const MAX_GLOBAL_INFLIGHT_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_FILENAME_BYTES = 255;
/** `<id>-` prefix plus the safe name must stay inside the common filesystem name limit. */
export const MAX_STORED_NAME_BYTES = 255;
export const UPLOAD_RECONCILE_AGE_MS = 15 * 60 * 1000;
export const TEMP_ORPHAN_AGE_MS = 60 * 60 * 1000;
export const FILE_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

export type AttachmentKind = "image" | "video" | "pdf" | "file";
export type AttachmentMode = "auto" | "inline" | "file";
export type AttachmentState = "uploading" | "available" | "missing";
export type DeliveryState = "sending" | "sent" | "unknown" | "failed";
export type AttachmentViewState = "draft" | "in_flight" | "sent" | "missing";

export interface AttachmentRow {
  id: string;
  appId: string;
  sessionId: string;
  originalName: string;
  storedName: string | null;
  relPath: string | null;
  tempRelPath: string | null;
  mime: string | null;
  size: number | null;
  declaredSize: number | null;
  kind: AttachmentKind | null;
  mode: AttachmentMode;
  state: AttachmentState;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryRow {
  id: string;
  attachmentId: string;
  appId: string;
  sessionId: string;
  partId: string | null;
  messageId: string;
  state: DeliveryState;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Shared projection for the upload/draft/history surfaces (design §D3). */
export interface AttachmentView {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  mode: AttachmentMode;
  state: AttachmentViewState;
  downloadURL: string;
  inline: boolean;
}

/** A per-send attachment reference persisted in `pending_sends.attachments_json`. */
export interface RequestedAttachment {
  id: string;
  mode?: AttachmentMode;
}
