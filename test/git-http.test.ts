import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import {
  type GitActionResult,
  GitError,
  type GitRunner,
  GitService,
  type GitStatus,
  type ResolvedRepository,
} from "../src/git/service.js";
import { handleGit } from "../src/http/git.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  databases.length = 0;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function git(cwd: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0 };
  } catch (error) {
    const record = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
    };
    return {
      stdout: String(record.stdout ?? ""),
      stderr: String(record.stderr ?? ""),
      code: typeof record.code === "number" ? record.code : 1,
    };
  }
}

const realRunner: GitRunner = (command) =>
  new Promise((resolve, reject) => {
    execFile(
      command.bin,
      command.args,
      {
        cwd: command.cwd,
        env: command.env,
        timeout: command.timeout,
        maxBuffer: command.maxBuffer,
        killSignal: command.killSignal,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ stdout: String(stdout), stderr: String(stderr), code: error.code });
          return;
        }
        reject(error);
      },
    );
  });

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  projectRoot: string;
  repo: string;
  workspace: string;
  token: string;
  agentToken: string;
}

function addApp(db: SqliteDatabase, appKey: string, appPath: string): void {
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
  ).run(`p:${appKey}`, appKey, appPath, new Date().toISOString());
}

async function fixture(options: { origin?: boolean } = {}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-git-http-"));
  dirs.push(dir);
  const workspacePath = path.join(dir, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const workspace = realpathSync(workspacePath);
  const projectRoot = path.join(workspace, "p");
  const repo = path.join(projectRoot, "repo");
  mkdirSync(repo, { recursive: true });

  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test Operator"]);
  await git(repo, ["config", "user.email", "operator@example.com"]);
  writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);

  if (options.origin === true) {
    const bare = path.join(repo, ".git", "remotes", "remote.git");
    mkdirSync(bare, { recursive: true });
    await git(bare, ["init", "--bare", "-b", "main"]);
    await git(repo, ["remote", "add", "origin", pathToFileURL(bare).href]);
    await git(repo, ["push", "-u", "origin", "main"]);
  }

  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(projectRoot, now, now);
  addApp(db, "repo", "repo");

  const service = new CoordinatorService(db, "p");
  const gitService = new GitService({ workspaceRoot: workspace });
  const deps: HttpDeps = {
    db,
    workspaceRoot: workspace,
    git: gitService,
    getProjects: () => [
      { id: "p", name: "P", rootPath: projectRoot, workspaceRoot: workspace, service },
    ],
  };
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "agent" }).token;

  return { db, deps, projectRoot, repo, workspace, token, agentToken };
}

const BASE = "/api/projects/p/apps/repo/git";

function get(fixtureData: Fixture, subpath: string): HttpRequest {
  return {
    method: "GET",
    path: `${BASE}${subpath}`,
    headers: { authorization: `Bearer ${fixtureData.token}` },
  };
}

function post(
  fixtureData: Fixture,
  subpath: string,
  body: unknown,
  contentType = "application/json",
): HttpRequest {
  return {
    method: "POST",
    path: `${BASE}${subpath}`,
    headers: {
      authorization: `Bearer ${fixtureData.token}`,
      "content-type": contentType,
    },
    body: JSON.stringify(body),
  };
}

function parse<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

class FailingGitService extends GitService {
  readonly #failure: GitError;
  readonly #mode: "resolve" | "status" | "action";

  constructor(failure: GitError, mode: "resolve" | "status" | "action") {
    super({ workspaceRoot: "/tmp" });
    this.#failure = failure;
    this.#mode = mode;
  }

  override async statusFor(): Promise<GitStatus> {
    throw this.#failure;
  }

  override async resolveRepository(): Promise<ResolvedRepository> {
    if (this.#mode === "resolve") {
      throw this.#failure;
    }
    return { root: "/tmp", appDir: "/tmp" };
  }

  override async fetch(): Promise<GitActionResult> {
    throw this.#failure;
  }

  override async update(): Promise<GitActionResult> {
    throw this.#failure;
  }

  override async push(): Promise<GitActionResult> {
    throw this.#failure;
  }

  override async commitAll(): Promise<GitActionResult> {
    throw this.#failure;
  }
}

