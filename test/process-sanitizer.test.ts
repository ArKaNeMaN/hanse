import { describe, expect, it } from "vitest";
import { AgentStartingError, AgentTokenReconcileError } from "../src/opencode/manager.js";
import { processErrorCode, sanitizeProcessError } from "../src/opencode/process-errors.js";

describe("process error sanitizer", () => {
  it("keeps only the first line and strips ANSI and control characters", () => {
    const input = "\u001b[31mfirst line\u001b[0m\u0007\r\nsecond line";
    expect(sanitizeProcessError(input)).toBe("first line");
  });

  it("caps the message at 2,000 characters", () => {
    const sanitized = sanitizeProcessError("a".repeat(2_500));
    expect(sanitized).toHaveLength(2_000);
  });

  it.each([
    ["Bearer token", "Authorization: Bearer bearer-secret", "bearer-secret"],
    ["Basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    ["runtime token", "HANSE_RUNTIME_TOKEN=runtime-secret", "runtime-secret"],
    ["operator token", "HANSE_OPERATOR_TOKEN=operator-secret", "operator-secret"],
    ["opencode password", "HANSE_OPENCODE_PASSWORD=opencode-secret", "opencode-secret"],
    ["provider key", "provider key sk-abcdef1234567890", "sk-abcdef1234567890"],
    ["aws key", "key " + "AKIA" + "ABCDEFGHIJKLMNOP", "AKIA" + "ABCDEFGHIJKLMNOP"],
    ["mcp token", "MCP_TOKEN=mcp-secret", "mcp-secret"],
    ["git token", "token ghp_abcdefghijklmnop", "ghp_abcdefghijklmnop"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----"],
  ])("redacts %s", (_label, input, secret) => {
    const sanitized = sanitizeProcessError(input);
    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("<redacted");
  });

  it("redacts caller-supplied secret values", () => {
    const sanitized = sanitizeProcessError("failed with value supersecret and hunter2", {
      secrets: ["supersecret", "hunter2"],
    });
    expect(sanitized).not.toContain("supersecret");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).toContain("<redacted>");
  });

  it("returns the generic code-keyed message for an unknown exception", () => {
    const sanitized = sanitizeProcessError(new Error("internal detail sk-abcdef1234567890"), {
      code: "runtime_unavailable",
    });
    expect(sanitized).toBe("The agent runtime is unavailable.");
  });

  it("falls back to the generic message for empty input", () => {
    expect(sanitizeProcessError("", { code: "interrupted" })).toBe(
      "The agent start was interrupted.",
    );
    expect(sanitizeProcessError("")).toBe("Unknown error");
  });

  it("keeps a known lifecycle error's sanitized message", () => {
    const sanitized = sanitizeProcessError(new AgentStartingError("a"), {
      code: "readiness_timeout",
    });
    expect(sanitized).toContain("did not become ready");
  });

  it("maps typed lifecycle errors to stable process codes", () => {
    expect(processErrorCode(new AgentStartingError("a"))).toBe("readiness_timeout");
    expect(processErrorCode(new AgentTokenReconcileError("a"))).toBe("token_reconcile_failed");
    expect(processErrorCode(new Error("skills_materialize_failed: nope"))).toBe(
      "skills_materialize_failed",
    );
    expect(processErrorCode(new Error("generic boom"))).toBe("runtime_unavailable");
  });
});
