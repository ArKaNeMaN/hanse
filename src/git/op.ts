import { GitError } from "./errors.js";
import type { GitRequest, GitTestKind, GitTestResult } from "./request.js";
import { type GitActionResult, type GitRunner, GitService, type GitStatus } from "./service.js";

export type { GitTestResult } from "./request.js";

/** The fixed workspace root mounted into the one-shot git container. */
export const GIT_SANDBOX_WORKSPACE_ROOT = "/data/workspace";
export const GIT_SANDBOX_APP_DIR_ENV = "HANSE_GIT_APP_DIR";
export const GIT_SANDBOX_OPERATION_ENV = "HANSE_GIT_OP";
export const GIT_SANDBOX_BRANCH_ENV = "HANSE_GIT_BRANCH";
export const GIT_SANDBOX_MESSAGE_ENV = "HANSE_GIT_MESSAGE";
export const GIT_SANDBOX_TEST_KIND_ENV = "HANSE_TEST_KIND";
export const GIT_SANDBOX_TEST_REMOTE_ENV = "HANSE_TEST_REMOTE";

export interface GitOpPayload {
  status?: GitStatus;
  result?: GitActionResult;
  test?: GitTestResult;
}

export interface GitOpErrorPayload {
  error: string;
  code: string;
  root?: string;
}

export interface RunGitOperationOptions {
  request: GitRequest;
  workspaceRoot: string;
  appDir: string;
  env: NodeJS.ProcessEnv;
  gitBin?: string;
  runnerImpl?: GitRunner;
}

/**
 * Execute one validated git operation with the same hardened GitService used in B0.6.
 *
 * This runs inside the app image's one-shot sandbox container, where the only writable mount is the
 * application directory and the only inherited configuration is the runner-controlled environment.
 */
export async function runGitOperation(options: RunGitOperationOptions): Promise<GitOpPayload> {
  const service = new GitService({
    workspaceRoot: options.workspaceRoot,
    env: options.env,
    ...(options.gitBin === undefined ? {} : { gitBin: options.gitBin }),
    ...(options.runnerImpl === undefined ? {} : { runner: options.runnerImpl }),
  });
  const resolved = await service.resolveRepository(options.workspaceRoot, options.appDir);

  switch (options.request.operation) {
    case "status":
      return { status: await service.status(resolved) };
    case "fetch":
      return { result: await service.fetch(resolved) };
    case "update":
      return { result: await service.update(resolved) };
    case "push":
      return { result: await service.push(resolved) };
    case "switch":
      return { result: await service.switchBranch(resolved, options.request.branch ?? "") };
    case "commit":
      return { result: await service.commitAll(resolved, options.request.message ?? "") };
  }
}

/** Convert a failure into the bounded JSON envelope the runner can parse from container logs. */
export function gitOpError(error: unknown): GitOpErrorPayload {
  if (error instanceof GitError) {
    return {
      error: error.message,
      code: error.code,
      ...(error.root === undefined ? {} : { root: error.root }),
    };
  }
  return {
    error: error instanceof Error ? error.message : "git operation failed",
    code: "git_failed",
  };
}

export interface RunGitTestOptions {
  workspaceRoot: string;
  appDir: string;
  env: NodeJS.ProcessEnv;
  kind: GitTestKind;
  remote?: string;
  gitBin?: string;
  runnerImpl?: GitRunner;
}

/** Execute the app-scoped Test connection inside the one-shot sandbox. */
export async function runGitTest(options: RunGitTestOptions): Promise<GitTestResult> {
  const service = new GitService({
    workspaceRoot: options.workspaceRoot,
    env: options.env,
    ...(options.gitBin === undefined ? {} : { gitBin: options.gitBin }),
    ...(options.runnerImpl === undefined ? {} : { runner: options.runnerImpl }),
  });
  const resolved = await service.resolveRepository(options.workspaceRoot, options.appDir);
  return service.testConnection(resolved, {
    kind: options.kind,
    ...(options.remote === undefined ? {} : { remote: options.remote }),
  });
}
