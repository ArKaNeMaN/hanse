import type { AttachmentView } from "../attachments/types.js";

export const MAX_AGENT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_CONCURRENT_AGENT_IMAGES_PER_APP = 2;
export const MAX_GLOBAL_INFLIGHT_AGENT_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_AGENT_IMAGE_CAPTION = 200;
export const MAX_AGENT_IMAGE_PATH = 2048;
export const AGENT_MEDIA_STALE_RESERVATION_MS = 15 * 60 * 1000;
export const AGENT_MEDIA_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

export type AgentMediaState = "staged" | "attached" | "missing";

export interface AgentMediaRow {
  id: string;
  appId: string;
  sessionId: string | null;
  messageId: string | null;
  partId: string | null;
  originalName: string;
  storedName: string;
  relPath: string;
  mime: string;
  size: number;
  caption: string | null;
  state: AgentMediaState;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMediaTarget {
  appId: string;
  projectId: string;
  appKey: string;
  appDir: string;
  appRoot: string;
  workspaceRoot: string;
  pathMode: "runner" | "supervisor";
}

export type AgentMediaErrorCode =
  | "image_unavailable"
  | "invalid_path"
  | "invalid_caption"
  | "path_outside_app"
  | "image_unreadable"
  | "image_unsupported"
  | "image_empty_file"
  | "image_too_large"
  | "image_size_mismatch"
  | "image_quota_exceeded"
  | "image_busy"
  | "image_storage_error";

export type AgentMediaResult =
  | { ok: true; id: string; name: string; mime: string; size: number }
  | { ok: false; code: AgentMediaErrorCode; message: string };

export type AgentMediaAttachResult =
  | { status: "attached"; view: AttachmentView }
  | { status: "missing"; view: AttachmentView }
  | { status: "conflict" }
  | { status: "unknown" };
