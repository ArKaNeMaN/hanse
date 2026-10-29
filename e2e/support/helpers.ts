import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const E2E_TOKEN = "test-operator-token";
export const PROJECT_ONE = "e2e-project-one";
export const PROJECT_TWO = "e2e-project-two";
export const MASTER_PROJECT = "hanse-master";
/** Bare repository served by the spa fixture's git daemon (port 4310 + 1000). */
export const E2E_SPA_REMOTE = "git://127.0.0.1:5310/remote.git";

export interface E2EFixtureRepos {
  readonly workspaceRoot: string;
  readonly apps: Readonly<Record<string, string>>;
}

function fixtureGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "E2E Fixture",
    GIT_AUTHOR_EMAIL: "e2e@example.test",
    GIT_COMMITTER_NAME: "E2E Fixture",
    GIT_COMMITTER_EMAIL: "e2e@example.test",
  };
}

function runGit(cwd: string, args: readonly string[], allowFailure = false): string {
  try {
    return String(
      execFileSync("git", [...args], {
        cwd,
        env: fixtureGitEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    if (allowFailure) {
      return "";
    }
    throw error;
  }
}

export function fixtureRepos(port = 4310): E2EFixtureRepos {
  return JSON.parse(
    readFileSync(path.join(tmpdir(), `hanse-e2e-repos-${port}.json`), "utf8"),
  ) as E2EFixtureRepos;
}

export function appRepo(projectId: string, appKey: string, port = 4310): string {
  const repo = fixtureRepos(port).apps[`${projectId}:${appKey}`];
  if (repo === undefined) {
    throw new Error(`No fixture repository for ${projectId}:${appKey}`);
  }
  return repo;
}

function hasOrigin(repo: string): boolean {
  return runGit(repo, ["remote", "get-url", "origin"], true).trim().length > 0;
}

function resetRepo(repo: string): void {
  for (const args of [
    ["merge", "--abort"],
    ["rebase", "--abort"],
    ["cherry-pick", "--abort"],
    ["revert", "--abort"],
  ] as const) {
    runGit(repo, args, true);
  }
  if (hasOrigin(repo)) {
    runGit(repo, ["fetch", "-q", "--prune", "origin"], true);
  }
  runGit(repo, ["checkout", "-f", "main"], true);
  runGit(repo, ["reset", "--hard", "-q", hasOrigin(repo) ? "origin/main" : "HEAD"], true);
  runGit(repo, ["clean", "-fdq"], true);
  runGit(repo, ["branch", "-D", "conflict"], true);
}

function commitFiles(repo: string, files: Readonly<Record<string, string>>, message: string): void {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(repo, file), content, "utf8");
  }
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

function pushRemoteCommit(repo: string): void {
  const scratch = mkdtempSync(path.join(tmpdir(), "hanse-e2e-remote-"));
  try {
    const clone = path.join(scratch, "clone");
    runGit(scratch, ["clone", "-q", path.join(repo, ".git", "e2e-remote.git"), clone]);
    runGit(clone, ["config", "user.name", "E2E Fixture"]);
    runGit(clone, ["config", "user.email", "e2e@example.test"]);
    writeFileSync(path.join(clone, "remote.txt"), `remote ${Date.now()}\n`, "utf8");
    runGit(clone, ["add", "remote.txt"]);
    runGit(clone, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "remote change"]);
    runGit(clone, ["push", "-q", "origin", "main"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export type GitScenario =
  | "clean"
  | "dirty"
  | "detached"
  | "conflicted"
  | "ahead"
  | "behind"
  | "diverged";

export function prepareGitState(
  projectId: string,
  appKey: string,
  scenario: GitScenario,
  port = 4310,
): void {
  const repo = appRepo(projectId, appKey, port);
  resetRepo(repo);
  if (scenario === "dirty") {
    writeFileSync(path.join(repo, "README.md"), `# dirty ${Date.now()}\n`, "utf8");
    writeFileSync(path.join(repo, "staged.txt"), "staged\n", "utf8");
    runGit(repo, ["add", "staged.txt"]);
    writeFileSync(path.join(repo, "untracked.txt"), "untracked\n", "utf8");
    return;
  }
  if (scenario === "detached") {
    runGit(repo, ["checkout", "-q", "--detach", "HEAD"]);
    return;
  }
  if (scenario === "conflicted") {
    runGit(repo, ["checkout", "-q", "-B", "conflict"]);
    commitFiles(repo, { "README.md": "# conflict branch\n" }, "conflict branch");
    runGit(repo, ["checkout", "-q", "main"]);
    commitFiles(repo, { "README.md": "# main branch\n" }, "main change");
    runGit(repo, ["merge", "conflict"], true);
    return;
  }
  if (scenario === "ahead") {
    commitFiles(repo, { "ahead.txt": "ahead\n" }, "local ahead");
    return;
  }
  if (scenario === "behind") {
    pushRemoteCommit(repo);
    runGit(repo, ["fetch", "-q", "origin"]);
    return;
  }
  if (scenario === "diverged") {
    commitFiles(repo, { "local.txt": "local\n" }, "local change");
    pushRemoteCommit(repo);
    runGit(repo, ["fetch", "-q", "origin"]);
  }
}

export async function signIn(page: Page, next = "/projects"): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Operator token (required)").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}

/** Collect browser console errors and uncaught page errors for a spec. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Wait for page-triggered fetches (git status, image status) to settle. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
}

export function expectNoPageErrors(errors: string[]): void {
  expect(errors, errors.join("\n")).toEqual([]);
}
