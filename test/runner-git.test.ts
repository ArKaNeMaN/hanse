import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/load.js";
import { validateGitRequest } from "../src/runner/git.js";

function expectConfigError(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return;
  }
  throw new Error("expected ConfigError");
}

describe("runner git request validation", () => {
  it("accepts the fixed operation set with only their arguments", () => {
    expect(validateGitRequest({ operation: "status" })).toEqual({ operation: "status" });
    expect(validateGitRequest({ operation: "fetch" })).toEqual({ operation: "fetch" });
    expect(validateGitRequest({ operation: "update" })).toEqual({ operation: "update" });
    expect(validateGitRequest({ operation: "push" })).toEqual({ operation: "push" });
    expect(validateGitRequest({ operation: "switch", branch: "feature/agent-runtime" })).toEqual({
      operation: "switch",
      branch: "feature/agent-runtime",
    });
    expect(validateGitRequest({ operation: "commit", message: "  test commit  " })).toEqual({
      operation: "commit",
      message: "test commit",
    });
  });

  it("rejects unknown operations, fields, and misplaced arguments", () => {
    expectConfigError(() => validateGitRequest({ operation: "rm" }));
    expectConfigError(() => validateGitRequest({ operation: "status", branch: "main" }));
    expectConfigError(() => validateGitRequest({ operation: "status", extra: true }));
    expectConfigError(() => validateGitRequest({ operation: "fetch", message: "x" }));
    expectConfigError(() => validateGitRequest({ operation: "switch" }));
    expectConfigError(() => validateGitRequest({ operation: "commit" }));
  });

  it("rejects traversal, option-looking, and malformed branch names", () => {
    for (const branch of ["../main", "-x", "a..b", "a b", "main\0"]) {
      expectConfigError(() => validateGitRequest({ operation: "switch", branch }));
    }
  });

  it("rejects empty and overlong commit messages", () => {
    expectConfigError(() => validateGitRequest({ operation: "commit", message: "   " }));
    expectConfigError(() => validateGitRequest({ operation: "commit", message: "x".repeat(501) }));
  });
});
