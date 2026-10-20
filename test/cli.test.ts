import { describe, expect, it } from "vitest";
import { type CliIo, runCli } from "../src/cli/cli.js";

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
