import { pathToFileURL } from "node:url";
import type { OpencodePart } from "../opencode/client.js";
import { type AttachmentPathMode, attachmentVisibleRoot } from "./paths.js";
import type { AttachmentRow } from "./types.js";

export const ATTACHMENT_MANIFEST_MARKER = "attachment-manifest";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ManifestInput {
  agentsHome: string;
  projectId: string;
  appKey: string;
  pathMode: AttachmentPathMode;
  sessionId: string;
  attachments: AttachmentRow[];
  /** Effective per-attachment delivery mode; defaults to `file`. */
  modes?: ReadonlyMap<string, "inline" | "file">;
}

/** The model-visible absolute path for one stored attachment. */
export function attachmentVisiblePath(input: ManifestInput, row: AttachmentRow): string {
  const root = attachmentVisibleRoot({
    agentsHome: input.agentsHome,
    projectId: input.projectId,
    appKey: input.appKey,
    pathMode: input.pathMode,
  });
  return `${root}/${input.sessionId}/${row.storedName ?? row.id}`;
}

/** One synthetic, model-visible text part listing every attachment with its effective mode. */
export function buildAttachmentManifest(input: ManifestInput): OpencodePart {
  const lines = input.attachments.map((row) => {
    const mode = input.modes?.get(row.id) ?? "file";
    return `- ${attachmentVisiblePath(input, row)} (${row.mime ?? "application/octet-stream"}, ${formatBytes(row.size ?? 0)}, ${mode})`;
  });
  return {
    type: "text",
    synthetic: true,
    metadata: { hanse: ATTACHMENT_MANIFEST_MARKER },
    text: `Attached files (use these paths with your tools; "inline" files were also sent to you):\n${lines.join("\n")}`,
  };
}

/** Inline `FilePart`s use a `file://` URL over the model-visible path; no base64 is sent. */
export function buildInlineFilePart(input: {
  manifest: ManifestInput;
  row: AttachmentRow;
  partId: string;
}): OpencodePart {
  return {
    id: input.partId,
    type: "file",
    mime: input.row.mime ?? "application/octet-stream",
    filename: input.row.originalName,
    url: pathToFileURL(attachmentVisiblePath(input.manifest, input.row)).href,
  };
}

export function buildSendParts(
  text: string,
  manifest: OpencodePart,
  inlineParts: OpencodePart[] = [],
): OpencodePart[] {
  return [...(text.length > 0 ? [{ type: "text", text }] : []), manifest, ...inlineParts];
}
