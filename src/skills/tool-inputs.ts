import { SkillToolError } from "./tool-errors.js";
import type { SkillInput, SkillReference, SkillUpdate } from "./types.js";

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SkillToolError("invalid_argument", `"${field}" must be a non-empty string`);
  }
  return value;
}

export function asOptionalStringOrNull(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new SkillToolError("invalid_argument", `"${field}" must be a string or null`);
}

export function asOptionalMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillToolError("invalid_argument", '"metadata" must be a plain object');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new SkillToolError("invalid_argument", `metadata value for ${key} must be a string`);
    }
  }
  return value as Record<string, string>;
}

export function asOptionalReferences(value: unknown): SkillReference[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new SkillToolError("invalid_argument", '"references" must be an array');
  }
  const references: SkillReference[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SkillToolError(
        "invalid_argument",
        `references[${index}] must be an object with path and content`,
      );
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.content !== "string") {
      throw new SkillToolError(
        "invalid_argument",
        `references[${index}] must have string path and content`,
      );
    }
    references.push({ path: record.path, content: record.content });
  }
  return references;
}

export function skillInputFromArgs(args: Record<string, unknown>): SkillInput {
  if (args.enabled !== undefined) {
    throw new SkillToolError(
      "invalid_argument",
      "enabled is not settable; create_skill always creates an enabled skill",
    );
  }
  const name = asString(args.name, "name");
  const description = asString(args.description, "description");
  const content = asString(args.content, "content");
  const license = asOptionalStringOrNull(args.license, "license");
  const compatibility = asOptionalStringOrNull(args.compatibility, "compatibility");
  const metadata = asOptionalMetadata(args.metadata);
  const references = asOptionalReferences(args.references);
  return {
    name,
    description,
    content,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(references === undefined ? {} : { references }),
  };
}

export function asPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SkillToolError("invalid_argument", `"${field}" must be a positive integer`);
  }
  return value;
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new SkillToolError("invalid_argument", `"${field}" must be a boolean`);
  }
  return value;
}

export function skillUpdatePatchFromArgs(args: Record<string, unknown>): SkillUpdate {
  const patch: SkillUpdate = {};
  if (args.description !== undefined) {
    patch.description = asString(args.description, "description");
  }
  if (args.content !== undefined) {
    patch.content = asString(args.content, "content");
  }
  if (args.license !== undefined) {
    const license = asOptionalStringOrNull(args.license, "license");
    if (license !== undefined) {
      patch.license = license;
    }
  }
  if (args.compatibility !== undefined) {
    const compatibility = asOptionalStringOrNull(args.compatibility, "compatibility");
    if (compatibility !== undefined) {
      patch.compatibility = compatibility;
    }
  }
  if (args.metadata !== undefined) {
    const metadata = asOptionalMetadata(args.metadata);
    if (metadata !== undefined) {
      patch.metadata = metadata;
    }
  }
  if (args.references !== undefined) {
    const references = asOptionalReferences(args.references);
    if (references !== undefined) {
      patch.references = references;
    }
  }
  return patch;
}
