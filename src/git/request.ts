import { ConfigError } from "../config/load.js";

export const GIT_OPERATIONS = ["status", "fetch", "update", "switch", "commit", "push"] as const;
export type GitOperation = (typeof GIT_OPERATIONS)[number];

export interface GitRequest {
  operation: GitOperation;
  branch?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): ConfigError {
  return new ConfigError("VALIDATION_FAILED", message);
}

function safeBranch(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw invalid("branch must be a non-empty string of at most 200 characters");
  }
  if (
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("\0") ||
    /\s/.test(value) ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw invalid(`invalid branch name: ${value}`);
  }
  return value;
}

/**
 * Validate the fixed git operation set used by the runner and its sandbox helper.
 *
 * Callers never accept arbitrary git arguments. B1.5 executes the validated operation in a one-shot
 * container with only the app directory and a read-only credential directory mounted.
 */
export function validateGitRequest(value: unknown): GitRequest {
  if (!isRecord(value)) {
    throw invalid("git request must be an object");
  }
  const allowed = new Set(["operation", "branch", "message"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`unknown git request field: ${key}`);
    }
  }
  const operation = value.operation;
  if (typeof operation !== "string" || !(GIT_OPERATIONS as readonly string[]).includes(operation)) {
    throw invalid(`git operation must be one of: ${GIT_OPERATIONS.join(", ")}`);
  }
  const result: GitRequest = { operation: operation as GitOperation };
  if (value.branch !== undefined) {
    if (operation !== "switch") {
      throw invalid("branch is only valid for the switch operation");
    }
    result.branch = safeBranch(value.branch);
  }
  if (value.message !== undefined) {
    if (operation !== "commit") {
      throw invalid("message is only valid for the commit operation");
    }
    if (typeof value.message !== "string" || value.message.trim().length === 0) {
      throw invalid("commit message is required");
    }
    const message = value.message.trim();
    if (message.length > 4000 || message.includes("\0")) {
      throw invalid("commit message is invalid");
    }
    result.message = message;
  }
  if (operation === "switch" && result.branch === undefined) {
    throw invalid("branch is required for the switch operation");
  }
  if (operation === "commit" && result.message === undefined) {
    throw invalid("message is required for the commit operation");
  }
  return result;
}
