import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, type ConfigErrorCode } from "../src/config/load.js";
import { resolveBuildDockerfile } from "../src/runtime/build-spec.js";
import { parseApp, safeParseApp } from "../src/schema/index.js";

const FROM_BASE = `FROM \${HANSE_BASE}\n`;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

async function fixture(): Promise<{ base: string; appDir: string; outside: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "hanse-build-schema-"));
  dirs.push(base);
  const appDir = path.join(base, "app");
  const outside = path.join(base, "outside");
  await mkdir(appDir, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { base, appDir, outside };
}

function expectConfigError(run: () => unknown, code: ConfigErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(code);
    return;
  }
  throw new Error("expected a ConfigError");
}

describe("app build schema", () => {
  it("defaults the Dockerfile and keeps build optional", () => {
    expect(parseApp({ name: "web" }).build).toBeUndefined();

    const app = parseApp({ name: "web", build: {} });
    expect(app.build?.dockerfile).toBe("Dockerfile");
    expect(app.build?.args).toBeUndefined();
  });

  it("accepts a relative Dockerfile and build arguments", () => {
    const app = parseApp({
      name: "web",
      build: {
        dockerfile: ".hanse/Dockerfile",
        args: { NODE_VERSION: "22", HANSE_BASE: "ghcr.io/example/base:1" },
      },
    });
    expect(app.build).toEqual({
      dockerfile: ".hanse/Dockerfile",
      args: { NODE_VERSION: "22", HANSE_BASE: "ghcr.io/example/base:1" },
    });
  });

  it("rejects empty, absolute, and parent-escaping Dockerfile paths", () => {
    for (const dockerfile of [
      "",
      "/etc/Dockerfile",
      "C:\\Dockerfile",
      "../Dockerfile",
      "a/../../Dockerfile",
    ]) {
      expect(safeParseApp({ name: "web", build: { dockerfile } }).success).toBe(false);
    }
  });

  it("rejects NUL bytes and empty build argument names", () => {
    expect(safeParseApp({ name: "web", build: { dockerfile: "\0Dockerfile" } }).success).toBe(
      false,
    );
    expect(safeParseApp({ name: "web", build: { args: { "": "x" } } }).success).toBe(false);
    expect(safeParseApp({ name: "web", build: { args: { KEY: "a\0b" } } }).success).toBe(false);
  });
});

describe("resolveBuildDockerfile", () => {
  it("resolves and reads a regular Dockerfile inside the app directory", async () => {
    const { appDir } = await fixture();
    await writeFile(path.join(appDir, "Dockerfile"), FROM_BASE, "utf8");

    const resolved = resolveBuildDockerfile({ appDir, dockerfile: "Dockerfile" });
    expect(resolved.path).toBe(path.join(appDir, "Dockerfile"));
    expect(resolved.content.toString("utf8")).toBe(FROM_BASE);
  });

  it("rejects a missing Dockerfile", async () => {
    const { appDir } = await fixture();
    expectConfigError(
      () => resolveBuildDockerfile({ appDir, dockerfile: "Dockerfile" }),
      "NOT_FOUND",
    );
  });

  it("rejects a directory instead of a regular file", async () => {
    const { appDir } = await fixture();
    await mkdir(path.join(appDir, "Dockerfile"));
    expectConfigError(
      () => resolveBuildDockerfile({ appDir, dockerfile: "Dockerfile" }),
      "VALIDATION_FAILED",
    );
  });

  it("rejects absolute and parent-escaping paths", async () => {
    const { appDir } = await fixture();
    for (const dockerfile of ["/etc/passwd", "../Dockerfile", "sub/../../Dockerfile"]) {
      expectConfigError(() => resolveBuildDockerfile({ appDir, dockerfile }), "INVALID_APP_PATH");
    }
  });

  it("rejects a symlinked Dockerfile whose real target is outside the app", async () => {
    const { appDir, outside } = await fixture();
    const target = path.join(outside, "Dockerfile");
    await writeFile(target, "FROM scratch\n", "utf8");
    await symlink(target, path.join(appDir, "Dockerfile"));

    expectConfigError(
      () => resolveBuildDockerfile({ appDir, dockerfile: "Dockerfile" }),
      "PATH_OUTSIDE_ROOT",
    );
  });

  it("rejects a symlinked directory that escapes the app", async () => {
    const { appDir, outside } = await fixture();
    await writeFile(path.join(outside, "Dockerfile"), "FROM scratch\n", "utf8");
    await symlink(outside, path.join(appDir, "linked"));

    expectConfigError(
      () => resolveBuildDockerfile({ appDir, dockerfile: "linked/Dockerfile" }),
      "PATH_OUTSIDE_ROOT",
    );
  });

  it("rejects a dangling symlink", async () => {
    const { appDir, outside } = await fixture();
    await symlink(path.join(outside, "missing"), path.join(appDir, "Dockerfile"));

    expectConfigError(
      () => resolveBuildDockerfile({ appDir, dockerfile: "Dockerfile" }),
      "NOT_FOUND",
    );
  });
});
