import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DockerBuildOptions,
  type DockerBuildResult,
  type DockerBuildRuntime,
  DockerClient,
  type DockerContainerCreateOptions,
  type DockerContainerWait,
  type DockerImageInspect,
  type DockerLogs,
  type DockerRequestOptions,
  type DockerResponse,
  type DockerTransport,
} from "../src/runner/docker.js";
import {
  IMAGE_VALIDATION_MEMORY_BYTES,
  IMAGE_VALIDATION_NANO_CPUS,
  IMAGE_VALIDATION_PIDS_LIMIT,
  IMAGE_VALIDATION_SCRIPT,
  IMAGE_VALIDATION_TIMEOUT_MS,
  type ImageValidationRuntime,
  ImageValidationService,
  MAX_IMAGE_VALIDATION_LOG_BYTES,
} from "../src/runner/image-validation.js";
import {
  type ImageBuildResult,
  ImageBuildService,
  type RunnerImageRecord,
} from "../src/runner/images.js";
import type { RunnerConfig } from "../src/runner/validate.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeValidationRuntime implements ImageValidationRuntime {
  image: DockerImageInspect | undefined = { Id: "sha256:image", Config: {} };
  inspectError: unknown;
  createError: unknown;
  startError: unknown;
  waitError: unknown;
  logsError: unknown;
  waitResult: DockerContainerWait = { StatusCode: 0 };
  logText = "hanse image validation passed\n";
  readonly inspected: string[] = [];
  readonly creates: DockerContainerCreateOptions[] = [];
  readonly waits: number[] = [];
  readonly removed: string[] = [];
  #next = 1;

  async inspectImage(reference: string): Promise<DockerImageInspect | undefined> {
    this.inspected.push(reference);
    if (this.inspectError !== undefined) throw this.inspectError;
    return this.image;
  }

  async createContainer(options: DockerContainerCreateOptions): Promise<string> {
    this.creates.push(options);
    if (this.createError !== undefined) throw this.createError;
    return `validation-${this.#next++}`;
  }

  async startContainer(id: string): Promise<void> {
    if (this.startError !== undefined) throw this.startError;
    if (!id.startsWith("validation-")) throw new Error(`unexpected container ${id}`);
  }

  async waitContainer(id: string, timeoutMs?: number): Promise<DockerContainerWait> {
    this.waits.push(timeoutMs ?? -1);
    if (this.waitError !== undefined) throw this.waitError;
    if (!id.startsWith("validation-")) throw new Error(`unexpected container ${id}`);
    return this.waitResult;
  }

  async logs(id: string, tail?: number): Promise<DockerLogs> {
    if (this.logsError !== undefined) throw this.logsError;
    if (!id.startsWith("validation-")) throw new Error(`unexpected container ${id}`);
    expect(tail).toBeGreaterThan(0);
    return { logs: this.logText, truncated: false };
  }

  async removeContainer(id: string, force?: boolean): Promise<void> {
    expect(force).toBe(true);
    this.removed.push(id);
  }
}

