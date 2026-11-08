import { createHash } from "node:crypto";
import type {
  SkillFile,
  SkillFileView,
  SkillMetadata,
  SkillReference,
  SkillStoredIssue,
} from "./types.js";

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

export const SKILL_FILE_LIMITS = {
  files: 100,
  fileBytes: 1024 * 1024,
  bundleBytes: 8 * 1024 * 1024,
  pathBytes: 1024,
  depth: 16,
  segmentBytes: 255,
} as const;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function hasForbiddenPathCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || character === "\\") return true;
  }
  return false;
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Whether a path is a safe bundle-relative file path. */
export function isSkillFilePath(
  value: unknown,
  options: { allowSkillMd?: boolean } = {},
): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (Buffer.byteLength(value, "utf8") > SKILL_FILE_LIMITS.pathBytes) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  if (value.endsWith("/") || value.includes("\\")) return false;
  if (hasForbiddenPathCharacter(value)) return false;
  if (value.normalize("NFC") !== value) return false;
  if (value === "SKILL.md" && options.allowSkillMd !== true) return false;
  const segments = value.split("/");
  if (segments.length > SKILL_FILE_LIMITS.depth) return false;
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
    if (Buffer.byteLength(segment, "utf8") > SKILL_FILE_LIMITS.segmentBytes) return false;
  }
  const leaf = segments[segments.length - 1] ?? "";
  if (WINDOWS_RESERVED.test(leaf)) return false;
  return true;
}

export function validateSkillFilePath(
  value: unknown,
  options: { allowSkillMd?: boolean } = {},
): string {
  if (!isSkillFilePath(value, options)) {
    throw new SkillValidationError(
      "file path must be a safe relative POSIX path (1-1024 bytes, depth <= 16, no traversal)",
      "files",
    );
  }
  return value;
}

function validateSkillFileInputOne(value: unknown, options: { allowSkillMd?: boolean }): SkillFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillValidationError("each file must have a path and text or base64", "files");
  }
  const record = value as Record<string, unknown>;
  const filePath = validateSkillFilePath(record.path, options);
  const hasText = typeof record.text === "string";
  const hasBase64 = typeof record.base64 === "string";
  if (hasText === hasBase64) {
    throw new SkillValidationError("a file must have exactly one of text or base64", "files");
  }
  let content: Buffer;
  if (hasText) {
    const text = normalizeLineEndings(record.text as string);
    if (hasUnpairedSurrogate(text)) {
      throw new SkillValidationError("file text must not contain unpaired surrogates", "files");
    }
    content = Buffer.from(text, "utf8");
  } else {
    const raw = record.base64 as string;
    if (raw.length % 4 !== 0 || !BASE64_PATTERN.test(raw)) {
      throw new SkillValidationError("file base64 is invalid", "files");
    }
    content = Buffer.from(raw, "base64");
  }
  if (content.byteLength > SKILL_FILE_LIMITS.fileBytes) {
    throw new SkillValidationError("a skill file must be at most 1 MiB", "files");
  }
  if (record.executable !== undefined && typeof record.executable !== "boolean") {
    throw new SkillValidationError("file executable must be a boolean", "files");
  }
  return {
    path: filePath,
    content,
    sha256: sha256Bytes(content),
    size: content.byteLength,
    executable: record.executable === true,
  };
}

/** Validate a file-set conflict: duplicates, case-insensitive duplicates, and prefix conflicts. */
export function assertNoFileConflicts(files: readonly { path: string }[]): void {
  const seen = new Map<string, string>();
  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : 1));
  for (const file of sorted) {
    const key = file.path.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new SkillValidationError(`file path ${file.path} duplicates ${previous}`, "files");
    }
    seen.set(key, file.path);
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]?.path ?? "";
    const current = sorted[index]?.path ?? "";
    if (current.startsWith(`${previous}/`)) {
      throw new SkillValidationError(
        `file path ${previous} conflicts with nested path ${current}`,
        "files",
      );
    }
  }
}

export function validateSkillFiles(
  value: unknown,
  options: { allowSkillMd?: boolean } = {},
): SkillFile[] {
  if (!Array.isArray(value)) {
    throw new SkillValidationError("files must be an array", "files");
  }
  if (value.length > SKILL_FILE_LIMITS.files) {
    throw new SkillValidationError("a skill may have at most 100 files", "files");
  }
  const files = value.map((item) => validateSkillFileInputOne(item, options));
  assertNoFileConflicts(files);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > SKILL_FILE_LIMITS.bundleBytes) {
    throw new SkillValidationError("a skill bundle must be at most 8 MiB", "files");
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** Map the legacy `references` payload into the local file set. */
export function referencesToFiles(references: readonly SkillReference[]): SkillFile[] {
  return references
    .map((reference) => {
      const content = Buffer.from(reference.content, "utf8");
      return {
        path: reference.path,
        content,
        sha256: sha256Bytes(content),
        size: content.byteLength,
        executable: false,
      } satisfies SkillFile;
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** Whether a file is part of the legacy `skill_references` projection. */
export function isLegacyReferenceFile(file: SkillFile): boolean {
  if (!isSkillReferencePath(file.path) || file.executable === true) return false;
  if (file.size > SKILL_LIMITS.referenceContent) return false;
  let text: string;
  try {
    text = UTF8_DECODER.decode(file.content);
  } catch {
    return false;
  }
  if (text.includes("\r")) return false;
  try {
    validateSkillReferenceContent(text);
  } catch {
    return false;
  }
  return true;
}

/** The legacy reference rows a local file set projects into. */
export function legacyReferenceProjection(files: readonly SkillFile[]): SkillReference[] {
  const references: SkillReference[] = [];
  for (const file of files) {
    if (!isLegacyReferenceFile(file)) continue;
    references.push({ path: file.path, content: UTF8_DECODER.decode(file.content) });
  }
  return references.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** Whether two reference sets are equal by path and exact text. */
export function sameReferences(
  left: readonly SkillReference[],
  right: readonly SkillReference[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => (a.path < b.path ? -1 : 1));
  const sortedRight = [...right].sort((a, b) => (a.path < b.path ? -1 : 1));
  return sortedLeft.every(
    (reference, index) =>
      reference.path === sortedRight[index]?.path &&
      reference.content === sortedRight[index]?.content,
  );
}

export function skillFileView(file: SkillFile): SkillFileView {
  try {
    const text = UTF8_DECODER.decode(file.content);
    return {
      path: file.path,
      size: file.size,
      encoding: "utf8",
      text,
      ...(file.executable === true ? { executable: true } : {}),
    };
  } catch {
    return {
      path: file.path,
      size: file.size,
      encoding: "binary",
      base64: Buffer.from(file.content).toString("base64"),
      ...(file.executable === true ? { executable: true } : {}),
    };
  }
}
