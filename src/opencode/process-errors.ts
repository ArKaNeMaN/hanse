import { DefaultImageUnavailableError, ImageNotReadyError } from "../images/service.js";

/** Stable process error codes (design §10). */
export type ProcessErrorCode =
  | "image_unavailable"
  | "default_image_unavailable"
  | "token_reconcile_failed"
  | "skills_materialize_failed"
  | "readiness_timeout"
  | "runtime_unavailable"
  | "interrupted";

const KNOWN_CODES: ReadonlySet<string> = new Set<ProcessErrorCode>([
  "image_unavailable",
  "default_image_unavailable",
  "token_reconcile_failed",
  "skills_materialize_failed",
  "readiness_timeout",
  "runtime_unavailable",
  "interrupted",
]);

const GENERIC_MESSAGES: Record<ProcessErrorCode, string> = {
  image_unavailable: "The application image is not ready.",
  default_image_unavailable: "The default agent image is unavailable.",
  token_reconcile_failed: "The agent token could not be reconciled.",
  skills_materialize_failed: "Agent skills could not be materialized.",
  readiness_timeout: "The agent did not become ready in time.",
  runtime_unavailable: "The agent runtime is unavailable.",
  interrupted: "The agent start was interrupted.",
};

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_REDACTION_INPUT_LENGTH = 20_000;
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z ]*PRIVATE KEY-----.*$/gm;
const ANSI_ESCAPE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC_ESCAPE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
const OTHER_ESCAPE = new RegExp(`${ESC}[@-_]`, "g");

export interface SanitizeProcessErrorOptions {
  /** Effective secret values the caller already holds. */
  secrets?: Iterable<string | null | undefined>;
  /** Error code used for the generic fallback. */
  code?: ProcessErrorCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCodeOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function errorNameOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const name = error.name;
  return typeof name === "string" ? name : undefined;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message;
    if (typeof error.stderr === "string") return error.stderr;
  }
  if (error === null || error === undefined) return "";
  return String(error);
}

/**
 * Map a typed lifecycle failure to its stable process error code.
 *
 * Unknown/internal exceptions map to `runtime_unavailable`; callers that already know the code
 * (for example a stale launch) pass it explicitly to the writer.
 */
export function processErrorCode(error: unknown): ProcessErrorCode {
  if (error instanceof ImageNotReadyError) return "image_unavailable";
  if (error instanceof DefaultImageUnavailableError) return "default_image_unavailable";
  const code = errorCodeOf(error);
  const name = errorNameOf(error);
  if (code === "agent_token_reconcile_failed" || name === "AgentTokenReconcileError") {
    return "token_reconcile_failed";
  }
  if (name === "AgentStartingError" || code === "agent_starting" || code === "readiness_timeout") {
    return "readiness_timeout";
  }
  if (code !== undefined && KNOWN_CODES.has(code)) {
    return code as ProcessErrorCode;
  }
  if (messageOf(error).startsWith("skills_materialize_failed")) {
    return "skills_materialize_failed";
  }
  return "runtime_unavailable";
}

/** The generic, code-keyed message shown when no safe detail exists. */
export function genericProcessErrorMessage(code: ProcessErrorCode): string {
  return GENERIC_MESSAGES[code];
}

function isKnownLifecycleError(error: unknown): boolean {
  if (error instanceof ImageNotReadyError || error instanceof DefaultImageUnavailableError) {
    return true;
  }
  const name = errorNameOf(error);
  if (name === "AgentStartingError" || name === "AgentTokenReconcileError") {
    return true;
  }
  const code = errorCodeOf(error);
  if (code !== undefined && KNOWN_CODES.has(code)) {
    return true;
  }
  return messageOf(error).startsWith("skills_materialize_failed");
}

function firstLine(value: string): string {
  const index = value.search(/\r?\n|\r/);
  return index === -1 ? value : value.slice(0, index);
}

function stripAnsi(value: string): string {
  return value.replace(OSC_ESCAPE, "").replace(ANSI_ESCAPE, "").replace(OTHER_ESCAPE, "");
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }
  return result;
}

function redactSecrets(value: string, secrets: Iterable<string | null | undefined>): string {
  let redacted = value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/(Authorization\s*:\s*)(?:Basic|Bearer)?\s*[^\s]+/gi, "$1<redacted>")
    .replace(
      /\b(HANSE_RUNTIME_TOKEN|HANSE_OPERATOR_TOKEN|HANSE_OPENCODE_PASSWORD|OPENCODE_PASSWORD|HANSE_AGENT_TOKEN|MCP_TOKEN|GIT_TOKEN|GITHUB_TOKEN)\b\s*[:=]\s*[^\s]+/gi,
      "$1=<redacted>",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+)\b/g, "<redacted>")
    .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g, "<redacted>")
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
    .replace(PRIVATE_KEY_MARKER, "<redacted-private-key>");

  const ordered = [...new Set(secrets)]
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) {
    redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted;
}

/**
 * Sanitize a process error at write time (design §10).
 *
 * Keeps the first line, strips ANSI/control characters, redacts known secret shapes and
 * caller-supplied values, and caps the message at 2,000 characters. An unrecognized exception with
 * an explicit `code` becomes the generic code-keyed message instead of leaking an internal detail.
 * String input is always treated as already-diagnostic text and is scrubbed rather than genericized.
 */
export function sanitizeProcessError(
  input: unknown,
  options: SanitizeProcessErrorOptions = {},
): string {
  const { code } = options;
  if (code !== undefined && typeof input !== "string" && !isKnownLifecycleError(input)) {
    return genericProcessErrorMessage(code);
  }

  const raw = stripControlCharacters(stripAnsi(firstLine(messageOf(input))));
  const bounded = raw.slice(0, MAX_REDACTION_INPUT_LENGTH);
  const sanitized = redactSecrets(bounded, options.secrets ?? [])
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
  if (sanitized.length > 0) {
    return sanitized;
  }
  return code === undefined ? "Unknown error" : genericProcessErrorMessage(code);
}
