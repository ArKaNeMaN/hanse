// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Dockerfile variable syntax is intentional
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, type ConfigErrorCode } from "../src/config/load.js";
import type {
  DockerBuildOptions,
  DockerBuildResult,
  DockerBuildRuntime,
  DockerNetworkInspect,
  DockerNetworkSpec,
} from "../src/runner/docker.js";
import { ImageBuildService } from "../src/runner/images.js";
import type { RunnerConfig } from "../src/runner/validate.js";
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

class FakeImageBuild implements DockerBuildRuntime {
  readonly calls: DockerBuildOptions[] = [];

  async buildImage(options: DockerBuildOptions): Promise<DockerBuildResult> {
    this.calls.push(options);
    return { imageId: "sha256:built", logs: "", error: null };
  }
}

function runnerConfig(base: string, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    token: "runtime-token",
    hostWorkspace: base,
    hostAgents: path.join(base, "agents"),
    allowedImages: new Set(["ghcr.io/example/hanse-agent-default:1"]),
    defaultImage: "ghcr.io/example/hanse-agent-default:1",
    coordinatorContainer: "hanse",
    dockerSocket: "/var/run/docker.sock",
    dockerApiVersion: "v1.41",
    buildNetwork: "hanse-build",
    hostRunnerTmp: path.join(base, "tmp"),
    ...overrides,
  };
}

async function appWithDockerfile(content: string): Promise<{
  base: string;
  appDir: string;
}> {
  const { base, appDir } = await fixture();
  await mkdir(path.join(appDir, ".hanse"), { recursive: true });
  await writeFile(path.join(appDir, ".hanse", "Dockerfile"), content, "utf8");
  return { base, appDir };
}

function buildBody(appDir: string): Record<string, unknown> {
  return {
    appId: "web",
    appDir,
    baseImage: "ghcr.io/example/hanse-agent-default:1",
  };
}

describe("ImageBuildService FROM allowlist", () => {
  it("starts a build for an allowlisted literal FROM", async () => {
    const { base, appDir } = await appWithDockerfile("FROM node:20\n");
    const service = new ImageBuildService({
      config: runnerConfig(base, { allowedImages: new Set(["node:20"]) }),
      build: new FakeImageBuild(),
    });

    await expect(service.start(buildBody(appDir))).resolves.toMatchObject({
      appId: "web",
      status: "building",
    });
  });

  it("rejects a disallowed literal FROM with invalid_from", async () => {
    const { base, appDir } = await appWithDockerfile("FROM evil:1\n");
    const service = new ImageBuildService({
      config: runnerConfig(base),
      build: new FakeImageBuild(),
    });

    await expect(service.start(buildBody(appDir))).rejects.toMatchObject({
      status: 400,
      code: "invalid_from",
    });
  });

  it("does not implicitly allow the final literal FROM", async () => {
    const { base, appDir } = await appWithDockerfile("FROM node:20\n");
    const service = new ImageBuildService({
      config: runnerConfig(base),
      build: new FakeImageBuild(),
    });

    await expect(service.start(buildBody(appDir))).rejects.toMatchObject({
      status: 400,
      code: "invalid_from",
    });
  });

  it("unions HANSE_BUILD_ALLOWED_IMAGES with allowedImages", async () => {
    const { base, appDir } = await appWithDockerfile(
      ["FROM extra:1 AS build", "FROM node:20", ""].join("\n"),
    );
    const service = new ImageBuildService({
      config: runnerConfig(base, {
        allowedImages: new Set(["node:20"]),
        buildAllowedImages: new Set(["extra:1"]),
      }),
      build: new FakeImageBuild(),
    });

    await expect(service.start(buildBody(appDir))).resolves.toMatchObject({
      status: "building",
    });
  });

  it("rejects an external image that is in neither allowlist", async () => {
    const { base, appDir } = await appWithDockerfile(
      ["FROM extra:1 AS build", "FROM node:20", ""].join("\n"),
    );
    const service = new ImageBuildService({
      config: runnerConfig(base, {
        allowedImages: new Set(["node:20"]),
        buildAllowedImages: new Set(["other:1"]),
      }),
      build: new FakeImageBuild(),
    });

    await expect(service.start(buildBody(appDir))).rejects.toMatchObject({
      status: 400,
      code: "invalid_from",
    });
  });
});

describe("ImageBuildService build network", () => {
  it("fails closed when the build network exists with foreign labels", async () => {
    const { base, appDir } = await appWithDockerfile("FROM ${HANSE_BASE}\n");
    const service = new ImageBuildService({
      config: runnerConfig(base),
      build: new FakeImageBuild(),
      network: {
        async ensureNetwork(_spec: DockerNetworkSpec): Promise<void> {},
        async inspectNetwork(name: string): Promise<DockerNetworkInspect> {
          return { Name: name, Labels: { "hanse.managed": "true", "hanse.app.id": "web" } };
        },
      },
    });

    await expect(service.start(buildBody(appDir))).rejects.toMatchObject({
      status: 503,
      code: "build_network_unavailable",
    });
  });

  it("creates a missing build network with the managed build labels", async () => {
    const { base, appDir } = await appWithDockerfile("FROM ${HANSE_BASE}\n");
    const created: DockerNetworkSpec[] = [];
    let exists = false;
    const service = new ImageBuildService({
      config: runnerConfig(base),
      build: new FakeImageBuild(),
      network: {
        async ensureNetwork(spec: DockerNetworkSpec): Promise<void> {
          created.push(spec);
          exists = true;
        },
        async inspectNetwork(name: string): Promise<DockerNetworkInspect | undefined> {
          return exists
            ? { Name: name, Labels: { "hanse.managed": "true", "hanse.role": "build" } }
            : undefined;
        },
      },
    });

    await expect(service.start(buildBody(appDir))).resolves.toMatchObject({
      status: "building",
    });
    expect(created).toEqual([
      {
        name: "hanse-build",
        labels: { "hanse.managed": "true", "hanse.role": "build" },
      },
    ]);
  });
});
