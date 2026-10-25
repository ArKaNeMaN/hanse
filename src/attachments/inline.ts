import type { CapabilityOutcome } from "./capabilities.js";
import { modalitySupported } from "./capabilities.js";
import type { AttachmentMode, AttachmentRow } from "./types.js";

export const INLINE_MAX_BYTES = 20 * 1024 * 1024;
export const INLINE_MAX_ATTACHMENTS = 4;
export const INLINE_BASE64_BUDGET_BYTES = 40 * 1024 * 1024;
export const IMAGE_ADVISORY_TOKENS = 5_000;
export const IMAGE_ADVISORY_MAX_IMAGES = 4;
export const IMAGE_ADVISORY_THRESHOLD = 20_000;

export type InlineDecision = "inline" | "file";

export interface InlinePlanInput {
  rows: AttachmentRow[];
  requested: Array<{ id: string; mode?: AttachmentMode; explicitMode: boolean }>;
  capability: CapabilityOutcome;
}

export interface InlinePlan {
  modes: Map<string, InlineDecision>;
  warnings: string[];
}

export interface InlinePlanError {
  status: number;
  code: string;
  message: string;
}

export type InlinePlanResult =
  | { ok: true; plan: InlinePlan }
  | { ok: false; error: InlinePlanError };

/** Exact raw base64 upper bound used by the inline budget (design §D8). */
export function base64Bytes(size: number): number {
  return Math.ceil(size / 3) * 4;
}

export function inlinePartId(attachmentId: string, deliveryId: string): string {
  return `prt_att_${attachmentId}_${deliveryId}`;
}

function capabilityDecision(
  row: AttachmentRow,
  capability: CapabilityOutcome,
  warnings: string[],
): { inline: boolean; unknown: boolean } {
  const kind = row.kind ?? "file";
  if (kind !== "image" && kind !== "video" && kind !== "pdf")
    return { inline: false, unknown: false };
  if (capability.status === "unknown") {
    warnings.push("attachment_capability_unknown");
    return { inline: false, unknown: true };
  }
  const supported = modalitySupported(capability.entry.capabilities, kind);
  if (supported !== true) {
    warnings.push("attachment_inline_unsupported");
    return { inline: false, unknown: false };
  }
  return { inline: true, unknown: false };
}

/**
 * Resolve every attachment's effective delivery for this send. Unsupported or unknown capabilities
 * and oversize files fall back to `file` with warnings; the explicit `file` mode never warns.
 */
export function planInlineDelivery(input: InlinePlanInput): InlinePlanResult {
  const modes = new Map<string, InlineDecision>();
  const warnings: string[] = [];
  let inlineCount = 0;
  let inlineBytes = 0;
  let imageCount = 0;

  for (const row of input.rows) {
    const requested = input.requested.find((item) => item.id === row.id);
    const explicit = requested?.mode ?? row.mode;
    const kind = row.kind ?? "file";
    const inlineKind = kind === "image" || kind === "video" || kind === "pdf";
    if (!inlineKind) {
      if (explicit === "inline") warnings.push("attachment_inline_unsupported");
      modes.set(row.id, "file");
      continue;
    }
    if (explicit === "file") {
      modes.set(row.id, "file");
      continue;
    }
    const decision = capabilityDecision(row, input.capability, warnings);
    if (!decision.inline) {
      modes.set(row.id, "file");
      continue;
    }
    const size = row.size ?? 0;
    if (size > INLINE_MAX_BYTES) {
      warnings.push("attachment_inline_too_large");
      modes.set(row.id, "file");
      continue;
    }
    modes.set(row.id, "inline");
    inlineCount += 1;
    inlineBytes += base64Bytes(size);
    if (kind === "image") imageCount += 1;
  }

  if (inlineCount > INLINE_MAX_ATTACHMENTS) {
    return {
      ok: false,
      error: {
        status: 400,
        code: "too_many_inline_attachments",
        message: `at most ${INLINE_MAX_ATTACHMENTS} attachments may be sent inline`,
      },
    };
  }
  if (inlineBytes > INLINE_BASE64_BUDGET_BYTES) {
    return {
      ok: false,
      error: {
        status: 409,
        code: "inline_budget_exceeded",
        message: "inline attachment base64 exceeds the message budget; send one as file",
      },
    };
  }
  if (inlineCount > 0 && input.capability.status === "known") {
    const limit = input.capability.entry.limit;
    const advisory = contextAdvisory(
      {
        inlineBytes,
        imageCount: Math.min(imageCount, IMAGE_ADVISORY_MAX_IMAGES),
      },
      limit,
    );
    if (advisory) warnings.push("attachment_context_large");
  }

  return { ok: true, plan: { modes, warnings } };
}

/** Non-blocking context advisory for inline bytes (design §D4). */
export function contextAdvisory(
  input: { inlineBytes: number; imageCount: number },
  limit: { context?: number; input?: number },
): boolean {
  if (
    input.imageCount > 0 &&
    input.imageCount * IMAGE_ADVISORY_TOKENS >= IMAGE_ADVISORY_THRESHOLD
  ) {
    return true;
  }
  if (input.inlineBytes <= 0) return false;
  if (limit.input !== undefined && limit.input > 0) {
    return input.inlineBytes > 0.5 * limit.input * 4;
  }
  if (limit.context !== undefined && limit.context > 0) {
    return input.inlineBytes > 0.25 * limit.context * 4;
  }
  return false;
}

export function dedupeWarnings(warnings: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const warning of warnings) {
    if (seen.has(warning)) continue;
    seen.add(warning);
    output.push(warning);
  }
  return output;
}
