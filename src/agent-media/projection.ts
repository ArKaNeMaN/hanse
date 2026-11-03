import type { AttachmentView } from "../attachments/types.js";

const ID_PATTERN = /^amed_[A-Za-z0-9_-]{10,64}$/;

export function normalizeShowImageToolName(tool: string): string {
  return tool.startsWith("hanse_") ? tool.slice("hanse_".length) : tool;
}

export function isShowImageTool(tool: string | undefined): boolean {
  return tool !== undefined && normalizeShowImageToolName(tool) === "show_image";
}

/** Parse the explicit show_image tool result, tolerating MCP/content/double-encoded wrappers. */
export function parseShowImageEnvelope(value: unknown, depth = 0): { id: string } | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) return undefined;
    try {
      return parseShowImageEnvelope(JSON.parse(text), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) return undefined;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok === false) return undefined;
  const id = typeof record.id === "string" ? record.id : undefined;
  if (record.ok === true && id !== undefined && ID_PATTERN.test(id)) return { id };
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const content = item as Record<string, unknown>;
        if (content.type === "text" && typeof content.text === "string") {
          const parsed = parseShowImageEnvelope(content.text, depth + 1);
          if (parsed !== undefined) return parsed;
        }
      }
    }
  }
  for (const key of ["text", "output"]) {
    if (typeof record[key] === "string") {
      const parsed = parseShowImageEnvelope(record[key], depth + 1);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

/** Replace tool-attachment data URLs before they can reach the browser. */
export function stripNestedToolDataUrls(part: Record<string, unknown>): void {
  const state = asRecord(part.state);
  if (state === undefined) return;
  const attachments = state.attachments;
  if (!Array.isArray(attachments)) return;
  let stripped = false;
  for (const item of attachments) {
    const attachment = asRecord(item);
    if (attachment === undefined) continue;
    if (typeof attachment.url === "string" && attachment.url.startsWith("data:")) {
      attachment.url = "";
      stripped = true;
    }
  }
  if (stripped) state.attachmentsTruncated = true;
}

/** Remove the model-supplied path and echoed path fields from a show_image tool part. */
export function redactShowImagePath(part: Record<string, unknown>): void {
  if (!isShowImageTool(typeof part.tool === "string" ? part.tool : undefined)) return;
  if (part.title !== undefined) delete part.title;
  const state = asRecord(part.state);
  if (state === undefined) return;
  const input = asRecord(state.input);
  if (input !== undefined) {
    delete input.path;
    state.input = input;
  }
  const metadata = asRecord(state.metadata);
  if (metadata !== undefined) redactPathFields(metadata);
}

function redactPathFields(value: Record<string, unknown>): void {
  for (const [key, item] of Object.entries(value)) {
    if (key === "path" || key === "filePath" || key === "filepath") {
      delete value[key];
    } else if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      redactPathFields(item as Record<string, unknown>);
    } else if (Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
          redactPathFields(entry as Record<string, unknown>);
        }
      }
    }
  }
}

export interface ShowImageSyntheticInput {
  sessionID: string;
  messageID: string;
  view: AttachmentView;
  url: string;
}

export interface ShowImageSyntheticPart {
  partID: string;
  partType: "file";
  part: Record<string, unknown>;
}

export function syntheticShowImagePart(input: ShowImageSyntheticInput): ShowImageSyntheticPart {
  const partID = `prt_${input.view.id}`;
  return {
    partID,
    partType: "file",
    part: {
      id: partID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "file",
      mime: input.view.mime,
      filename: input.view.name,
      url: input.url,
      attachment: {
        id: input.view.id,
        size: input.view.size,
        mode: "inline",
        kind: "image",
        inline: true,
        state: input.view.state,
        origin: "agent",
        ...(input.view.caption === undefined ? {} : { caption: input.view.caption }),
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
