import type { SkillMetadata, SkillReference, SkillStoredIssue } from "./types.js";

/** A skill input validation failure that HTTP callers should map to 400. */
export class SkillValidationError extends Error {
  readonly code = "VALIDATION";
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "SkillValidationError";
    this.field = field;
  }
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const METADATA_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REFERENCE_PATH_PATTERN = /^references\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

export const SKILL_LIMITS = {
  name: 64,
  description: 1024,
  content: 48000,
  license: 256,
  compatibility: 512,
  metadataEntries: 32,
  metadataKey: 64,
  metadataValue: 1024,
  metadataJson: 16384,
  references: 20,
  referenceSlug: 64,
  referencePath: 78,
  referenceContent: 48000,
  referenceAggregate: 192000,
} as const;

const RESERVED_METADATA_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
]);

/** CRLF and lone CR are normalized to LF for description and reference text. */
export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

interface ControlOptions {
  allowNewline: boolean;
  allowTab: boolean;
}

function hasForbiddenControl(value: string, options: ControlOptions): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a && options.allowNewline) {
      continue;
    }
    if (code === 0x09 && options.allowTab) {
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Whether a stored/derived name is a safe skill directory name. */
export function isSkillName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= SKILL_LIMITS.name &&
    NAME_PATTERN.test(value)
  );
}

export function validateSkillName(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillValidationError("name must be a string", "name");
  }
  const name = value.trim();
  if (!isSkillName(name)) {
    throw new SkillValidationError(
      "name must be 1-64 lowercase letters, digits, or single hyphens",
      "name",
    );
  }
  return name;
}

export function validateSkillDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillValidationError("description must be a string", "description");
  }
  const description = normalizeLineEndings(value).trim();
  if (description.length === 0) {
    throw new SkillValidationError("description must not be empty", "description");
  }
  if (description.length > SKILL_LIMITS.description) {
    throw new SkillValidationError("description must be at most 1024 characters", "description");
  }
  if (hasForbiddenControl(description, { allowNewline: true, allowTab: false })) {
    throw new SkillValidationError(
      "description must not contain control characters other than newlines",
      "description",
    );
  }
  return description;
}

export function validateSkillContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillValidationError("content must be a string", "content");
  }
  if (value.includes("\u0000")) {
    throw new SkillValidationError("content must not contain NUL", "content");
  }
  if (hasUnpairedSurrogate(value)) {
    throw new SkillValidationError("content must not contain unpaired surrogates", "content");
  }
  const content = value.trim();
  if (content.length === 0) {
    throw new SkillValidationError("content must not be empty", "content");
  }
  if (content.length > SKILL_LIMITS.content) {
    throw new SkillValidationError("content must be at most 48000 characters", "content");
  }
  return content;
}

export function validateSkillEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new SkillValidationError("enabled must be a boolean", "enabled");
  }
  return value;
}

export function validateSkillLicense(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SkillValidationError("license must be a string or null", "license");
  }
  const license = value.trim();
  if (license.length === 0) {
    return null;
  }
  if (license.length > SKILL_LIMITS.license) {
    throw new SkillValidationError("license must be at most 256 characters", "license");
  }
  if (hasForbiddenControl(license, { allowNewline: false, allowTab: false })) {
    throw new SkillValidationError(
      "license must be a single line without control characters",
      "license",
    );
  }
  if (hasUnpairedSurrogate(license)) {
    throw new SkillValidationError("license must not contain unpaired surrogates", "license");
  }
  return license;
}

export function validateSkillCompatibility(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SkillValidationError("compatibility must be a string or null", "compatibility");
  }
  const compatibility = value.trim();
  if (compatibility.length === 0) {
    return null;
  }
  if (compatibility.length > SKILL_LIMITS.compatibility) {
    throw new SkillValidationError("compatibility must be at most 512 characters", "compatibility");
  }
  if (hasForbiddenControl(compatibility, { allowNewline: false, allowTab: false })) {
    throw new SkillValidationError(
      "compatibility must be a single line without control characters",
      "compatibility",
    );
  }
  if (hasUnpairedSurrogate(compatibility)) {
    throw new SkillValidationError(
      "compatibility must not contain unpaired surrogates",
      "compatibility",
    );
  }
  return compatibility;
}