describe("git HTTP API", () => {
  it("returns repository status for a human", async () => {
    const f = await fixture();
    const response = await handleGit(f.deps, get(f, "/status"));

    expect(response.status).toBe(200);
    const payload = parse<{ status: { state: string; branch: { name: string }; clean: boolean } }>(
      response,
    );
    expect(payload.status.state).toBe("ok");
    expect(payload.status.branch.name).toBe("main");
    expect(payload.status.clean).toBe(true);
  });

  it("dispatches the git API through the HTTP server", async () => {
    const f = await fixture();
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server did not bind to a port");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${BASE}/status`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { status: { state: string } };
    expect(payload.status.state).toBe("ok");
  });

  it("rejects anonymous and agent principals", async () => {
    const f = await fixture();
    const anonymous = await handleGit(f.deps, {
      method: "GET",
      path: `${BASE}/status`,
      headers: {},
    });
    expect(anonymous.status).toBe(401);
    expect(parse(anonymous)).toEqual({ error: "sign in required", code: "unauthorized" });

    const agent = await handleGit(f.deps, {
      method: "POST",
      path: `${BASE}/fetch`,
      headers: {
        authorization: `Bearer ${f.agentToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(agent.status).toBe(403);
    expect(parse(agent)).toEqual({
      error: "only a human operator may use git actions",
      code: "forbidden",
    });
  });

  it("returns 404 for an unknown project or application", async () => {
    const f = await fixture();
    for (const url of [
      "/api/projects/nope/apps/repo/git/status",
      "/api/projects/p/apps/nope/git/status",
      "/api/projects/p/apps/repo/git/toString",
    ]) {
      const response = await handleGit(f.deps, {
        method: "GET",
        path: url,
        headers: { authorization: `Bearer ${f.token}` },
      });
      expect(response.status).toBe(404);
      expect(parse(response)).toEqual({ error: "not found", code: "not_found" });
    }
  });

  it("enforces methods, JSON content type, and body validation", async () => {
    const f = await fixture();
    const wrongStatusMethod = await handleGit(f.deps, post(f, "/status", {}));
    expect(wrongStatusMethod.status).toBe(405);

    const wrongFetchMethod = await handleGit(f.deps, get(f, "/fetch"));
    expect(wrongFetchMethod.status).toBe(405);

    const formType = await handleGit(
      f.deps,
      post(f, "/fetch", {}, "application/x-www-form-urlencoded"),
    );
    expect(formType.status).toBe(400);
    expect(parse(formType)).toMatchObject({ code: "invalid_input" });

    const malformed = await handleGit(f.deps, {
      method: "POST",
      path: `${BASE}/commit`,
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
      },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(parse(malformed)).toMatchObject({ code: "invalid_input" });

    const missingMessage = await handleGit(f.deps, post(f, "/commit", {}));
    expect(missingMessage.status).toBe(400);
    expect(parse(missingMessage)).toEqual({ error: "message is required", code: "invalid_input" });

    const missingBranch = await handleGit(f.deps, post(f, "/branches/switch", {}));
    expect(missingBranch.status).toBe(400);
    expect(parse(missingBranch)).toEqual({ error: "branch is required", code: "invalid_input" });
  });

  it("returns 413 for request bodies above 64 KiB", async () => {
    const f = await fixture();
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server did not bind to a port");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${BASE}/commit`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "x".repeat(70 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "request body too large",
      code: "payload_too_large",
    });
  });

  it("maps outside-workspace, non-git, and missing paths", async () => {
    const f = await fixture();
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "hanse-git-http-out-")));
    dirs.push(outside);
    await git(outside, ["init", "-b", "main"]);
    const outsideService = new GitService({ workspaceRoot: f.workspace });
    const deps = (gitService: GitService): HttpDeps => ({ ...f.deps, git: gitService });

    addApp(f.db, "outside", outside);
    const outsideStatus = await handleGit(deps(outsideService), {
      method: "GET",
      path: "/api/projects/p/apps/outside/git/status",
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(outsideStatus.status).toBe(403);
    expect(parse(outsideStatus)).toMatchObject({ code: "outside_workspace" });

    mkdirSync(path.join(f.projectRoot, "plain"));
    addApp(f.db, "plain", "plain");
    const notGit = await handleGit(deps(outsideService), {
      method: "GET",
      path: "/api/projects/p/apps/plain/git/status",
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(notGit.status).toBe(200);
    expect(parse<{ status: { state: string } }>(notGit).status.state).toBe("not_git");

    addApp(f.db, "missing", "missing");
    const missing = await handleGit(deps(outsideService), {
      method: "POST",
      path: "/api/projects/p/apps/missing/git/fetch",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(missing.status).toBe(409);
    expect(parse(missing)).toMatchObject({ code: "missing_path" });
  });

  it("fetches, fast-forward updates, and pushes against a file remote", async () => {
    const f = await fixture({ origin: true });

    const fetched = await handleGit(f.deps, post(f, "/fetch", {}));
    expect(fetched.status).toBe(200);
    expect(parse<{ message: string }>(fetched).message).toBe("Fetched all remotes.");

    const updated = await handleGit(f.deps, post(f, "/update", {}));
    expect(updated.status).toBe(200);
    const updatePayload = parse<{ status: { upstream: { name: string } } }>(updated);
    expect(updatePayload.status.upstream.name).toBe("origin/main");

    const pushed = await handleGit(f.deps, post(f, "/push", {}));
    expect(pushed.status).toBe(200);
    expect(parse<{ message: string }>(pushed).message).toBe("Pushed to origin/main.");
  });

  it("commits all changes", async () => {
    const f = await fixture();
    writeFileSync(path.join(f.repo, "tracked.txt"), "two\n");
    writeFileSync(path.join(f.repo, "untracked.txt"), "untracked\n");

    const response = await handleGit(f.deps, post(f, "/commit", { message: "API commit" }));
    expect(response.status).toBe(200);
    const payload = parse<{
      message: string;
      commit: { shortHash: string; subject: string };
      status: { clean: boolean };
    }>(response);
    expect(payload.message).toBe(`Committed as ${payload.commit.shortHash}.`);
    expect(payload.commit.subject).toBe("API commit");
    expect(payload.status.clean).toBe(true);
    expect((await git(f.repo, ["ls-files"])).stdout).toContain("untracked.txt");
  });

  it("switches branches and reports invalid branch names", async () => {
    const f = await fixture();
    await git(f.repo, ["branch", "feature"]);

    const switched = await handleGit(f.deps, post(f, "/branches/switch", { branch: "feature" }));
    expect(switched.status).toBe(200);
    expect(parse<{ status: { branch: { name: string } } }>(switched).status.branch.name).toBe(
      "feature",
    );

    for (const branch of ["nope", "-x", "bad\nbranch"]) {
      const response = await handleGit(f.deps, post(f, "/branches/switch", { branch }));
      expect(response.status).toBe(409);
      expect(parse(response)).toMatchObject({ code: "branch_not_found" });
    }
  });

  it("returns 409 busy for a concurrent mutation", async () => {
    const f = await fixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let started: () => void = () => undefined;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    const runner: GitRunner = async (command) => {
      if (command.args.includes("fetch")) {
        started();
        await gate;
      }
      return realRunner(command);
    };
    const deps: HttpDeps = {
      ...f.deps,
      git: new GitService({ workspaceRoot: f.workspace, runner }),
    };

    const first = handleGit(deps, post(f, "/fetch", {}));
    await fetchStarted;
    const second = await handleGit(deps, post(f, "/fetch", {}));
    expect(second.status).toBe(409);
    expect(parse(second)).toMatchObject({ code: "busy" });
    release();
    expect((await first).status).toBe(200);
  });

  it("maps GitError codes to HTTP statuses", async () => {
    const f = await fixture();
    const cases: Array<{
      error: GitError;
      mode: "resolve" | "status" | "action";
      request: (fixtureData: Fixture) => HttpRequest;
      status: number;
    }> = [
      {
        error: new GitError("outside_workspace", "outside"),
        mode: "status",
        request: (data) => get(data, "/status"),
        status: 403,
      },
      {
        error: new GitError("timeout", "timed out"),
        mode: "status",
        request: (data) => get(data, "/status"),
        status: 500,
      },
      {
        error: new GitError("git_failed", "failed"),
        mode: "action",
        request: (data) => post(data, "/fetch", {}),
        status: 502,
      },
      {
        error: new GitError("auth_failed", "auth failed"),
        mode: "action",
        request: (data) => post(data, "/fetch", {}),
        status: 502,
      },
      {
        error: new GitError("push_rejected", "rejected"),
        mode: "action",
        request: (data) => post(data, "/push", {}),
        status: 409,
      },
      {
        error: new GitError("invalid_input", "bad input"),
        mode: "action",
        request: (data) => post(data, "/commit", { message: "x" }),
        status: 400,
      },
      {
        error: new GitError("conflicts", "conflicts"),
        mode: "action",
        request: (data) => post(data, "/commit", { message: "x" }),
        status: 409,
      },
      {
        error: new GitError("git_failed", "failed"),
        mode: "action",
        request: (data) => post(data, "/commit", { message: "x" }),
        status: 500,
      },
      {
        error: new GitError("timeout", "timed out"),
        mode: "action",
        request: (data) => post(data, "/commit", { message: "x" }),
        status: 500,
      },
      {
        error: new GitError("not_git", "not git"),
        mode: "resolve",
        request: (data) => post(data, "/fetch", {}),
        status: 409,
      },
    ];

    for (const entry of cases) {
      const deps: HttpDeps = { ...f.deps, git: new FailingGitService(entry.error, entry.mode) };
      const response = await handleGit(deps, entry.request(f));
      expect(response.status, entry.error.code).toBe(entry.status);
      expect(parse(response)).toEqual({ error: entry.error.message, code: entry.error.code });
    }
  });
});