describe("ImageValidationService", () => {
  it("accepts a compatible image and runs a locked-down one-shot sandbox", async () => {
    const runtime = new FakeValidationRuntime();
    runtime.image = {
      Id: "sha256:image",
      Config: {
        User: "0:0",
        Entrypoint: ["/bin/bash"],
        Cmd: ["--login"],
        Labels: { "org.opencontainers.image.title": "app" },
      },
    };
    const service = new ImageValidationService({ runtime });

    const result = await service.validate("hanse-app-project-app:build", "project:app");

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.logs).toContain("hanse image validation passed");
    expect(runtime.inspected).toEqual(["hanse-app-project-app:build"]);
    expect(runtime.creates).toHaveLength(1);

    const options = runtime.creates[0];
    if (options === undefined) throw new Error("missing validation container options");
    expect(options.image).toBe("hanse-app-project-app:build");
    expect(options.name).toMatch(/^hanse-validate-project-app-[0-9a-f]{8}$/);
    expect(options.user).toBe("1000:1000");
    expect(options.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(options.cmd).toEqual([IMAGE_VALIDATION_SCRIPT]);
    expect(options.workingDir).toBe("/tmp");
    expect(options.binds).toEqual([]);
    expect(options.networkMode).toBe("none");
    expect(options.networkName).toBe("none");
    expect(options.networkAliases).toEqual([]);
    expect(options.restartPolicy).toBe("no");
    expect(options.memoryBytes).toBe(IMAGE_VALIDATION_MEMORY_BYTES);
    expect(options.nanoCpus).toBe(IMAGE_VALIDATION_NANO_CPUS);
    expect(options.pidsLimit).toBe(IMAGE_VALIDATION_PIDS_LIMIT);
    expect(Object.keys(options.tmpfs).sort()).toEqual(["/run", "/tmp"]);
    expect(options.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp/hanse-validation-home",
      TMPDIR: "/tmp",
      XDG_CACHE_HOME: "/tmp/hanse-validation-cache",
      LC_ALL: "C",
      LANG: "C",
    });
    expect(JSON.stringify(options.env)).not.toMatch(/password|token|secret|opencode/i);
    expect(options.labels).toEqual({
      "hanse.validation": "true",
      "hanse.app.id": "project:app",
    });
    expect(runtime.waits).toEqual([IMAGE_VALIDATION_TIMEOUT_MS]);
    expect(runtime.removed).toEqual(["validation-1"]);
  });

  it("rejects an image that declares volumes before creating a container", async () => {
    const runtime = new FakeValidationRuntime();
    runtime.image = {
      Id: "sha256:image",
      Config: { Volumes: { "/data": {}, "/cache": {} } },
    };

    const result = await new ImageValidationService({ runtime }).validate("bad:image");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("VOLUME");
    expect(result.error).toContain("/data");
    expect(runtime.creates).toHaveLength(0);
    expect(runtime.removed).toEqual([]);
  });

  it("fails closed when the image cannot be inspected", async () => {
    const runtime = new FakeValidationRuntime();
    runtime.inspectError = new Error("no such image");

    const result = await new ImageValidationService({ runtime }).validate("missing:image");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no such image");
    expect(runtime.creates).toHaveLength(0);
  });

  it("reports a missing binary from the validation output", async () => {
    const runtime = new FakeValidationRuntime();
    runtime.waitResult = { StatusCode: 1 };
    runtime.logText = "incompatible image: missing or broken git\n";

    const result = await new ImageValidationService({ runtime }).validate(
      "bad:image",
      "project:app",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited with code 1");
    expect(result.error).toContain("missing or broken git");
    expect(result.logs).toContain("missing or broken git");
    expect(runtime.removed).toEqual(["validation-1"]);
  });

  it("requires the probe marker so a silent exit cannot pass validation", async () => {
    const runtime = new FakeValidationRuntime();
    runtime.logText = "nothing happened\n";

    const result = await new ImageValidationService({ runtime }).validate("suspect:image");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not complete all checks");
    expect(runtime.removed).toEqual(["validation-1"]);
  });

  it("bounds validation output and keeps the failure detail", async () => {
    const runtime = new FakeValidationRuntime();
    runtime.waitResult = { StatusCode: 1 };
    runtime.logText = `${"A".repeat(MAX_IMAGE_VALIDATION_LOG_BYTES + 500)}missing git\n`;

    const result = await new ImageValidationService({ runtime }).validate("bad:image");

    expect(result.ok).toBe(false);
    expect(Buffer.byteLength(result.logs)).toBeLessThanOrEqual(MAX_IMAGE_VALIDATION_LOG_BYTES + 20);
    expect(result.logs.startsWith("[logs truncated]\n")).toBe(true);
    expect(result.error).toContain("missing git");
    expect(result.error?.length).toBeLessThanOrEqual(1000);
    expect(
      Array.from(result.error ?? "").some((character) => (character.codePointAt(0) ?? 0) < 0x20),
    ).toBe(false);
  });

  it("times out through the wait call and still removes the sandbox", async () => {
    const runtime = new FakeValidationRuntime();
    runtime.waitError = new Error("docker request timed out");

    const result = await new ImageValidationService({ runtime, timeoutMs: 1234 }).validate(
      "slow:image",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out after 1234ms");
    expect(runtime.waits).toEqual([1234]);
    expect(runtime.removed).toEqual(["validation-1"]);
  });

  it("sends the fixed read-only, no-capability, no-network Docker envelope", async () => {
    const transport = new ValidationTransport();
    const result = await new ImageValidationService({
      runtime: new DockerClient(transport),
    }).validate("hanse-app-project-app:build", "project:app");

    expect(result.ok).toBe(true);
    const body = transport.createBody as
      | {
          User?: string;
          Entrypoint?: string[];
          Cmd?: string[];
          Env?: string[];
          NetworkingConfig?: unknown;
          HostConfig?: Record<string, unknown>;
        }
      | undefined;
    if (body === undefined) throw new Error("missing create request body");
    expect(body.User).toBe("1000:1000");
    expect(body.Entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(body.Cmd).toEqual([IMAGE_VALIDATION_SCRIPT]);
    expect(body.NetworkingConfig).toBeUndefined();
    expect(body.Env).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/PASSWORD|TOKEN|SECRET/i)]),
    );
    expect(body.HostConfig).toMatchObject({
      Binds: [],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Memory: IMAGE_VALIDATION_MEMORY_BYTES,
      NanoCpus: IMAGE_VALIDATION_NANO_CPUS,
      PidsLimit: IMAGE_VALIDATION_PIDS_LIMIT,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    });
    expect(Object.keys((body.HostConfig?.Tmpfs ?? {}) as Record<string, string>).sort()).toEqual([
      "/run",
      "/tmp",
    ]);
    expect(
      transport.requests.some((request) => request.path.includes("/containers/validation-1/logs")),
    ).toBe(true);
    expect(transport.requests.some((request) => request.method === "DELETE")).toBe(true);
  });
});