export function validateSkillMetadata(value: unknown): SkillMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillValidationError("metadata must be a plain object", "metadata");
  }
  const entries = Object.entries(value);
  if (entries.length > SKILL_LIMITS.metadataEntries) {
    throw new SkillValidationError("metadata must have at most 32 entries", "metadata");
  }
  const metadata: SkillMetadata = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (key.length === 0 || key.length > SKILL_LIMITS.metadataKey) {
      throw new SkillValidationError("metadata keys must be 1-64 characters", "metadata");
    }
    if (!METADATA_KEY_PATTERN.test(key)) {
      throw new SkillValidationError(
        "metadata keys must be lowercase letters, digits, or single hyphens and start with a letter",
        "metadata",
      );
    }
    if (RESERVED_METADATA_KEYS.has(key)) {
      throw new SkillValidationError(`metadata key ${key} is reserved`, "metadata");
    }
    if (typeof rawValue !== "string") {
      throw new SkillValidationError(`metadata value for ${key} must be a string`, "metadata");
    }
    const metadataValue = rawValue.trim();
    if (metadataValue.length === 0) {
      continue;
    }
    if (metadataValue.length > SKILL_LIMITS.metadataValue) {
      throw new SkillValidationError(
        `metadata value for ${key} must be at most 1024 characters`,
        "metadata",
      );
    }
    if (hasForbiddenControl(metadataValue, { allowNewline: false, allowTab: false })) {
      throw new SkillValidationError(
        `metadata value for ${key} must be a single line without control characters`,
        "metadata",
      );
    }
    if (hasUnpairedSurrogate(metadataValue)) {
      throw new SkillValidationError(
        `metadata value for ${key} must not contain unpaired surrogates`,
        "metadata",
      );
    }
    if (Object.hasOwn(metadata, key)) {
      throw new SkillValidationError(`metadata key ${key} is duplicated`, "metadata");
    }
    metadata[key] = metadataValue;
  }
  if (JSON.stringify(metadata).length > SKILL_LIMITS.metadataJson) {
    throw new SkillValidationError(
      "metadata must serialize to at most 16384 characters",
      "metadata",
    );
  }
  return metadata;
}

export function validateSkillReferencePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillValidationError("reference path must be a string", "references");
  }
  const match = REFERENCE_PATH_PATTERN.exec(value);
  if (
    match === null ||
    value.length < 15 ||
    value.length > SKILL_LIMITS.referencePath ||
    (match[1]?.length ?? 0) > SKILL_LIMITS.referenceSlug
  ) {
    throw new SkillValidationError(
      "reference path must be references/<slug>.md with a 1-64 character lowercase slug",
      "references",
    );
  }
  return value;
}

export function isSkillReferencePath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = REFERENCE_PATH_PATTERN.exec(value);
  return (
    match !== null &&
    value.length >= 15 &&
    value.length <= SKILL_LIMITS.referencePath &&
    (match[1]?.length ?? 0) <= SKILL_LIMITS.referenceSlug
  );
}

export function validateSkillReferenceContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillValidationError("reference content must be a string", "references");
  }
  const content = normalizeLineEndings(value);
  if (content.includes("\u0000")) {
    throw new SkillValidationError("reference content must not contain NUL", "references");
  }
  if (hasForbiddenControl(content, { allowNewline: true, allowTab: true })) {
    throw new SkillValidationError(
      "reference content must not contain control characters other than newlines and tabs",
      "references",
    );
  }
  if (hasUnpairedSurrogate(content)) {
    throw new SkillValidationError(
      "reference content must not contain unpaired surrogates",
      "references",
    );
  }
  if (content.length === 0) {
    throw new SkillValidationError("reference content must not be empty", "references");
  }
  if (content.length > SKILL_LIMITS.referenceContent) {
    throw new SkillValidationError(
      "reference content must be at most 48000 characters",
      "references",
    );
  }
  return content;
}

/**
 * Normalize and validate a complete reference replacement set. Paths are
 * canonical and returned in path order so storage and hash projection are
 * deterministic.
 */
export function validateSkillReferences(value: unknown): SkillReference[] {
  if (!Array.isArray(value)) {
    throw new SkillValidationError("references must be an array", "references");
  }
  if (value.length > SKILL_LIMITS.references) {
    throw new SkillValidationError("a skill may have at most 20 references", "references");
  }
  const references: SkillReference[] = [];
  const seen = new Set<string>();
  let aggregate = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new SkillValidationError("each reference must have a path and content", "references");
    }
    const record = item as Record<string, unknown>;
    const referencePath = validateSkillReferencePath(record.path);
    if (seen.has(referencePath)) {
      throw new SkillValidationError(`reference path ${referencePath} is duplicated`, "references");
    }
    seen.add(referencePath);
    const content = validateSkillReferenceContent(record.content);
    aggregate += content.length;
    references.push({ path: referencePath, content });
  }
  if (aggregate > SKILL_LIMITS.referenceAggregate) {
    throw new SkillValidationError("references must total at most 192000 characters", "references");
  }
  return references.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export interface StoredMetadataResult {
  metadata: SkillMetadata;
  /** The raw JSON when the stored metadata is not valid; null otherwise. */
  metadataRaw: string | null;
  issue: SkillStoredIssue | null;
}

/** Parse and validate stored `metadata_json` without trusting the DB contents. */
export function parseStoredMetadata(raw: string): StoredMetadataResult {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return { metadata: validateSkillMetadata(parsed), metadataRaw: null, issue: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      metadata: {},
      metadataRaw: raw,
      issue: { code: "invalid_skill_metadata", detail },
    };
  }
}
