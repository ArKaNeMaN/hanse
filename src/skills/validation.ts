/** A skill input validation failure that HTTP callers should map to 400. */
export class SkillValidationError extends Error {
  readonly code = "VALIDATION";

  constructor(message: string) {
    super(message);
    this.name = "SkillValidationError";
  }
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Whether a stored/derived name is a safe skill directory name. */
export function isSkillName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= 64 && NAME_PATTERN.test(value)
  );
}

export function validateSkillName(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillValidationError("name must be a string");
  }
  const name = value.trim();
  if (!isSkillName(name)) {
    throw new SkillValidationError(
      "name must be 1-64 lowercase letters, digits, or single hyphens",
    );
  }
  return name;
}

export function validateSkillDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillValidationError("description must be a string");
  }
  const description = value.trim();
  if (description.length === 0) {
    throw new SkillValidationError("description must not be empty");
  }
  if (description.length > 1024) {
    throw new SkillValidationError("description must be at most 1024 characters");
  }
  if (hasControlCharacters(description)) {
    throw new SkillValidationError("description must be a single line without control characters");
  }
  return description;
}

export function validateSkillContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillValidationError("content must be a string");
  }
  if (value.includes("\u0000")) {
    throw new SkillValidationError("content must not contain NUL");
  }
  const content = value.trim();
  if (content.length === 0) {
    throw new SkillValidationError("content must not be empty");
  }
  if (content.length > 48000) {
    throw new SkillValidationError("content must be at most 48000 characters");
  }
  return content;
}

export function validateSkillEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new SkillValidationError("enabled must be a boolean");
  }
  return value;
}