class ValidationTransport implements DockerTransport {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  createBody: unknown;

  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    _options?: DockerRequestOptions,
  ): Promise<DockerResponse> {
    this.requests.push({ method, path, body });
    if (path.startsWith("/images/")) {
      return json(200, { Id: "sha256:image", Config: {} });
    }
    if (path.startsWith("/containers/create")) {
      this.createBody = body;
      return json(201, { Id: "validation-1" });
    }
    if (path.endsWith("/start")) {
      return empty(204);
    }
    if (path.includes("/wait")) {
      return json(200, { StatusCode: 0 });
    }
    if (path.includes("/logs")) {
      return {
        status: 200,
        body: Buffer.from("hanse image validation passed\n", "utf8"),
      };
    }
    if (method === "DELETE") {
      return empty(204);
    }
    return json(500, { message: `unexpected request ${method} ${path}` });
  }
}

function json(status: number, body: unknown): DockerResponse {
  return { status, body: Buffer.from(JSON.stringify(body), "utf8") };
}

function empty(status: number): DockerResponse {
  return { status, body: Buffer.alloc(0) };
}

class FakeBuildRuntime implements DockerBuildRuntime {
  #next = 1;

  async buildImage(_options: DockerBuildOptions): Promise<DockerBuildResult> {
    const imageId = `sha256:build-${this.#next++}`;
    return { imageId, logs: "Successfully built\n", error: null };
  }
}

interface IntegrationFixture {
  readonly workspace: string;
  readonly appDir: string;
  readonly config: RunnerConfig;
}

function integrationFixture(): IntegrationFixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-image-validation-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const appDir = path.join(workspace, "project", "app");
  mkdirSync(path.join(appDir, ".hanse"), { recursive: true });
  writeFileSync(path.join(appDir, ".hanse", "Dockerfile"), `ARG HANSE_BASE\nFROM \${HANSE_BASE}\n`);
  return {
    workspace,
    appDir,
    config: {
      token: "runtime-token",
      hostWorkspace: workspace,
      hostAgents: path.join(base, "agents"),
      allowedImages: new Set(["agent-default:test"]),
      defaultImage: "agent-default:test",
      coordinatorContainer: "hanse",
      dockerSocket: "/var/run/docker.sock",
      dockerApiVersion: "v1.41",
    },
  };
}

async function waitForImage(
  service: ImageBuildService,
  appId: string,
  predicate: (record: RunnerImageRecord) => boolean,
): Promise<RunnerImageRecord> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const record = service.get(appId);
    if (predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for image record");
}

describe("ImageBuildService validation gate", () => {
  it("marks a rebuild error and keeps the previous image when validation fails", async () => {
    const fixture = integrationFixture();
    const runtime = new FakeValidationRuntime();
    const service = new ImageBuildService({
      config: fixture.config,
      build: new FakeBuildRuntime(),
      validation: runtime,
    });
    const body = {
      appId: "project:app",
      appDir: fixture.appDir,
      baseImage: "agent-default:test",
    };

    const first = (await service.start(body)) as ImageBuildResult;
    const ready = await waitForImage(service, "project:app", (record) => record.status === "ready");
    expect(ready.buildId).toBe(first.buildId);
    expect(ready.imageRef).toBe(`hanse-app-project-app:${first.buildId}`);
    expect(ready.imageId).toBe("sha256:build-1");
    expect(ready.logs).toContain("hanse image validation passed");
    expect(runtime.creates).toHaveLength(1);

    runtime.waitResult = { StatusCode: 1 };
    runtime.logText = "incompatible image: missing opencode\n";
    const second = await service.start(body);
    const failed = await waitForImage(
      service,
      "project:app",
      (record) => record.status === "error",
    );

    expect(failed.buildId).toBe(second.buildId);
    expect(failed.imageRef).toBe(ready.imageRef);
    expect(failed.imageId).toBe("sha256:build-1");
    expect(failed.error).toContain("missing opencode");
    expect(failed.logs).toContain("missing opencode");
    expect(runtime.creates).toHaveLength(2);
    expect(runtime.creates.every((options) => options.binds.length === 0)).toBe(true);
    expect(runtime.removed).toEqual(["validation-1", "validation-2"]);
  });
});
