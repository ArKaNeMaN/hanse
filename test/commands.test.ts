import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo } from "../src/cli/cli.js";
import {
  type CommandContext,
  imagesCommand,
  initCommand,
  serveCommand,
  statusCommand,
} from "../src/cli/commands.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

async function context(): Promise<{ ctx: CommandContext; lines: string[] }> {
  const base = await mkdtemp(path.join(tmpdir(), "hanse-cli-"));
  dirs.push(base);
  const lines: string[] = [];
  const io: CliIo = {
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  };
  return { ctx: { cwd: base, stateHome: path.join(base, "state"), io }, lines };
}

describe("cli commands", () => {
  it("init scaffolds a project and is idempotent", async () => {
    const { ctx, lines } = await context();
    expect(await initCommand("proj", ctx)).toBe(0);
    const manifest = await readFile(path.join(ctx.cwd, "proj", ".hanse", "project.yaml"), "utf8");
    expect(manifest).toContain("name: proj");
    expect(await initCommand("proj", ctx)).toBe(0);
    expect(lines.join("\n")).toContain("already initialized");
  });

  it("status registers and prints a project", async () => {
    const { ctx, lines } = await context();
    await initCommand("proj", ctx);
    expect(await statusCommand("proj", ctx)).toBe(0);
    expect(lines.join("\n")).toContain("Project proj");
    expect(lines.join("\n")).toContain("(no applications)");
  });

  it("status fails cleanly without a manifest", async () => {
    const { ctx } = await context();
    expect(await statusCommand(".", ctx)).toBe(1);
  });

  it("serve fails closed when the secret key has the wrong length", async () => {
    const { ctx, lines } = await context();
    await mkdir(path.join(ctx.stateHome, "hanse"), { recursive: true });
    await writeFile(path.join(ctx.stateHome, "hanse", "secret.key"), "too-short");
    const code = await serveCommand({ workspace: ".", hostname: "127.0.0.1", port: 0 }, ctx);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("secret key");
  });

  it("images build honors the deployment lock before reaching the runner", async () => {
    const { ctx, lines } = await context();
    await initCommand("proj", ctx);
    const manifestPath = path.join(ctx.cwd, "proj", ".hanse", "project.yaml");
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8")).replace("apps: []", "apps:\n  - path: apps/web"),
      "utf8",
    );
    const appDir = path.join(ctx.cwd, "proj", "apps", "web");
    await mkdir(path.join(appDir, ".hanse"), { recursive: true });
    await writeFile(
      path.join(appDir, ".hanse", "app.yaml"),
      "name: web\nkind: app\nbuild:\n  dockerfile: Dockerfile\n",
      "utf8",
    );
    await writeFile(path.join(appDir, "Dockerfile"), "FROM alpine\n", "utf8");
    const lockDir = path.join(ctx.cwd, "lock");
    await mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "deploy.lock");
    const now = new Date();
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        id: "lock-1",
        phase: "switching",
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
      "utf8",
    );

    const previousUrl = process.env.HANSE_RUNNER_URL;
    const previousToken = process.env.HANSE_RUNTIME_TOKEN;
    const previousLock = process.env.HANSE_DEPLOY_LOCK_FILE;
    process.env.HANSE_RUNNER_URL = "http://127.0.0.1:9";
    process.env.HANSE_RUNTIME_TOKEN = "test-token";
    process.env.HANSE_DEPLOY_LOCK_FILE = lockPath;
    try {
      const code = await imagesCommand(
        { action: "build", app: "web", project: undefined, workspace: "proj" },
        ctx,
      );
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("deployment in progress: switching");
    } finally {
      if (previousUrl === undefined) delete process.env.HANSE_RUNNER_URL;
      else process.env.HANSE_RUNNER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.HANSE_RUNTIME_TOKEN;
      else process.env.HANSE_RUNTIME_TOKEN = previousToken;
      if (previousLock === undefined) delete process.env.HANSE_DEPLOY_LOCK_FILE;
      else process.env.HANSE_DEPLOY_LOCK_FILE = previousLock;
    }
  });

  it("serve exits 1 before listening when the schema is newer", async () => {
    const { ctx, lines } = await context();
    const stateDir = path.join(ctx.stateHome, "hanse");
    await mkdir(stateDir, { recursive: true });
    const db = openDatabase(path.join(stateDir, "coordinator.db"));
    db.exec(
      "CREATE TABLE schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(17, "future", "future-checksum", new Date().toISOString());
    db.close();

    const previousToken = process.env.HANSE_RUNTIME_TOKEN;
    process.env.HANSE_RUNTIME_TOKEN = "test-runtime-token";
    try {
      const code = await serveCommand({ workspace: ".", hostname: "127.0.0.1", port: 0 }, ctx);
      expect(code).toBe(1);
      const output = lines.join("\n");
      expect(output).toContain("serve:");
      expect(output).toContain("17");
      expect(output).not.toContain("serving");
    } finally {
      if (previousToken === undefined) delete process.env.HANSE_RUNTIME_TOKEN;
      else process.env.HANSE_RUNTIME_TOKEN = previousToken;
    }

    const reopened = openDatabase(path.join(stateDir, "coordinator.db"));
    const row = reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
      count: number;
    };
    expect(row.count).toBe(1);
    reopened.close();
  });

  it("serve logs a checksum warning and continues", async () => {
    const { ctx, lines } = await context();
    const stateDir = path.join(ctx.stateHome, "hanse");
    await mkdir(stateDir, { recursive: true });
    const db = openDatabase(path.join(stateDir, "coordinator.db"));
    runMigrations(db);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 12").run();
    db.close();

    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    const priorListeners = process.listeners("SIGTERM");
    const previousToken = process.env.HANSE_RUNTIME_TOKEN;
    const previousIde = process.env.HANSE_IDE;
    process.env.HANSE_RUNTIME_TOKEN = "test-runtime-token";
    process.env.HANSE_IDE = "0";
    try {
      const pending = serveCommand({ workspace: ".", hostname: "127.0.0.1", port: 0 }, ctx);
      while (!lines.some((line) => line.includes("serving"))) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (lines.some((line) => line.includes("serve:"))) break;
      }
      process.emit("SIGTERM");
      await expect(pending).resolves.toBe(0);
      expect(warnings.join("\n")).toContain("schema_checksum_mismatch version=12");
    } finally {
      console.warn = warn;
      for (const listener of process.listeners("SIGTERM")) {
        if (!priorListeners.includes(listener)) {
          process.removeListener("SIGTERM", listener);
        }
      }
      if (previousToken === undefined) delete process.env.HANSE_RUNTIME_TOKEN;
      else process.env.HANSE_RUNTIME_TOKEN = previousToken;
      if (previousIde === undefined) delete process.env.HANSE_IDE;
      else process.env.HANSE_IDE = previousIde;
    }
  });
});
