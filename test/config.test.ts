import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadAppConfig, loadProjectConfig } from "../src/config/load.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const projectRootDir = path.join(fixturesDir, "project-root");
const nestedAppDir = path.join(projectRootDir, "apps", "web");

describe("loadProjectConfig", () => {
  it("finds and loads a manifest by walking up from a nested directory", async () => {
    const project = await loadProjectConfig(nestedAppDir);
    expect(project.name).toBe("demo-project");
  });

  it("throws NOT_FOUND when no manifest exists", async () => {
    const missing = path.join(tmpdir(), "hanse-nonexistent-dir-7f3a");
    await expect(loadProjectConfig(missing)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws VALIDATION_FAILED for an invalid manifest", async () => {
    const brokenRoot = await mkdtemp(path.join(tmpdir(), "hanse-broken-"));
    await mkdir(path.join(brokenRoot, ".hanse"), { recursive: true });
    await writeFile(
      path.join(brokenRoot, ".hanse", "project.yaml"),
      "id: not-a-uuid\nname: ''\napps: not-a-list\n",
      "utf8",
    );
    try {
      await expect(loadProjectConfig(brokenRoot)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  });
});

describe("loadAppConfig", () => {
  it("finds and loads the app descriptor", async () => {
    const app = await loadAppConfig(nestedAppDir);
    expect(app.name).toBe("web");
  });

  it("reads the raw fixture as expected", async () => {
    const raw = await readFile(path.join(projectRootDir, ".hanse", "project.yaml"), "utf8");
    expect(raw).toContain("demo-project");
  });
});
