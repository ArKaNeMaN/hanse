import { SkillConflictError } from "./service.js";
import { SkillValidationError } from "./validation.js";

/** Stable skill tool failure carrying a model-facing code. */
export class SkillToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillToolError";
    this.code = code;
  }
}

/** A skill id that does not resolve to a stored row. */
export function unknownSkillError(id: number): SkillToolError {
  return new SkillToolError("unknown_skill", `skill ${id} not found`);
}

/** Map any skill tool failure to the stable `{ok:false, code, message}` shape. */
export function toSkillFailure(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof SkillToolError) {
    return { ok: false, code: error.code, message: error.message };
  }
  if (error instanceof SkillValidationError) {
    return {
      ok: false,
      code: "invalid_skill",
      message: error.field === undefined ? error.message : `${error.field}: ${error.message}`,
    };
  }
  if (error instanceof SkillConflictError) {
    return { ok: false, code: "skill_exists", message: error.message };
  }
  return {
    ok: false,
    code: "internal_error",
    message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  };
}
