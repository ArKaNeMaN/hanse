import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(srcDir, relative), "utf8");
}

describe("no local opencode spawn in production", () => {
  it("keeps the manager on the runtime client and free of process spawning", () => {
    const manager = read("opencode/manager.ts");
    expect(manager).not.toMatch(/\bspawn\s*\(/);
    expect(manager).not.toMatch(/from\s+["']\.\/launcher\.js["']/);
    expect(manager).not.toMatch(/launchInstance|stopInstance|RunningInstance/);
    expect(manager).toMatch(/AgentRuntimeClient/);
    expect(manager).toMatch(/runtime\.ensure\(/);
  });

  it("does not start opencode from the CLI or HTTP layers", () => {
    for (const file of [
      "cli/commands.ts",
      "http/chat.ts",
      "http/prompts.ts",
      "http/settings.ts",
      "http/server.ts",
    ]) {
      expect(read(file), file).not.toMatch(/spawn\(\s*["']opencode["']/);
    }
  });
});
