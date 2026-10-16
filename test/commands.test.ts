import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo } from "../src/cli/cli.js";
import { type CommandContext, initCommand, statusCommand } from "../src/cli/commands.js";

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
});
