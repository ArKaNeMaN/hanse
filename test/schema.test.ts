import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseApp, parseProject, safeParseApp, safeParseProject } from "../src/schema/index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): unknown {
  return parseYaml(readFileSync(path.join(fixturesDir, name), "utf8"));
}

describe("project schema", () => {
  it("accepts a full valid manifest and keeps provided values", () => {
    const project = parseProject(loadFixture("project.yaml"));
    expect(project.name).toBe("demo-project");
    expect(project.base_branch).toBe("main");
    expect(project.apps).toHaveLength(2);
  });

  it("applies defaults for a minimal manifest", () => {
    const project = parseProject(loadFixture("project.minimal.yaml"));
    expect(project.base_branch).toBe("main");
    expect(project.apps).toEqual([]);
  });

  it("rejects an invalid manifest", () => {
    const result = safeParseProject(loadFixture("project.invalid.yaml"));
    expect(result.success).toBe(false);
  });
});

describe("app schema", () => {
  it("accepts a full valid descriptor and applies defaults", () => {
    const app = parseApp(loadFixture("app.yaml"));
    expect(app.name).toBe("web");
    expect(app.contract).toBe("AGENTS.md");
    expect(app.ports?.http).toBe(3000);
  });

  it("applies defaults for a minimal descriptor", () => {
    const app = parseApp(loadFixture("app.minimal.yaml"));
    expect(app.contract).toBe("AGENTS.md");
  });

  it("rejects an invalid descriptor", () => {
    const result = safeParseApp(loadFixture("app.invalid.yaml"));
    expect(result.success).toBe(false);
  });
});
