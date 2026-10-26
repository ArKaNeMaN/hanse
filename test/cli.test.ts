import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CliIo, runCli } from "../src/cli/cli.js";
import { serveCommand } from "../src/cli/commands.js";
import type { ImageServiceOptions } from "../src/images/service.js";

const cliEvents = vi.hoisted(() => ({
  events: [] as string[],
  images: undefined as { warmCache(): Promise<void> } | undefined,
  managerImages: undefined as unknown,
}));

vi.mock("../src/images/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/images/service.js")>();
  class RecordingImageService extends actual.ImageService {
    constructor(options: ImageServiceOptions) {
      super(options);
      cliEvents.events.push("image-service");
      cliEvents.images = this;
    }

    override async warmCache(): Promise<void> {
      cliEvents.events.push("warm");
    }

    override async adoptBuilds(): Promise<void> {
      cliEvents.events.push("adopt");
    }
  }
  return { ...actual, ImageService: RecordingImageService };
});

vi.mock("../src/opencode/manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/opencode/manager.js")>();
  class RecordingManager extends actual.InstanceManager {
    constructor(
      db: ConstructorParameters<typeof actual.InstanceManager>[0],
      root: ConstructorParameters<typeof actual.InstanceManager>[1],
      options: ConstructorParameters<typeof actual.InstanceManager>[2],
    ) {
      super(db, root, options);
      cliEvents.events.push("manager");
      cliEvents.managerImages = options.images;
    }

    override startStatusReconciler(): void {
      cliEvents.events.push("reconciler");
    }

    override async resumeRunning(): Promise<void> {}

    override detach(): void {}
  }
  return { ...actual, InstanceManager: RecordingManager };
});

vi.mock("../src/http/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/http/server.js")>();
  return {
    ...actual,
    createHttpServer: (): ReturnType<typeof actual.createHttpServer> => {
      cliEvents.events.push("http");
      return {
        listen: (_port: number, _host: string, callback: () => void) => {
          callback();
        },
        close: (callback: () => void) => {
          callback();
        },
      } as unknown as ReturnType<typeof actual.createHttpServer>;
    },
  };
});

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  cliEvents.events.length = 0;
  cliEvents.images = undefined;
  cliEvents.managerImages = undefined;
});

function collector(): { lines: string[]; io: CliIo } {
  const lines: string[] = [];
  return {
    lines,
    io: {
      stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(line),
    },
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("runCli", () => {
  it("prints the version and exits 0", async () => {
    const { lines, io } = collector();
    const code = await runCli(["--version"], io);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("hanse");
  });

  it("prints help and exits 0", async () => {
    const { lines, io } = collector();
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Usage:");
  });

  it("prints help when no arguments are given", async () => {
    const { lines, io } = collector();
    const code = await runCli([], io);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Usage:");
  });

  it("rejects unknown commands with exit code 2", async () => {
    const { lines, io } = collector();
    const code = await runCli(["frobnicate"], io);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("Unknown command");
  });

  it("requires --spec for agent-host", async () => {
    const { lines, io } = collector();
    const code = await runCli(["agent-host"], io);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--spec");
  });

  it("reports an unreadable agent-host spec without starting anything", async () => {
    const { lines, io } = collector();
    const code = await runCli(["agent-host", "--spec", "/nonexistent/spec.json"], io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("agent-host:");
  });

  it("refuses to start the supervisor without HANSE_RUNTIME_TOKEN", async () => {
    const previous = process.env.HANSE_RUNTIME_TOKEN;
    delete process.env.HANSE_RUNTIME_TOKEN;
    try {
      const { lines, io } = collector();
      const code = await runCli(["agent-supervisor"], io);
      expect(code).toBe(2);
      expect(lines.join("\n")).toContain("HANSE_RUNTIME_TOKEN");
    } finally {
      if (previous === undefined) delete process.env.HANSE_RUNTIME_TOKEN;
      else process.env.HANSE_RUNTIME_TOKEN = previous;
    }
  });

  it("rejects an invalid supervisor port before listening", async () => {
    const previous = process.env.HANSE_RUNTIME_TOKEN;
    process.env.HANSE_RUNTIME_TOKEN = "test-token";
    try {
      const { lines, io } = collector();
      const code = await runCli(["agent-supervisor", "--port", "70000"], io);
      expect(code).toBe(2);
      expect(lines.join("\n")).toContain("--port");
    } finally {
      if (previous === undefined) delete process.env.HANSE_RUNTIME_TOKEN;
      else process.env.HANSE_RUNTIME_TOKEN = previous;
    }
  });
});

describe("serve startup order", () => {
  it("constructs images before the manager and warms/adopts before HTTP", async () => {
    const workspace = tempDir("hanse-cli-workspace-");
    const stateHome = tempDir("hanse-cli-state-");
    const hostWorkspace = tempDir("hanse-cli-host-workspace-");
    const hostAgents = tempDir("hanse-cli-host-agents-");
    const { lines, io } = collector();
    const variables = {
      HANSE_RUNNER_URL: process.env.HANSE_RUNNER_URL,
      HANSE_RUNTIME_TOKEN: process.env.HANSE_RUNTIME_TOKEN,
      HANSE_HOST_WORKSPACE: process.env.HANSE_HOST_WORKSPACE,
      HANSE_HOST_AGENTS: process.env.HANSE_HOST_AGENTS,
      HANSE_IDE: process.env.HANSE_IDE,
    };
    process.env.HANSE_RUNNER_URL = "http://127.0.0.1:9";
    process.env.HANSE_RUNTIME_TOKEN = "test-runtime-token";
    process.env.HANSE_HOST_WORKSPACE = hostWorkspace;
    process.env.HANSE_HOST_AGENTS = hostAgents;
    process.env.HANSE_IDE = "0";
    const priorListeners = process.listeners("SIGTERM");
    try {
      const pending = serveCommand(
        { workspace, hostname: "127.0.0.1", port: 0 },
        { cwd: workspace, stateHome, io },
      );
      while (!lines.some((line) => line.includes("serving"))) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (lines.some((line) => line.includes("serve:"))) break;
      }
      process.emit("SIGTERM");
      await expect(pending).resolves.toBe(0);
    } finally {
      for (const listener of process.listeners("SIGTERM")) {
        if (!priorListeners.includes(listener)) {
          process.removeListener("SIGTERM", listener);
        }
      }
      for (const [key, value] of Object.entries(variables)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(cliEvents.events).toEqual([
      "image-service",
      "manager",
      "warm",
      "adopt",
      "reconciler",
      "http",
    ]);
    expect(cliEvents.managerImages).toBe(cliEvents.images);
    expect(cliEvents.images).toBeDefined();
  });
});
