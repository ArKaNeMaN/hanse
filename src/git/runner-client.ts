import { GitError, isGitErrorCode } from "./errors.js";
import type { GitRequest } from "./request.js";
import type { GitActionResult, GitStatus, ResolvedRepository } from "./service.js";

export interface RunnerGitClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RunnerGitResponse {
  status?: GitStatus;
  result?: GitActionResult;
}

const GIT_TIMEOUTS: Record<GitRequest["operation"], number> = {
  status: 60_000,
  switch: 60_000,
  commit: 60_000,
  fetch: 150_000,
  update: 150_000,
  push: 210_000,
};
const ERROR_EXCERPT_CHARS = 300;

function transportMessage(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "request timed out";
  }
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coordinator client for the runner's fixed git endpoint.
 *
 * Repository-controlled git config never runs in the coordinator process; the runner executes the
 * validated operation in a one-shot sandbox container and returns the same result shapes the local
 * GitService used to produce.
 */
export class RunnerGitClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number | undefined;

  constructor(options: RunnerGitClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl.length === 0) {
      throw new Error("git runner base URL is required");
    }
    if (options.token.trim().length === 0) {
      throw new Error("HANSE_RUNTIME_TOKEN is required for runner-backed git");
    }
    this.#baseUrl = baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  async status(resolved: ResolvedRepository): Promise<GitStatus> {
    const response = await this.#call(resolved, { operation: "status" });
    if (response.status === undefined) {
      throw new GitError("git_failed", "git runner returned no status");
    }
    return response.status;
  }

  async fetch(resolved: ResolvedRepository): Promise<GitActionResult> {
    return this.#action(resolved, { operation: "fetch" });
  }

  async update(resolved: ResolvedRepository): Promise<GitActionResult> {
    return this.#action(resolved, { operation: "update" });
  }

  async switchBranch(resolved: ResolvedRepository, branch: string): Promise<GitActionResult> {
    return this.#action(resolved, { operation: "switch", branch });
  }

  async commitAll(resolved: ResolvedRepository, message: string): Promise<GitActionResult> {
    return this.#action(resolved, { operation: "commit", message });
  }

  async push(resolved: ResolvedRepository): Promise<GitActionResult> {
    return this.#action(resolved, { operation: "push" });
  }

  async #action(resolved: ResolvedRepository, request: GitRequest): Promise<GitActionResult> {
    const response = await this.#call(resolved, request);
    if (response.result === undefined) {
      throw new GitError("git_failed", "git runner returned no result");
    }
    return response.result;
  }

  async #call(resolved: ResolvedRepository, request: GitRequest): Promise<RunnerGitResponse> {
    const appId = resolved.appId;
    if (appId === undefined || appId.length === 0) {
      throw new GitError("invalid_input", "app id is required for runner-backed git");
    }
    const path = `/v1/apps/${encodeURIComponent(appId)}/git`;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.#timeoutMs ?? GIT_TIMEOUTS[request.operation]),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new GitError("timeout", "git runner request timed out");
      }
      throw new GitError("git_failed", `git runner request failed: ${transportMessage(error)}`);
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let parsed: unknown;
      try {
        parsed = text.trim().length === 0 ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (isRecord(parsed) && typeof parsed.error === "string") {
        const code = isGitErrorCode(parsed.code) ? parsed.code : "git_failed";
        throw new GitError(
          code,
          parsed.error,
          typeof parsed.root === "string" ? { root: parsed.root } : undefined,
        );
      }
      throw new GitError(
        "git_failed",
        `git runner rejected the request with HTTP ${response.status}: ${text.slice(
          0,
          ERROR_EXCERPT_CHARS,
        )}`,
      );
    }

    if (text.trim().length === 0) {
      throw new GitError("git_failed", "git runner returned an empty response");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GitError("git_failed", "git runner returned invalid JSON");
    }
    if (!isRecord(parsed)) {
      throw new GitError("git_failed", "git runner returned an invalid result");
    }
    return parsed as RunnerGitResponse;
  }
}
