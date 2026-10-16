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
});
