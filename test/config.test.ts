import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadAppConfig, loadProjectConfig } from "../src/config/load.js";
import {
  DEFAULT_BUILD_NETWORK,
  loadHostMountsRoot,
  loadRunnerConfig,
  loadRunnerEnvironment,
} from "../src/runner/validate.js";
import {
  MIN_RUNNER_API_VERSION,
  NAME_VERSION,
  RECORD_VERSION,
  RUNNER_API_VERSION,
} from "../src/runner/versions.js";

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

function runnerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HANSE_RUNTIME_TOKEN: "runtime-token",
    HANSE_HOST_WORKSPACE: path.join(tmpdir(), "hanse-config-workspace"),
    HANSE_HOST_AGENTS: path.join(tmpdir(), "hanse-config-agents"),
    HANSE_AGENT_IMAGE: "agent-default:test",
    ...overrides,
  };
}

function expectConfigError(fn: () => unknown): void {
  expect(fn).toThrow(ConfigError);
}

describe("runner isolation environment", () => {
  it("uses the documented defaults when the optional keys are unset", () => {
    const config = loadRunnerConfig(runnerEnv());
    expect(config.buildNetwork).toBe(DEFAULT_BUILD_NETWORK);
    expect(config.hostMounts).toBeUndefined();
    expect(config.dockerDataRoot).toBeUndefined();
    expect(config.buildProxy).toBeUndefined();
    expect(config.buildAllowedImages).toBeUndefined();
    expect(config.appMemoryMaxMb).toBeUndefined();
    expect(config.appCpusMax).toBeUndefined();
    expect(config.appPidsMax).toBeUndefined();
    expect(config.pullMaxBytes).toBeUndefined();
    expect(config.buildRecordsDir).toBeUndefined();
  });

  it("parses and validates every new optional key", () => {
    const mounts = path.join(tmpdir(), "hanse-config-mounts");
    const dataRoot = path.join(tmpdir(), "hanse-config-docker");
    const records = path.join(tmpdir(), "hanse-config-records");
    const config = loadRunnerConfig(
      runnerEnv({
        HANSE_HOST_MOUNTS: mounts,
        HANSE_DOCKER_DATA_ROOT: dataRoot,
        HANSE_BUILD_NETWORK: "none",
        HANSE_BUILD_PROXY: "http://proxy.local:3128",
        HANSE_BUILD_ALLOWED_IMAGES: "ghcr.io/acme/base:1, agent-default:test",
        HANSE_APP_MEMORY_MAX_MB: "4096",
        HANSE_APP_CPUS_MAX: "2.5",
        HANSE_APP_PIDS_MAX: "1000",
        HANSE_PULL_MAX_BYTES: "1048576",
        HANSE_BUILD_RECORDS_DIR: records,
      }),
    );
    expect(config.hostMounts).toBe(mounts);
    expect(config.dockerDataRoot).toBe(dataRoot);
    expect(config.buildNetwork).toBe("none");
    expect(config.buildProxy).toBe("http://proxy.local:3128");
    expect(config.buildAllowedImages).toEqual(
      new Set(["ghcr.io/acme/base:1", "agent-default:test"]),
    );
    expect(config.appMemoryMaxMb).toBe(4096);
    expect(config.appCpusMax).toBe(2.5);
    expect(config.appPidsMax).toBe(1000);
    expect(config.pullMaxBytes).toBe(1048576);
    expect(config.buildRecordsDir).toBe(records);
  });

  it("rejects relative and overlapping paths", () => {
    expectConfigError(() => loadRunnerConfig(runnerEnv({ HANSE_HOST_MOUNTS: "relative/mounts" })));
    expectConfigError(() =>
      loadRunnerConfig(
        runnerEnv({
          HANSE_HOST_MOUNTS: path.join(tmpdir(), "hanse-config-workspace", "mounts"),
        }),
      ),
    );
    expectConfigError(() =>
      loadRunnerConfig(
        runnerEnv({
          HANSE_HOST_MOUNTS: path.dirname(path.join(tmpdir(), "hanse-config-agents")),
        }),
      ),
    );
    expectConfigError(() =>
      loadRunnerConfig(runnerEnv({ HANSE_DOCKER_DATA_ROOT: "relative/docker" })),
    );
    expectConfigError(() =>
      loadRunnerConfig(runnerEnv({ HANSE_BUILD_RECORDS_DIR: "relative/records" })),
    );
  });

  it("rejects invalid network, proxy, image, and numeric values", () => {
    expectConfigError(() => loadRunnerConfig(runnerEnv({ HANSE_BUILD_NETWORK: "bad network" })));
    expectConfigError(() => loadRunnerConfig(runnerEnv({ HANSE_BUILD_PROXY: "proxy.local:3128" })));
    expectConfigError(() =>
      loadRunnerConfig(runnerEnv({ HANSE_BUILD_PROXY: "socks5://proxy.local:1080" })),
    );
    expectConfigError(() =>
      loadRunnerConfig(runnerEnv({ HANSE_BUILD_ALLOWED_IMAGES: "bad image" })),
    );
    expectConfigError(() => loadRunnerConfig(runnerEnv({ HANSE_BUILD_ALLOWED_IMAGES: "," })));
    expectConfigError(() => loadRunnerConfig(runnerEnv({ HANSE_APP_MEMORY_MAX_MB: "1.5" })));
    expectConfigError(() => loadRunnerConfig(runnerEnv({ HANSE_APP_MEMORY_MAX_MB: "0" })));
    expectConfigError(() => loadRunnerConfig(runnerEnv({ HANSE_APP_CPUS_MAX: "Infinity" })));
    expectConfigError(() => loadRunnerConfig(runnerEnv({ HANSE_APP_PIDS_MAX: "-1" })));
    expectConfigError(() => loadRunnerConfig(runnerEnv({ HANSE_PULL_MAX_BYTES: "0" })));
  });

  it("validates host mounts without requiring the runner host roots", () => {
    const mounts = path.join(tmpdir(), "hanse-config-mounts");
    expect(loadRunnerEnvironment({ HANSE_HOST_MOUNTS: mounts }, {}).hostMounts).toBe(mounts);
    expectConfigError(() => loadRunnerEnvironment({ HANSE_HOST_MOUNTS: "relative" }, {}));
  });

  it("loads the shared mounts root and rejects overlap with workspace or agents", () => {
    const mounts = path.join(tmpdir(), "hanse-config-mounts-shared");
    const workspace = path.join(tmpdir(), "hanse-config-workspace-shared");
    const agents = path.join(tmpdir(), "hanse-config-agents-shared");
    expect(loadHostMountsRoot({ HANSE_HOST_MOUNTS: mounts }, { workspace, agents })).toBe(mounts);
    expect(loadHostMountsRoot({}, { workspace, agents })).toBeUndefined();
    expectConfigError(() =>
      loadHostMountsRoot(
        { HANSE_HOST_MOUNTS: path.join(workspace, "mounts") },
        { workspace, agents },
      ),
    );
    expectConfigError(() =>
      loadHostMountsRoot({ HANSE_HOST_MOUNTS: path.dirname(agents) }, { workspace, agents }),
    );
  });
});

describe("runner isolation versions", () => {
  it("exports the staged protocol versions", () => {
    expect(RUNNER_API_VERSION).toBe(3);
    expect(MIN_RUNNER_API_VERSION).toBe(3);
    expect(NAME_VERSION).toBe(2);
    expect(RECORD_VERSION).toBe(1);
  });
});
