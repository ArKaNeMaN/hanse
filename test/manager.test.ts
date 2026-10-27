import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stoppedStatus } from "../src/agent/protocol.js";
import { computeSpecHash } from "../src/agent/spec.js";
import { DeploymentInProgressError, DeploymentLock } from "../src/coordinator/deployment-lock.js";
import { LifecycleActivity } from "../src/coordinator/lifecycle-activity.js";
import {
  DefaultImageUnavailableError,
  ImageNotReadyError,
  type ImageStateView,
} from "../src/images/service.js";
import type { Logger } from "../src/logging/logger.js";
import { mintAgentToken, verifyAgentToken } from "../src/mcp/agent-tokens.js";
import type {
  ContextMonitorLike,
  ContextMonitorOptions,
  ContextPolicy,
  ContextSnapshot,
} from "../src/opencode/context.js";
import { authorizationFor, setEndpointAuthorization } from "../src/opencode/endpoint-auth.js";
import {
  AgentTokenReconcileError,
  DeletionPendingError,
  ImageRollbackIncompleteError,
  ImageRollbackRestoreError,
  type InstanceImageSource,
  InstanceManager,
  type ManagedApp,
  type OmoProfileSource,
  RestartInProgressError,
  type SettingsSource,
  settingsHashFor,
  verifyAgentModels,
} from "../src/opencode/manager.js";
import type { OmoProfileInput, OmoProfileResult } from "../src/opencode/omo-profile.js";
import {
  ATTACHMENTS_POLICY_VERSION,
  credentialDenyPatterns,
  type VerifyPolicyOptions,
} from "../src/opencode/policy.js";
import type { PreviewCleanup } from "../src/preview/types.js";
import { hashValue } from "../src/settings/hash.js";
import type {
  EffectiveSettings,
  EffectiveValue,
  LaunchSettingsSnapshot,
} from "../src/settings/types.js";
import {
  type ResolvedSkills,
  type SkillApplyOptions,
  type SkillMaterializeResult,
  SkillService,
  type SkillSource,
  type SkillTarget,
  type SkillWarning,
} from "../src/skills/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import type { WebToolConfig } from "../src/web/types.js";
import { FakeAgentRuntime } from "./fixtures/fake-runtime.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const APP: ManagedApp = {
  id: "p:web",
  projectId: "p",
  appKey: "web",
  appDir: "/srv/apps/web",
};

function value<T>(item: T): EffectiveValue<T> {
  return { value: item, state: "set", source: "global", sources: ["global"] };
}

interface FakeSettings extends SettingsSource {
  setModel(model: string): void;
  setSearch(search: WebToolConfig | null): void;
  setGitAuthHash(hash: string): void;
  setContext(enabled: boolean, percent: number): void;
}

function fakeSettings(
  options: {
    model?: string;
    search?: WebToolConfig | null;
    gitAuth?: LaunchSettingsSnapshot["gitAuth"];
    gitAuthHash?: string;
    gitIdentity?: { name?: string | null; email?: string | null };
    context?: { enabled?: boolean; percent?: number };
  } = {},
): FakeSettings {
  let model = options.model ?? "deepseek/deepseek-flash";
  let search: WebToolConfig | null = options.search ?? { driver: "builtin" };
  const gitAuth = options.gitAuth ?? {};
  let gitAuthHash = options.gitAuthHash ?? "git-auth-hash";
  let contextEnabled = options.context?.enabled ?? false;
  let contextPercent = options.context?.percent ?? 80;
  const settings: FakeSettings = {
    setModel(next) {
      model = next;
    },
    setSearch(next) {
      search = next;
    },
    setGitAuthHash(next) {
      gitAuthHash = next;
    },
    setContext(nextEnabled, nextPercent) {
      contextEnabled = nextEnabled;
      contextPercent = nextPercent;
    },
    snapshot: (_target): LaunchSettingsSnapshot => {
      const effective: EffectiveSettings = {
        llm: { model: value(model) },
        web: { search: value(search), fetch: value({ driver: "builtin" }) },
        context: {
          autoCompact: { enabled: value(contextEnabled), percent: value(contextPercent) },
        },
        git: {
          user: {
            name: value(options.gitIdentity?.name ?? null),
            email: value(options.gitIdentity?.email ?? null),
          },
        },
      };
      return {
        resolved: {
          effective,
          scoped: {},
          providerKeys: {},
          gitAuth: {
            ssh: { state: "missing", kind: "ssh" },
            https: { state: "missing", kind: "https" },
          },
          gitAuthScoped: {
            ssh: { global: "absent", project: "absent", app: "absent" },
            https: { global: "absent", project: "absent", app: "absent" },
          },
          warnings: [],
        },
        mergedAuth: { deepseek: { type: "api", key: "sk-test" } },
        authHash: "auth-hash",
        providerKeys: new Map(),
        gitAuth,
        gitAuthHash,
      };
    },
  };
  if (options.context !== undefined) {
    settings.contextPolicy = (): ContextPolicy => ({
      enabled: contextEnabled,
      percent: contextPercent,
      model,
      enabledSource: "global",
      percentSource: "global",
    });
  }
  return settings;
}

interface FakeProfiles {
  source: OmoProfileSource;
  ensures: OmoProfileInput[];
  writePaths: (string | undefined)[];
  previews: OmoProfileInput[];
}

function fakeProfiles(
  options: { applied?: boolean; warning?: string; contentHash?: string } = {},
): FakeProfiles {
  const ensures: OmoProfileInput[] = [];
  const writePaths: (string | undefined)[] = [];
  const previews: OmoProfileInput[] = [];
  const applied = options.applied ?? true;
  const contentHash = options.contentHash ?? "profile-hash";
  const result = (): OmoProfileResult => ({
    name: "hanse-app-test",
    applied,
    contentHash,
    ...(options.warning === undefined ? {} : { warning: options.warning }),
  });
  return {
    ensures,
    writePaths,
    previews,
    source: {
      ensure: async (input, writePath) => {
        ensures.push(input);
        writePaths.push(writePath);
        return result();
      },
      preview: (input) => {
        previews.push(input);
        return result();
      },
    },
  };
}

interface FakeSkills {
  source: SkillSource;
  probes: Array<{ target: SkillTarget; xdgConfigHome: string; options: SkillApplyOptions }>;
  applies: Array<{ target: SkillTarget; xdgConfigHome: string; options: SkillApplyOptions }>;
  hashes: SkillTarget[];
  setHash(hash: string | undefined): void;
  setWarnings(warnings: SkillWarning[]): void;
  failProbe?: Error;
  failApply?: Error;
}

function fakeSkills(initialHash: string | undefined = "skills-hash", order?: string[]): FakeSkills {
  let hash = initialHash;
  let warnings: SkillWarning[] = [];
  const probes: FakeSkills["probes"] = [];
  const applies: FakeSkills["applies"] = [];
  const hashes: SkillTarget[] = [];
  const resolved = (target: SkillTarget): ResolvedSkills => ({
    scope:
      target.appKey === undefined ? (target.projectId === undefined ? "global" : "project") : "app",
    effective: [],
    rows: [],
    disabled: [],
    warnings: [],
  });
  const result = (): SkillMaterializeResult => ({
    hash,
    written: [],
    removed: [],
    preserved: [],
    warnings: [...warnings],
  });
  const fake: FakeSkills = {
    probes,
    applies,
    hashes,
    setHash(next) {
      hash = next;
    },
    setWarnings(next) {
      warnings = next;
    },
    source: {
      resolve: (target) => resolved(target),
      preview: (target) => ({ resolved: resolved(target), warnings: [] }),
      hash: (target) => {
        hashes.push(target);
        return hash;
      },
      probe: (target, xdgConfigHome, options) => {
        order?.push("probe");
        probes.push({ target, xdgConfigHome, options });
        if (fake.failProbe !== undefined) throw fake.failProbe;
        return result();
      },
      apply: (target, xdgConfigHome, options) => {
        order?.push("apply");
        applies.push({ target, xdgConfigHome, options });
        if (fake.failApply !== undefined) throw fake.failApply;
        return result();
      },
    },
  };
  return fake;
}

interface Fixture {
  manager: InstanceManager;
  runtime: FakeAgentRuntime;
  db: SqliteDatabase;
  dir: string;
}

function fixture(
  runtime: FakeAgentRuntime = new FakeAgentRuntime(),
  settings?: SettingsSource,
  profiles?: OmoProfileSource,
  modelVerifier?: (endpoint: string, expected: string) => Promise<string[]>,
  verify: (options: VerifyPolicyOptions) => Promise<string[]> = async () => [],
  hostPaths?: { hostWorkspace: string; hostAgents: string; workspaceRoot: string },
  monitorOptions?: {
    monitorFactory?: (options: ContextMonitorOptions) => ContextMonitorLike;
    enableContextMonitors?: boolean;
  },
  skills?: SkillSource | ((db: SqliteDatabase) => SkillSource),
  lifecycle?: { deploymentLock?: DeploymentLock; lifecycleActivity?: LifecycleActivity },
  logger?: Logger,
  previews?: PreviewCleanup,
): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-manager-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:web','p','web','apps/web','AGENTS.md',?)",
  ).run(now);
  const skillsSource = typeof skills === "function" ? skills(db) : skills;
  const manager = new InstanceManager(db, dir, {
    runtime,
    verify,
    settings,
    omoProfiles: profiles,
    modelVerifier,
    workspaceRoot: hostPaths?.workspaceRoot ?? "/srv",
    ...(hostPaths === undefined
      ? {}
      : { hostWorkspace: hostPaths.hostWorkspace, hostAgents: hostPaths.hostAgents }),
    ...monitorOptions,
    ...(skillsSource === undefined ? {} : { skills: skillsSource }),
    ...(lifecycle === undefined ? {} : lifecycle),
    ...(logger === undefined ? {} : { logger }),
    ...(previews === undefined ? {} : { previews }),
  });
  return { manager, runtime, db, dir };
}

function previewFixture(runtime: FakeAgentRuntime, previews: PreviewCleanup): Fixture {
  return fixture(
    runtime,
    fakeSettings(),
    fakeProfiles().source,
    undefined,
    async () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    previews,
  );
}

function instanceState(db: SqliteDatabase): string | undefined {
  const row = db
    .prepare("SELECT COALESCE(runtime_state, state) AS state FROM instances WHERE app_id = 'p:web'")
    .get() as { state: string } | undefined;
  return row?.state;
}

function overlayOf(spec: { env: Record<string, string> }): Record<string, unknown> {
  return JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function markRuntimeStopped(runtime: FakeAgentRuntime, appId: string): void {
  const status = runtime.statuses.get(appId);
  if (status === undefined) throw new Error("missing runtime status");
  runtime.statuses.set(appId, { ...status, state: "stopped", endpoint: null });
}

function imageStateView(overrides: Partial<ImageStateView> = {}): ImageStateView {
  return {
    appId: "p:web",
    appKey: "web",
    status: "ready",
    imageRef: "hanse-app-p:web:build-1",
    imageId: "sha256:one",
    buildId: null,
    hash: null,
    currentHash: null,
    baseDigest: null,
    builtAt: null,
    error: null,
    updatedAt: null,
    previousImageRef: null,
    previousImageBuiltAt: null,
    runnerAvailable: true,
    buildConfigured: true,
    state: "current",
    running: true,
    usableImageRef: "hanse-app-p:web:build-1",
    targetImageId: "sha256:one",
    appliedImageId: "sha256:one",
    hashVersion: 2,
    currentBaseDigest: null,
    baseKind: null,
    baseRef: null,
    baseDrift: null,
    hashDrift: null,
    blocked: false,
    selectedImage: "present",
    imageBuildId: null,
    latestBuildImageId: null,
    ...overrides,
  };
}

class FakeImages implements InstanceImageSource {
  readonly adoptCalls: string[] = [];
  readonly stateCalls: string[] = [];
  readonly order: string[] = [];
  view: ImageStateView;
  onAdopt?: (appId: string) => void;
  onImageState?: (appId: string) => ImageStateView | Promise<ImageStateView>;

  constructor(view: ImageStateView = imageStateView()) {
    this.view = view;
  }

  async adoptBuild(appId: string): Promise<boolean> {
    this.order.push("adopt");
    this.adoptCalls.push(appId);
    this.onAdopt?.(appId);
    return true;
  }

  async imageState(appId: string): Promise<ImageStateView> {
    this.order.push("state");
    this.stateCalls.push(appId);
    if (this.onImageState !== undefined) {
      return this.onImageState(appId);
    }
    return this.view;
  }
}

interface FakeMonitor extends ContextMonitorLike {
  options: ContextMonitorOptions;
  startCount: number;
  stopCount: number;
}

function snapshotStub(sessionID: string): ContextSnapshot {
  return {
    sessionID,
    state: "unknown",
    used: null,
    limit: null,
    percent: null,
    model: null,
    status: "unknown",
    topLevel: false,
    activeChildren: false,
    pendingTask: false,
    updatedAt: new Date(0).toISOString(),
    lastCompactedAt: null,
    lastError: null,
    autoCompact: { enabled: false, percent: 80, source: "default", percentSource: "default" },
  };
}

function fakeMonitorFactory(): {
  monitors: FakeMonitor[];
  factory: (options: ContextMonitorOptions) => ContextMonitorLike;
} {
  const monitors: FakeMonitor[] = [];
  return {
    monitors,
    factory: (options) => {
      const monitor: FakeMonitor = {
        options,
        startCount: 0,
        stopCount: 0,
        start() {
          this.startCount += 1;
        },
        stop() {
          this.stopCount += 1;
        },
        snapshot: async (sessionID) => snapshotStub(sessionID),
        compact: async () => ({ accepted: true }),
      };
      monitors.push(monitor);
      return monitor;
    },
  };
}

describe("InstanceManager lifecycle", () => {
  it("single-flights concurrent ensure calls and builds the runtime spec", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4100");
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, dir } = fixture(runtime, settings, profiles.source);

    const [first, second] = await Promise.all([manager.ensure(APP), manager.ensure(APP)]);

    expect(runtime.ensured).toHaveLength(1);
    expect(first).toBe(second);
    expect(manager.isRunning(APP.id)).toBe(true);
    expect(authorizationFor(first)).toMatch(/^Basic /);

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    expect(spec).toMatchObject({
      appId: "p:web",
      image: process.env.HANSE_AGENT_IMAGE?.trim() || "agent-default",
      pathMode: "container",
      appDir: "/srv/apps/web",
      stateDir: path.join(dir, "p", "web", "state"),
      networkName: "agents",
    });
    expect(spec.port).toBeUndefined();
    expect(spec.resources).toEqual({
      memoryBytes: 2048 * 1024 * 1024,
      nanoCpus: 2_000_000_000,
      pidsLimit: 512,
    });
    expect(spec.labels).toMatchObject({
      "hanse.managed": "true",
      "hanse.app.id": "p:web",
    });
    const { specHash, ...hashable } = spec;
    expect(computeSpecHash(hashable)).toBe(specHash);

    const overlay = overlayOf(spec);
    expect(overlay.model).toBe("deepseek/deepseek-flash");
    expect(spec.env.OMO_PROFILE).toBe("hanse-app-test");
    expect(spec.env.HANSE_OPENCODE_AUTH_FILE).toBe(
      path.join(dir, "p", "web", "data", "opencode", "auth.json"),
    );
    expect(profiles.ensures).toHaveLength(1);
    expect(profiles.writePaths).toEqual([path.join(dir, "p", "web", "home", ".omo", "omo.jsonc")]);
    expect(readFileSync(path.join(dir, "p", "web", "data", "opencode", "auth.json"), "utf8")).toBe(
      JSON.stringify({ deepseek: { type: "api", key: "sk-test" } }),
    );
  });

  it("labels the runtime spec with the per-app host agents root", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "hanse-manager-host-"));
    dirs.push(base);
    const workspace = path.join(base, "workspace");
    const hostAgents = path.join(base, "agents");
    const appDir = path.join(workspace, "apps", "web");
    mkdirSync(appDir, { recursive: true });
    const runtime = new FakeAgentRuntime();
    const f = fixture(runtime, fakeSettings(), fakeProfiles().source, undefined, async () => [], {
      hostWorkspace: workspace,
      hostAgents,
      workspaceRoot: workspace,
    });

    await f.manager.ensure({ ...APP, appDir });

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    expect(spec.pathMode).toBe("host");
    expect(spec.labels["hanse.agents.root"]).toBe(path.join(hostAgents, "p", "web"));
  });

  it("keeps the MCP endpoint and token file inside the config overlay", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);

    await manager.ensure(APP);

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const overlay = overlayOf(spec) as {
      mcp?: { hanse?: { environment?: Record<string, string> } };
    };
    expect(overlay.mcp?.hanse?.environment).toEqual({
      HANSE_MCP_API_BASE: "http://127.0.0.1:8787",
      HANSE_AGENT_TOKEN_FILE: tokenFile,
    });
    for (const key of [
      "HANSE_DB",
      "HANSE_PROJECT_ID",
      "HANSE_APP_KEY",
      "HANSE_OPERATOR_TOKEN",
      "HANSE_RUNTIME_TOKEN",
      "HANSE_DB",
      "HANSE_STATE_HOME",
      "OPENCODE_AUTH_CONTENT",
      "HANSE_AUTH_FILE",
    ]) {
      expect(spec.env[key]).toBeUndefined();
    }
    expect(existsSync(tokenFile)).toBe(true);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenFile, "utf8");
    expect(verifyAgentToken(db, token)).toEqual({
      appId: "p:web",
      projectId: "p",
      appKey: "web",
    });
  });

  it("mints and reuses a 0600 opencode password file", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);

    await manager.ensure(APP);
    const passwordFile = path.join(dir, "p", "web", "state", "opencode-password");
    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    expect(spec.env.HANSE_OPENCODE_PASSWORD_FILE).toBe(passwordFile);
    expect(existsSync(passwordFile)).toBe(true);
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
    const password = readFileSync(passwordFile, "utf8").trim();
    expect(password.length).toBeGreaterThan(0);

    await manager.stopApp(APP.id);
    await manager.ensure(APP);

    expect(readFileSync(passwordFile, "utf8").trim()).toBe(password);
  });

  it("honors HANSE_AGENT_API_BASE for the MCP endpoint", async () => {
    const previous = process.env.HANSE_AGENT_API_BASE;
    process.env.HANSE_AGENT_API_BASE = "http://hanse:8787";
    try {
      const runtime = new FakeAgentRuntime();
      const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source);
      await manager.ensure(APP);
      const spec = runtime.ensured[0];
      if (spec === undefined) throw new Error("missing runtime spec");
      const overlay = overlayOf(spec) as {
        mcp?: { hanse?: { environment?: Record<string, string> } };
      };
      expect(overlay.mcp?.hanse?.environment?.HANSE_MCP_API_BASE).toBe("http://hanse:8787");
    } finally {
      if (previous === undefined) delete process.env.HANSE_AGENT_API_BASE;
      else process.env.HANSE_AGENT_API_BASE = previous;
    }
  });

  it("uses HANSE_APP_* resources from the environment", async () => {
    const previous = {
      memory: process.env.HANSE_APP_MEMORY_MB,
      cpus: process.env.HANSE_APP_CPUS,
      pids: process.env.HANSE_APP_PIDS,
    };
    process.env.HANSE_APP_MEMORY_MB = "1024";
    process.env.HANSE_APP_CPUS = "1.5";
    process.env.HANSE_APP_PIDS = "256";
    try {
      const runtime = new FakeAgentRuntime();
      const { manager } = fixture(runtime);
      await manager.ensure(APP);
      expect(runtime.ensured[0]?.resources).toEqual({
        memoryBytes: 1024 * 1024 * 1024,
        nanoCpus: 1_500_000_000,
        pidsLimit: 256,
      });
    } finally {
      if (previous.memory === undefined) delete process.env.HANSE_APP_MEMORY_MB;
      else process.env.HANSE_APP_MEMORY_MB = previous.memory;
      if (previous.cpus === undefined) delete process.env.HANSE_APP_CPUS;
      else process.env.HANSE_APP_CPUS = previous.cpus;
      if (previous.pids === undefined) delete process.env.HANSE_APP_PIDS;
      else process.env.HANSE_APP_PIDS = previous.pids;
    }
  });

  it("returns an existing running endpoint without re-ensuring", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager } = fixture(runtime, settings, profiles.source);

    const first = await manager.ensure(APP);
    const second = await manager.ensure(APP);

    expect(second).toBe(first);
    expect(runtime.ensured).toHaveLength(1);
    settings.setModel("deepseek/deepseek-pro");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
    await expect(manager.ensure(APP)).resolves.toBe(first);
    expect(runtime.ensured).toHaveLength(1);
  });

  it("re-ensures a container the runtime reports as merely starting", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const first = await manager.ensure(APP);
    const starting = runtime.statuses.get(APP.id);
    if (starting === undefined) throw new Error("missing runtime status");
    runtime.statuses.set(APP.id, { ...starting, state: "starting" });

    await expect(manager.ensure(APP)).resolves.toBe(first);

    expect(runtime.deleted).toContain(APP.id);
    expect(runtime.ensured).toHaveLength(2);
  });

  it("reuses the token file when a new manager starts against the same state", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);

    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const token = readFileSync(tokenFile, "utf8");
    const restarted = new InstanceManager(db, dir, {
      runtime,
      verify: async () => [],
      workspaceRoot: "/srv",
    });
    await expect(restarted.ensure(APP)).resolves.toBe(endpoint);

    expect(runtime.ensured).toHaveLength(1);
    expect(readFileSync(tokenFile, "utf8")).toBe(token);
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(authorizationFor(endpoint)).toMatch(/^Basic /);
  });

  it("probes before teardown and applies after delete before ensure", async () => {
    const order: string[] = [];
    class OrderedRuntime extends FakeAgentRuntime {
      override async ensure(spec: Parameters<FakeAgentRuntime["ensure"]>[0]) {
        order.push("ensure");
        return super.ensure(spec);
      }
      override async delete(appId: string) {
        order.push("delete");
        return super.delete(appId);
      }
    }
    const runtime = new OrderedRuntime();
    const skills = fakeSkills("skills-one", order);
    const { manager } = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    markRuntimeStopped(runtime, APP.id);
    order.length = 0;

    await manager.ensure(APP);

    expect(order).toEqual(["probe", "delete", "apply", "ensure"]);
    expect(skills.probes).toHaveLength(2);
    expect(skills.applies).toHaveLength(2);
  });

  it("does not probe or apply when reconnecting to a running agent", async () => {
    const order: string[] = [];
    const skills = fakeSkills("skills-one", order);
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    order.length = 0;
    skills.probes.length = 0;
    skills.applies.length = 0;

    await manager.ensure(APP);

    expect(order).toEqual([]);
    expect(skills.probes).toHaveLength(0);
    expect(skills.applies).toHaveLength(0);
  });

  it("aborts before teardown when the skills probe fails", async () => {
    const order: string[] = [];
    const skills = fakeSkills("skills-one", order);
    const runtime = new FakeAgentRuntime();
    const { manager } = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    markRuntimeStopped(runtime, APP.id);
    order.length = 0;
    runtime.deleted.length = 0;
    skills.failProbe = new Error("staging write failed");

    await expect(manager.ensure(APP)).rejects.toThrow(
      /^skills_materialize_failed: staging write failed$/,
    );
    expect(order).toEqual(["probe"]);
    expect(runtime.deleted).toEqual([]);
    expect(manager.isRunning(APP.id)).toBe(true);
  });

  it("records error and aborts when apply fails after teardown", async () => {
    const order: string[] = [];
    class OrderedRuntime extends FakeAgentRuntime {
      override async ensure(spec: Parameters<FakeAgentRuntime["ensure"]>[0]) {
        order.push("ensure");
        return super.ensure(spec);
      }
      override async delete(appId: string) {
        order.push("delete");
        return super.delete(appId);
      }
    }
    const skills = fakeSkills("skills-one", order);
    const runtime = new OrderedRuntime();
    const { manager, db } = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    markRuntimeStopped(runtime, APP.id);
    order.length = 0;
    runtime.deleted.length = 0;
    skills.failApply = new Error("live write failed");

    await expect(manager.ensure(APP)).rejects.toThrow(
      /^skills_materialize_failed: live write failed$/,
    );
    expect(order).toEqual(["probe", "delete", "apply"]);
    expect(runtime.deleted).toEqual([APP.id]);
    expect(runtime.ensured).toHaveLength(1);
    expect(manager.isRunning(APP.id)).toBe(false);
    expect(
      db
        .prepare(
          "SELECT state, runtime_state AS runtimeState, endpoint, pid FROM instances WHERE app_id = ?",
        )
        .get(APP.id),
    ).toEqual({ state: "error", runtimeState: "error", endpoint: null, pid: null });
  });

  it("keeps the old launch hash when the skills hash is undefined", () => {
    const settings = fakeSettings();
    const snapshot = settings.snapshot({ projectId: "p", appKey: "web" });
    const preSkillsEffective = {
      llm: { model: value("deepseek/deepseek-flash") },
      web: { search: value({ driver: "builtin" }), fetch: value({ driver: "builtin" }) },
      git: {
        user: { name: value<string | null>(null), email: value<string | null>(null) },
      },
    };
    const expected = hashValue({
      effective: preSkillsEffective,
      providerKeys: {},
      authHash: "auth-hash",
      gitAuthHash: "git-auth-hash",
      profile: "profile-hash",
      policyVersion: ATTACHMENTS_POLICY_VERSION,
    });

    expect(settingsHashFor(snapshot, "profile-hash")).toBe(expected);
    expect(settingsHashFor(snapshot, "profile-hash", undefined)).toBe(expected);
  });

  it("does not mark a zero-skill install restart-required", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const skills = fakeSkills();
    skills.setHash(undefined);
    const { manager, db } = fixture(
      runtime,
      settings,
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    const recorded = db
      .prepare(
        "SELECT applied_settings_hash AS appliedSettingsHash FROM instances WHERE app_id = 'p:web'",
      )
      .get() as { appliedSettingsHash: string | null };

    expect(recorded.appliedSettingsHash).toBe(
      settingsHashFor(settings.snapshot({ projectId: "p", appKey: "web" }), "profile-hash"),
    );
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("marks restart-required when the effective skills hash changes", async () => {
    const skills = fakeSkills("skills-one");
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    skills.setHash("skills-two");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    skills.setHash("skills-one");
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("ignores edits to shadowed and disabled skills when the effective hash is unchanged", async () => {
    let registry: SkillService | undefined;
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      (db) => {
        registry = new SkillService({ db });
        return registry;
      },
    );
    if (registry === undefined) throw new Error("missing skill registry");
    const target = { projectId: "p", appKey: "web" };
    const globalAlpha = registry.create(
      "global",
      {},
      { name: "alpha", description: "global alpha", content: "global alpha body" },
      "test",
    );
    registry.create(
      "app",
      target,
      { name: "alpha", description: "app alpha", content: "app alpha body" },
      "test",
    );
    const globalBeta = registry.create(
      "global",
      {},
      { name: "beta", description: "global beta", content: "global beta body" },
      "test",
    );
    const betaTombstone = registry.override(globalBeta.id, "app", target, false, "test");
    await manager.ensure(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(globalAlpha.id, { content: "edited shadowed body" }, "test");
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(betaTombstone.id, { content: "edited disabled body" }, "test");
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(betaTombstone.id, { enabled: true }, "test");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
  });

  it("marks restart-required for effective metadata and reference edits, not shadowed or tombstone bundle edits", async () => {
    let registry: SkillService | undefined;
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      (db) => {
        registry = new SkillService({ db });
        return registry;
      },
    );
    if (registry === undefined) throw new Error("missing skill registry");
    const target = { projectId: "p", appKey: "web" };
    const globalAlpha = registry.create(
      "global",
      {},
      {
        name: "alpha",
        description: "global alpha",
        content: "global alpha body",
        metadata: { version: "1.0.0" },
        references: [{ path: "references/global.md", content: "global ref" }],
      },
      "test",
    );
    const appAlpha = registry.create(
      "app",
      target,
      { name: "alpha", description: "app alpha", content: "app alpha body" },
      "test",
    );
    const globalBeta = registry.create(
      "global",
      {},
      {
        name: "beta",
        description: "global beta",
        content: "global beta body",
        metadata: { version: "1.0.0" },
        references: [{ path: "references/global.md", content: "global ref" }],
      },
      "test",
    );
    const betaTombstone = registry.override(globalBeta.id, "app", target, false, "test");
    await manager.ensure(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(
      globalAlpha.id,
      {
        metadata: { version: "2.0.0" },
        references: [{ path: "references/global.md", content: "edited shadowed ref" }],
      },
      "test",
    );
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(
      betaTombstone.id,
      {
        metadata: { version: "2.0.0" },
        references: [{ path: "references/global.md", content: "edited disabled ref" }],
      },
      "test",
    );
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(appAlpha.id, { metadata: { author: "someone" } }, "test");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
    await manager.restartIfRunning(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(
      appAlpha.id,
      { references: [{ path: "references/app.md", content: "app ref" }] },
      "test",
    );
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
    await manager.restartIfRunning(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("logs skill warnings by code, name, and root", async () => {
    const logged: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, fields) => {
        logged.push({ message, fields });
      },
      error: () => undefined,
    };
    const skills = fakeSkills("skills-one");
    skills.setWarnings([
      { code: "skill_collision", name: "alpha", root: "skills" },
      { code: "skill_disabled_elsewhere", name: "legacy", root: "skill" },
    ]);
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
      undefined,
      logger,
    );

    await manager.ensure(APP);

    const warnings = logged.filter((entry) => entry.message === "skills_materialize_warnings");
    expect(warnings.length).toBeGreaterThan(0);
    const fields = warnings[0]?.fields as {
      warnings: Array<Record<string, unknown>>;
    };
    expect(fields.warnings).toEqual([
      { code: "skill_collision", name: "alpha", root: "skills" },
      { code: "skill_disabled_elsewhere", name: "legacy", root: "skill" },
    ]);
    for (const warning of fields.warnings) {
      expect(warning).not.toHaveProperty("id");
    }
  });

  it("persists applied settings across detach and reattach", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, db, dir } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);

    const recorded = db
      .prepare(
        "SELECT applied_settings_hash AS appliedSettingsHash, applied_profile AS appliedProfile FROM instances WHERE app_id = 'p:web'",
      )
      .get() as { appliedSettingsHash: string | null; appliedProfile: number | null };
    expect(recorded.appliedSettingsHash).toEqual(expect.any(String));
    expect(recorded.appliedProfile).toBe(1);

    settings.setModel("deepseek/deepseek-pro");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    manager.detach();
    const reattached = new InstanceManager(db, dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
    });
    expect(reattached.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    await reattached.ensure(APP);
    expect(reattached.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    await expect(reattached.restartIfRunning(APP)).resolves.toBe(true);
    expect(reattached.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("reports applied_state_unknown for legacy rows without an applied hash", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, db, dir } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);
    db.prepare(
      "UPDATE instances SET applied_settings_hash = NULL, applied_profile = NULL WHERE app_id = 'p:web'",
    ).run();
    manager.detach();

    const reattached = new InstanceManager(db, dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
    });
    expect(reattached.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["applied_state_unknown"],
    });

    await reattached.ensure(APP);
    expect(reattached.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["applied_state_unknown"],
    });
  });

  it("does not report pending for a row that is not running", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, db } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);
    const recorded = db
      .prepare(
        "SELECT applied_settings_hash AS appliedSettingsHash, applied_profile AS appliedProfile FROM instances WHERE app_id = 'p:web'",
      )
      .get() as { appliedSettingsHash: string | null; appliedProfile: number | null };
    await manager.stopApp(APP.id);
    expect(
      db
        .prepare(
          "SELECT applied_settings_hash AS appliedSettingsHash, applied_profile AS appliedProfile FROM instances WHERE app_id = 'p:web'",
        )
        .get(),
    ).toEqual(recorded);
    manager.detach();
    settings.setModel("deepseek/deepseek-pro");

    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("refuses to start an app whose project is marked deleting", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(APP.projectId);

    await expect(manager.ensure(APP)).rejects.toBeInstanceOf(DeletionPendingError);
    expect(runtime.ensured).toHaveLength(0);
    expect(manager.isRunning(APP.id)).toBe(false);
  });

  it("refuses a queued ensure after stopForDeletion commits the marker", async () => {
    const gate = deferred<void>();
    let deleteStarted = false;
    class GatedRuntime extends FakeAgentRuntime {
      override async delete(appId: string) {
        deleteStarted = true;
        await gate.promise;
        return super.delete(appId);
      }
    }
    const runtime = new GatedRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);

    const stopping = manager.stopForDeletion(APP.id);
    await waitFor(() => deleteStarted);
    const queued = manager.ensure(APP).then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.ensured).toHaveLength(1);

    gate.resolve(undefined);
    await expect(stopping).resolves.toBe(true);
    const queuedError = await queued;
    expect(queuedError).toBeInstanceOf(DeletionPendingError);
    expect(runtime.ensured).toHaveLength(1);
    expect(manager.isRunning(APP.id)).toBe(false);
    const row = db.prepare("SELECT deleting FROM apps WHERE id = ?").get(APP.id) as {
      deleting: number;
    };
    expect(row.deleting).toBe(1);
  });

  it("retries stopForDeletion on an already-marked app", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(APP.id);
    db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(APP.projectId);

    await expect(manager.stopForDeletion(APP.id)).resolves.toBe(true);

    expect(runtime.deleted).toEqual([APP.id]);
    expect(manager.isRunning(APP.id)).toBe(false);
  });

  it("keeps the instance and writes no marker when the runtime delete fails", async () => {
    class FailingDeleteRuntime extends FakeAgentRuntime {
      failDelete = false;
      override async delete(appId: string) {
        if (this.failDelete) throw new Error("runtime unavailable");
        return super.delete(appId);
      }
    }
    const runtime = new FailingDeleteRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);
    runtime.failDelete = true;

    await expect(manager.stopForDeletion(APP.id)).rejects.toThrow("runtime unavailable");
    expect(manager.isRunning(APP.id)).toBe(true);
    expect(authorizationFor(endpoint)).toBeDefined();
    expect(runtime.deleted).toEqual([]);
    const marked = db.prepare("SELECT deleting FROM apps WHERE id = ?").get(APP.id) as {
      deleting: number;
    };
    expect(marked.deleting).toBe(0);

    runtime.failDelete = false;
    await expect(manager.stopForDeletion(APP.id)).resolves.toBe(true);
    expect(manager.isRunning(APP.id)).toBe(false);
    const stopped = db.prepare("SELECT deleting FROM apps WHERE id = ?").get(APP.id) as {
      deleting: number;
    };
    expect(stopped.deleting).toBe(1);
  });

  it("clears previews on stop, deletion, restart, reconcile, and container recreation", async () => {
    const cleared: string[] = [];
    const previews: PreviewCleanup = { clearApp: (appId) => cleared.push(appId) };

    const stopped = previewFixture(new FakeAgentRuntime(), previews);
    await stopped.manager.ensure(APP);
    cleared.length = 0;
    await stopped.manager.stopApp(APP.id);
    expect(cleared).toEqual([APP.id]);

    const deleted = previewFixture(new FakeAgentRuntime(), previews);
    await deleted.manager.ensure(APP);
    cleared.length = 0;
    await deleted.manager.stopForDeletion(APP.id);
    expect(cleared).toEqual([APP.id]);

    const restarted = previewFixture(new FakeAgentRuntime(), previews);
    await restarted.manager.ensure(APP);
    cleared.length = 0;
    await expect(restarted.manager.restartIfRunning(APP)).resolves.toBe(true);
    expect(cleared).toEqual([APP.id]);

    const reconciled = previewFixture(new FakeAgentRuntime(), previews);
    await reconciled.manager.ensure(APP);
    reconciled.runtime.statuses.delete(APP.id);
    cleared.length = 0;
    await reconciled.manager.reconcileStatuses();
    expect(cleared).toEqual([APP.id]);

    const recreated = previewFixture(new FakeAgentRuntime(), previews);
    await recreated.manager.ensure(APP);
    recreated.manager.detach();
    const current = recreated.runtime.statuses.get(APP.id);
    if (current === undefined) throw new Error("missing runtime status");
    recreated.runtime.statuses.set(APP.id, { ...current, endpoint: null });
    cleared.length = 0;
    await recreated.manager.ensure(APP);
    expect(cleared).toEqual([APP.id]);

    class FailingDeleteRuntime extends FakeAgentRuntime {
      failDelete = false;
      override async delete(appId: string) {
        if (this.failDelete) throw new Error("runtime unavailable");
        return super.delete(appId);
      }
    }
    const failingRuntime = new FailingDeleteRuntime();
    const failing = previewFixture(failingRuntime, previews);
    await failing.manager.ensure(APP);
    failingRuntime.failDelete = true;
    cleared.length = 0;
    await expect(failing.manager.stopApp(APP.id)).rejects.toThrow("runtime unavailable");
    expect(cleared).toEqual([]);
  });

  it("reconciles a stale running row after the container disappears", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, db } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);
    settings.setModel("deepseek/deepseek-pro");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    runtime.statuses.delete(APP.id);
    expect(instanceState(db)).toBe("running");

    await manager.reconcileStatuses();

    expect(instanceState(db)).toBe("stopped");
    expect(manager.isRunning(APP.id)).toBe(false);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("keeps the last known state when a status probe fails", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    runtime.status = async () => {
      throw new Error("runner unavailable");
    };

    await manager.reconcileStatuses();

    expect(instanceState(db)).toBe("running");
    expect(manager.isRunning(APP.id)).toBe(true);
  });

  it("persists stopped when restart finds a stopped agent", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const { manager, db } = fixture(runtime, settings, fakeProfiles().source);
    await manager.ensure(APP);
    settings.setModel("deepseek/deepseek-pro");
    manager.detach();
    runtime.statuses.delete(APP.id);

    expect(instanceState(db)).toBe("running");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    await expect(manager.restartIfRunning(APP)).resolves.toBe(false);

    expect(instanceState(db)).toBe("stopped");
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("starts a reconciler that clears a stale row", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    runtime.statuses.delete(APP.id);

    manager.startStatusReconciler(20);
    await waitFor(() => instanceState(db) === "stopped");
    manager.detach();

    expect(instanceState(db)).toBe("stopped");
  });

  it("revokes and deletes the token on stop", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);

    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const token = readFileSync(tokenFile, "utf8");

    await expect(manager.stopApp(APP.id)).resolves.toBe(true);

    expect(runtime.deleted).toEqual([APP.id]);
    expect(authorizationFor(endpoint)).toBeUndefined();
    expect(manager.isRunning(APP.id)).toBe(false);
    expect(existsSync(tokenFile)).toBe(false);
    expect(verifyAgentToken(db, token)).toBeUndefined();
    const row = db.prepare("SELECT revoked_at FROM agent_tokens WHERE app_id = 'p:web'").get() as
      | { revoked_at: string | null }
      | undefined;
    expect(row?.revoked_at).not.toBeNull();
  });

  it("reconciles a mismatched token file without recreating a running instance", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const firstEndpoint = await manager.ensure(APP);

    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const previousToken = readFileSync(tokenFile, "utf8");
    writeFileSync(tokenFile, "tampered-token", { mode: 0o600 });

    const endpoint = await manager.ensure(APP);

    expect(endpoint).toBe(firstEndpoint);
    expect(runtime.ensured).toHaveLength(1);
    expect(runtime.deleted).toEqual([]);
    const token = readFileSync(tokenFile, "utf8");
    expect(token).not.toBe(previousToken);
    expect(verifyAgentToken(db, previousToken)).toBeUndefined();
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(manager.isRunning(APP.id)).toBe(true);
  });

  it("reconciles a missing token row against a running container without recreating it", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);
    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const previousToken = readFileSync(tokenFile, "utf8");
    db.prepare("DELETE FROM agent_tokens WHERE app_id = ?").run(APP.id);

    await expect(manager.ensure(APP)).resolves.toBe(endpoint);

    const token = readFileSync(tokenFile, "utf8");
    expect(token).not.toBe(previousToken);
    expect(runtime.ensured).toHaveLength(1);
    expect(runtime.deleted).toEqual([]);
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(verifyAgentToken(db, previousToken)).toBeUndefined();
  });

  it("reconciles a rotated token row against a running container without recreating it", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);
    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const previousToken = readFileSync(tokenFile, "utf8");
    const rotated = mintAgentToken(db, APP.id);

    await expect(manager.ensure(APP)).resolves.toBe(endpoint);

    const token = readFileSync(tokenFile, "utf8");
    expect(token).not.toBe(previousToken);
    expect(runtime.ensured).toHaveLength(1);
    expect(runtime.deleted).toEqual([]);
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(verifyAgentToken(db, rotated)).toBeUndefined();
  });

  it("repairs a crash between the DB commit and the file rename on the next ensure", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);
    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const previousToken = readFileSync(tokenFile, "utf8");
    const committed = mintAgentToken(db, APP.id);

    await expect(manager.ensure(APP)).resolves.toBe(endpoint);

    const token = readFileSync(tokenFile, "utf8");
    expect(token).not.toBe(previousToken);
    expect(runtime.ensured).toHaveLength(1);
    expect(runtime.deleted).toEqual([]);
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(verifyAgentToken(db, committed)).toBeUndefined();
  });

  it("fails closed without recreating when the token file cannot be written", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);
    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    rmSync(tokenFile);
    mkdirSync(tokenFile);

    await expect(manager.ensure(APP)).rejects.toBeInstanceOf(AgentTokenReconcileError);
    expect(runtime.ensured).toHaveLength(1);
    expect(runtime.deleted).toEqual([]);
    const active = db
      .prepare("SELECT COUNT(*) AS count FROM agent_tokens WHERE app_id = ? AND revoked_at IS NULL")
      .get(APP.id) as { count: number };
    expect(active.count).toBe(0);

    rmSync(tokenFile, { recursive: true });
    await expect(manager.ensure(APP)).resolves.toBe(endpoint);
    const token = readFileSync(tokenFile, "utf8");
    expect(verifyAgentToken(db, token)).toBeDefined();
  });

  it("does not write tokens on the periodic status reconciler", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const token = readFileSync(tokenFile, "utf8");
    const activeBefore = db
      .prepare(
        "SELECT token_hash FROM agent_tokens WHERE app_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(APP.id) as { token_hash: string };

    manager.startStatusReconciler(10);
    await new Promise((resolve) => setTimeout(resolve, 35));
    manager.stopStatusReconciler();

    const activeAfter = db
      .prepare(
        "SELECT token_hash FROM agent_tokens WHERE app_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(APP.id) as { token_hash: string };
    expect(activeAfter).toEqual(activeBefore);
    expect(readFileSync(tokenFile, "utf8")).toBe(token);
    expect(verifyAgentToken(db, token)).toBeDefined();
  });

  it("reconciles the token on startup before attaching an enabled context monitor", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4212");
    const settings = fakeSettings({ context: {} });
    const profiles = fakeProfiles();
    const initial = fixture(runtime, settings, profiles.source);
    await initial.manager.ensure(APP);
    initial.manager.detach();
    initial.db.prepare("DELETE FROM agent_tokens WHERE app_id = ?").run(APP.id);

    const monitors = fakeMonitorFactory();
    const manager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      monitorFactory: monitors.factory,
    });
    await manager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);

    const token = readFileSync(path.join(initial.dir, "p", "web", "mcp-token"), "utf8");
    expect(verifyAgentToken(initial.db, token)).toBeDefined();
    expect(monitors.monitors).toHaveLength(1);
    expect(manager.isRunning(APP.id)).toBe(true);
  });

  it("reconciles the token on startup even when context monitors are disabled", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4211");
    const settings = fakeSettings({ context: {} });
    const profiles = fakeProfiles();
    const initial = fixture(runtime, settings, profiles.source);
    await initial.manager.ensure(APP);
    initial.manager.detach();
    initial.db.prepare("DELETE FROM agent_tokens WHERE app_id = ?").run(APP.id);

    const monitors = fakeMonitorFactory();
    const manager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      enableContextMonitors: false,
      monitorFactory: monitors.factory,
    });
    await manager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);

    const token = readFileSync(path.join(initial.dir, "p", "web", "mcp-token"), "utf8");
    expect(verifyAgentToken(initial.db, token)).toBeDefined();
    expect(monitors.monitors).toHaveLength(0);
  });

  it("fans out monitor context updates to current subscribers", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4230");
    const settings = fakeSettings({ context: {} });
    const profiles = fakeProfiles();
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      runtime,
      settings,
      profiles.source,
      undefined,
      undefined,
      undefined,
      { monitorFactory: monitors.factory },
    );
    await manager.ensure(APP);

    const seen: ContextSnapshot[] = [];
    const unsubscribe = manager.subscribeContext(APP.id, (snapshot) => seen.push(snapshot));
    const monitor = monitors.monitors.at(-1);
    monitor?.options.onContextUpdate?.(snapshotStub("ses_live"));
    expect(seen.map((snapshot) => snapshot.sessionID)).toEqual(["ses_live"]);

    unsubscribe();
    monitor?.options.onContextUpdate?.(snapshotStub("ses_after"));
    expect(seen.map((snapshot) => snapshot.sessionID)).toEqual(["ses_live"]);
  });

  it("relaunches when the runtime status is not running", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    const status = runtime.statuses.get(APP.id);
    if (status === undefined) throw new Error("missing runtime status");
    runtime.statuses.set(APP.id, { ...status, state: "stopped", endpoint: null });

    await manager.ensure(APP);

    expect(runtime.ensured).toHaveLength(2);
    expect(runtime.deleted).toEqual([APP.id]);
  });

  it("revokes and clears everything on stopAll", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);

    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const token = readFileSync(tokenFile, "utf8");
    await manager.stopAll();

    expect(runtime.reconcileCalls).toEqual([[]]);
    expect(authorizationFor(endpoint)).toBeUndefined();
    expect(existsSync(tokenFile)).toBe(false);
    expect(verifyAgentToken(db, token)).toBeUndefined();
    expect(manager.isRunning(APP.id)).toBe(false);
  });

  it("detach drops in-memory state without stopping hosts or revoking tokens", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);
    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const token = readFileSync(tokenFile, "utf8");

    manager.detach();

    expect(runtime.deleted).toEqual([]);
    expect(runtime.reconcileCalls).toEqual([]);
    expect(authorizationFor(endpoint)).toBeUndefined();
    expect(existsSync(tokenFile)).toBe(true);
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(manager.isRunning(APP.id)).toBe(false);

    await expect(manager.stopApp(APP.id)).resolves.toBe(true);
    expect(runtime.deleted).toEqual([APP.id]);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("waits for an in-flight ensure before restarting", async () => {
    const runtime = new FakeAgentRuntime();
    const gate = deferred<void>();
    let verifyStarted = false;
    const { manager } = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => {
        verifyStarted = true;
        await gate.promise;
        return [];
      },
    );

    const ensured = manager.ensure(APP);
    await waitFor(() => verifyStarted);
    let stopped = false;
    const stopping = manager.stopApp(APP.id).then((result) => {
      stopped = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    gate.resolve(undefined);
    const endpoint = await ensured;
    expect(endpoint).toContain("127.0.0.1");
    await expect(stopping).resolves.toBe(true);
    expect(manager.isRunning(APP.id)).toBe(false);
    expect(runtime.deleted).toEqual([APP.id]);
  });

  it("reports settings_changed when the snapshot hash changes", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings({ model: "deepseek/deepseek-flash" });
    const profiles = fakeProfiles();
    const { manager } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    settings.setModel("deepseek/deepseek-pro");

    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
    expect(profiles.previews.length).toBeGreaterThan(0);

    await manager.stopApp(APP.id);
    await manager.ensure(APP);
    const overlay = overlayOf(runtime.ensured[1] ?? { env: {} });
    expect(overlay.model).toBe("deepseek/deepseek-pro");
  });

  it("materializes managed git credentials and exposes only paths in the app env", async () => {
    const runtime = new FakeAgentRuntime();
    const privateKey =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nkey-material\n-----END OPENSSH PRIVATE KEY-----\n";
    const token = "https-token-material";
    const settings = fakeSettings({
      gitIdentity: { name: 'Ada "Lovelace"', email: "ada@example.com" },
      gitAuth: {
        ssh: {
          privateKey,
          knownHosts: "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA",
        },
        https: { hosts: ["github.com"], username: "x-access-token", token },
      },
    });
    const profiles = fakeProfiles();
    const { manager, runtime: fakeRuntime, dir } = fixture(runtime, settings, profiles.source);

    await manager.ensure(APP);

    const home = path.join(dir, "p", "web", "home");
    const managed = path.join(home, ".config", "hanse", "git");
    for (const file of [
      "config",
      "ssh",
      "askpass",
      "id",
      "known_hosts",
      "token",
      "username",
      "https_hosts",
    ]) {
      expect(existsSync(path.join(managed, file)), file).toBe(true);
    }
    expect(statSync(path.join(managed, "config")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(managed, "ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(managed, "askpass")).mode & 0o777).toBe(0o700);
    const config = readFileSync(path.join(managed, "config"), "utf8");
    expect(config).toContain('name = "Ada \\"Lovelace\\""');
    expect(config).toContain('email = "ada@example.com"');
    expect(config).toContain("helper =");

    const spec = fakeRuntime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    expect(spec.env.GIT_CONFIG_GLOBAL).toBe(path.join(managed, "config"));
    expect(spec.env.GIT_SSH_COMMAND).toBe(`'${path.join(managed, "ssh")}'`);
    expect(spec.env.GIT_ASKPASS).toBe(path.join(managed, "askpass"));
    expect(spec.env.GIT_ASKPASS_REQUIRE).toBe("force");
    expect(spec.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(spec.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(spec.env.HANSE_CREDENTIALS_DIR).toBe(managed);
    expect(spec.env.LC_ALL).toBe("C");
    expect(spec.env.LANG).toBe("C");
    expect(spec.env.GIT_CEILING_DIRECTORIES).toBe("/srv/apps");
    const serialized = JSON.stringify(spec);
    expect(serialized).not.toContain("key-material");
    expect(serialized).not.toContain(token);
  });

  it("creates a fresh app root and home before materializing", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const appRoot = path.join(dir, "p", "web");

    expect(existsSync(appRoot)).toBe(false);
    await manager.ensure(APP);

    expect(existsSync(path.join(appRoot, "home", ".config", "hanse", "git", "config"))).toBe(true);
  });

  it("treats a git credential hash change as a pending restart", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const { manager } = fixture(runtime, settings, fakeProfiles().source);
    await manager.ensure(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    settings.setGitAuthHash("changed-git-auth-hash");

    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
  });

  it("fails the start when the app HOME is a symlink", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const appRoot = path.join(dir, "p", "web");
    const otherHome = path.join(dir, "other-home");
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(otherHome, { recursive: true });
    symlinkSync(otherHome, path.join(appRoot, "home"));

    await expect(manager.ensure(APP)).rejects.toThrow(/git_credentials_materialize_failed/);
    expect(runtime.ensured).toHaveLength(0);
  });
  it("reports profile_not_applied when the profile write failed", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles({
      applied: false,
      warning: "omo_profile_unavailable: parse failure",
    });
    const { manager } = fixture(runtime, settings, profiles.source);

    await manager.ensure(APP);

    const spec = runtime.ensured[0];
    expect(spec?.env.OMO_PROFILE).toBeUndefined();
    expect(manager.profileWarnings(APP.id)).toEqual(["omo_profile_unavailable: parse failure"]);
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["profile_not_applied"],
    });
  });

  it("has no pending state when stopped or unknown", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source);

    expect(manager.pendingRestart("unknown")).toEqual({ pending: false, reasons: [] });
    await manager.ensure(APP);
    await manager.stopApp(APP.id);

    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("registers hanse_web and disables OMO websearch for managed search", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings({
      search: { driver: "deepseek", options: { provider: "deepseek" } },
    });
    const profiles = fakeProfiles();
    const { manager, dir } = fixture(runtime, settings, profiles.source);

    await manager.ensure(APP);

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    const overlay = overlayOf(spec) as {
      mcp?: Record<string, { command?: string[]; environment?: Record<string, string> }>;
    };
    expect(overlay.mcp?.hanse_web?.command).toEqual([
      process.execPath,
      process.argv[1] ?? "",
      "web-mcp",
    ]);
    expect(overlay.mcp?.hanse_web?.environment).toEqual({
      HANSE_WEB_CONFIG: JSON.stringify({ search: { provider: "deepseek" } }),
      HANSE_OPENCODE_AUTH_FILE: path.join(dir, "p", "web", "data", "opencode", "auth.json"),
    });
    expect(profiles.ensures[0]?.disableWebsearch).toBe(true);
  });

  it("keeps the existing behavior when settings and profiles are absent", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, dir } = fixture(runtime);

    await manager.ensure(APP);

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    const overlay = overlayOf(spec);
    expect(overlay.model).toBeUndefined();
    expect(spec.env.OMO_PROFILE).toBeUndefined();
    expect(spec.env.HANSE_OPENCODE_AUTH_FILE).toBeUndefined();
    expect(existsSync(path.join(dir, "p", "web", "data", "opencode", "auth.json"))).toBe(false);
    expect(
      existsSync(path.join(dir, "p", "web", "home", ".config", "hanse", "git", "config")),
    ).toBe(false);
    expect(spec.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(spec.env.GIT_ASKPASS).toBeUndefined();
    expect(spec.env.HANSE_CREDENTIALS_DIR).toBeUndefined();
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("records model mismatch warnings from the model verifier", async () => {
    const runtime = new FakeAgentRuntime();
    const warning =
      'model_mismatch: agent "oracle" uses deepseek/other, expected deepseek/deepseek-flash';
    const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source, async () => [
      warning,
    ]);

    await manager.ensure(APP);

    expect(manager.profileWarnings(APP.id)).toEqual([warning]);
  });

  it("parses /agent model mismatches and sends Basic auth", async () => {
    const endpoint = "http://127.0.0.1:4101";
    setEndpointAuthorization(endpoint, "opencode", "hunter2");
    let authorization: string | undefined;
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(
        JSON.stringify([
          { name: "oracle", model: { providerID: "deepseek", modelID: "other" } },
          {
            name: "explore",
            model: { providerID: "deepseek", modelID: "deepseek-flash" },
          },
        ]),
        { status: 200 },
      );
    };

    await expect(
      verifyAgentModels(endpoint, "deepseek/deepseek-flash", fetchImpl),
    ).resolves.toEqual([
      'model_mismatch: agent "oracle" uses deepseek/other, expected deepseek/deepseek-flash',
    ]);
    expect(authorization).toMatch(/^Basic /);
  });
});

describe("InstanceManager context monitors", () => {
  it("starts one monitor per running app and keeps it across repeated ensure", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4201");
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      runtime,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    expect(monitors.monitors).toHaveLength(1);
    expect(monitors.monitors[0]?.startCount).toBe(1);
    expect(monitors.monitors[0]?.options.endpoint).toBe("http://127.0.0.1:4201");

    await expect(manager.contextSnapshot(APP.id, "s")).resolves.toMatchObject({ sessionID: "s" });
    await expect(manager.compactSession(APP.id, "s")).resolves.toEqual({ accepted: true });

    await manager.ensure(APP);
    expect(monitors.monitors).toHaveLength(1);
    expect(monitors.monitors[0]?.startCount).toBe(1);
  });

  it("does not start a monitor when settings lack a context policy", async () => {
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    expect(monitors.monitors).toHaveLength(0);
  });

  it("stops the monitor on stopApp, stopForDeletion, and detach", async () => {
    const runtime = new FakeAgentRuntime();
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      runtime,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    await manager.stopApp(APP.id);
    expect(monitors.monitors[0]?.stopCount).toBe(1);

    await manager.ensure(APP);
    await manager.stopForDeletion(APP.id);
    expect(monitors.monitors[1]?.stopCount).toBe(1);

    const restarted = new FakeAgentRuntime();
    const next = fakeMonitorFactory();
    const other = fixture(
      restarted,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: next.factory },
    );
    await other.manager.ensure(APP);
    other.manager.detach();
    expect(next.monitors[0]?.stopCount).toBe(1);
    expect(other.manager.isRunning(APP.id)).toBe(false);
  });

  it("stops the old monitor before starting a new one on restart", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4202");
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      runtime,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    await expect(manager.restartIfRunning(APP)).resolves.toBe(true);

    expect(monitors.monitors).toHaveLength(2);
    expect(monitors.monitors[0]?.stopCount).toBe(1);
    expect(monitors.monitors[1]?.startCount).toBe(1);
  });

  it("supersedes the monitor when a reconnect sees a new endpoint", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4203");
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      runtime,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    const status = runtime.statuses.get(APP.id);
    if (status === undefined) throw new Error("missing runtime status");
    runtime.statuses.set(APP.id, { ...status, endpoint: "http://127.0.0.1:4299" });

    await manager.ensure(APP);

    expect(monitors.monitors).toHaveLength(2);
    expect(monitors.monitors[0]?.stopCount).toBe(1);
    expect(monitors.monitors[1]?.options.endpoint).toBe("http://127.0.0.1:4299");
  });

  it("stops every monitor before runtime.reconcile on stopAll", async () => {
    const order: string[] = [];
    class OrderedRuntime extends FakeAgentRuntime {
      override async reconcile(appIds: string[]) {
        order.push("reconcile");
        return super.reconcile(appIds);
      }
    }
    const monitors = fakeMonitorFactory();
    const factory = (options: ContextMonitorOptions): ContextMonitorLike => {
      const monitor = monitors.factory(options);
      const stop = monitor.stop.bind(monitor);
      monitor.stop = () => {
        order.push("monitor:stop");
        stop();
      };
      return monitor;
    };
    const { manager } = fixture(
      new OrderedRuntime(),
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: factory },
    );

    await manager.ensure(APP);
    await manager.stopAll();

    expect(order[0]).toBe("monitor:stop");
    expect(order).toContain("reconcile");
    expect(order.indexOf("monitor:stop")).toBeLessThan(order.indexOf("reconcile"));
  });

  it("resumes only running or starting instances and skips deleting apps", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4204");
    const settings = fakeSettings({ context: {} });
    const profiles = fakeProfiles();
    const monitors = fakeMonitorFactory();
    const initial = fixture(
      runtime,
      settings,
      profiles.source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );
    await initial.manager.ensure(APP);
    initial.manager.detach();

    const resumed = fakeMonitorFactory();
    const manager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      monitorFactory: resumed.factory,
    });

    await manager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);
    expect(manager.isRunning(APP.id)).toBe(true);
    expect(resumed.monitors).toHaveLength(1);

    const status = runtime.statuses.get(APP.id);
    if (status === undefined) throw new Error("missing runtime status");
    runtime.statuses.set(APP.id, { ...status, state: "starting" });
    manager.detach();
    const starting = fakeMonitorFactory();
    const startingManager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      monitorFactory: starting.factory,
    });
    await startingManager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);
    expect(startingManager.isRunning(APP.id)).toBe(true);
    expect(starting.monitors).toHaveLength(1);

    runtime.statuses.set(APP.id, { ...status, state: "stopped", endpoint: null });
    startingManager.detach();
    const stopped = fakeMonitorFactory();
    const stoppedManager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      monitorFactory: stopped.factory,
    });
    await stoppedManager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);
    expect(stoppedManager.isRunning(APP.id)).toBe(false);
    expect(stopped.monitors).toHaveLength(0);

    runtime.statuses.set(APP.id, status);
    initial.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(APP.id);
    const deleted = fakeMonitorFactory();
    const deletedManager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      monitorFactory: deleted.factory,
    });
    await deletedManager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);
    expect(deletedManager.isRunning(APP.id)).toBe(false);
    expect(deleted.monitors).toHaveLength(0);
  });

  it("throws AgentNotRunningError when no monitor is attached", async () => {
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await expect(manager.contextSnapshot(APP.id, "s")).rejects.toMatchObject({
      code: "agent_not_running",
    });
    await expect(manager.compactSession(APP.id, "s")).rejects.toMatchObject({
      code: "agent_not_running",
    });
  });

  it("hashes the pre-change effective shape and ignores context-only changes", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings({ context: { enabled: false, percent: 80 } });
    const profiles = fakeProfiles();
    const { manager, db } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);

    const recorded = db
      .prepare(
        "SELECT applied_settings_hash AS appliedSettingsHash FROM instances WHERE app_id = 'p:web'",
      )
      .get() as { appliedSettingsHash: string | null };
    const preChangeEffective = {
      llm: { model: value("deepseek/deepseek-flash") },
      web: { search: value({ driver: "builtin" }), fetch: value({ driver: "builtin" }) },
      git: {
        user: { name: value<string | null>(null), email: value<string | null>(null) },
      },
    };
    expect(recorded.appliedSettingsHash).toBe(
      hashValue({
        effective: preChangeEffective,
        providerKeys: {},
        authHash: "auth-hash",
        gitAuthHash: "git-auth-hash",
        profile: "profile-hash",
        policyVersion: ATTACHMENTS_POLICY_VERSION,
      }),
    );
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    settings.setContext(true, 55);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    settings.setModel("deepseek/deepseek-pro");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
  });
});

interface ImageFixture {
  manager: InstanceManager;
  runtime: FakeAgentRuntime;
  app: ManagedApp;
  appDir: string;
  db: SqliteDatabase;
}

function imageFixture(
  status: ManagedApp["imageStatus"],
  imageRef: string | null,
  buildDeclaration = true,
  lifecycle: { deploymentLock?: DeploymentLock; lifecycleActivity?: LifecycleActivity } = {},
  images?: InstanceImageSource,
): ImageFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-manager-image-"));
  dirs.push(dir);
  const appDir = path.join(dir, "apps", "web");
  mkdirSync(appDir, { recursive: true });
  if (buildDeclaration) {
    mkdirSync(path.join(appDir, ".hanse"), { recursive: true });
    writeFileSync(
      path.join(appDir, ".hanse", "app.yaml"),
      "name: web\nbuild:\n  dockerfile: Dockerfile\n",
      "utf8",
    );
    writeFileSync(path.join(appDir, "Dockerfile"), `FROM \${HANSE_BASE}\n`, "utf8");
  }
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:web','p','web','apps/web','AGENTS.md',?)",
  ).run(now);
  db.prepare("UPDATE apps SET image_status = ?, image_ref = ? WHERE id = 'p:web'").run(
    status ?? "missing",
    imageRef,
  );
  const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4100");
  const manager = new InstanceManager(db, dir, {
    runtime,
    verify: async () => [],
    workspaceRoot: dir,
    ...lifecycle,
    ...(images === undefined ? {} : { images }),
  });
  return {
    manager,
    runtime,
    db,
    appDir,
    app: {
      id: "p:web",
      projectId: "p",
      appKey: "web",
      appDir,
      imageStatus: status,
      imageRef,
    },
  };
}

describe("InstanceManager app image selection", () => {
  it.each(["ready", "stale"] as const)("uses the built image when status is %s", async (status) => {
    const f = imageFixture(status, "hanse-app-p:web:build-1");
    await f.manager.ensure(f.app);
    expect(f.runtime.ensured[0]?.image).toBe("hanse-app-p:web:build-1");
  });

  it.each(["missing", "building", "error"] as const)(
    "refuses to start a build-configured app with status %s",
    async (status) => {
      const f = imageFixture(status, null);
      await expect(f.manager.ensure(f.app)).rejects.toThrow(/requires a built image/);
      expect(f.runtime.ensured).toHaveLength(0);
    },
  );

  it("refuses a ready app without an image reference", async () => {
    const f = imageFixture("ready", null);
    await expect(f.manager.ensure(f.app)).rejects.toThrow(/requires a built image/);
    expect(f.runtime.ensured).toHaveLength(0);
  });

  it("keeps the default image when the app has no build declaration", async () => {
    const f = imageFixture("missing", null, false);
    await f.manager.ensure(f.app);
    expect(f.runtime.ensured[0]?.image).toBe(
      process.env.HANSE_AGENT_IMAGE?.trim() || "agent-default",
    );
  });

  it("reconnects to a running container instead of replacing it after a failed build", async () => {
    const f = imageFixture("ready", "hanse-app-p:web:build-1");
    const endpoint = await f.manager.ensure(f.app);
    await f.manager.ensure({ ...f.app, imageStatus: "error", imageRef: null });
    expect(f.runtime.ensured).toHaveLength(1);
    expect(f.runtime.deleted).toHaveLength(0);
    expect(await f.manager.ensure({ ...f.app, imageStatus: "error", imageRef: null })).toBe(
      endpoint,
    );
  });
  it("refuses an application whose sanitized state path collides with a sibling", async () => {
    const f = fixture();
    const now = new Date().toISOString();
    f.db
      .prepare(
        "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:web:api','p','web:api','apps/web-api-sibling','AGENTS.md',?)",
      )
      .run(now);
    await expect(
      f.manager.ensure({
        id: "p:web-api",
        projectId: "p",
        appKey: "web-api",
        appDir: path.join(f.dir, "apps", "web-api"),
      }),
    ).rejects.toThrow(/state_path_collision/);
    expect(f.runtime.ensured).toHaveLength(0);
  });
});

describe("InstanceManager applied image identity", () => {
  class ImageIdRuntime extends FakeAgentRuntime {
    readonly imageId: string | null;
    statusCalls = 0;

    constructor(imageId: string | null = "sha256:one") {
      super();
      this.imageId = imageId;
    }

    override async ensure(
      spec: Parameters<FakeAgentRuntime["ensure"]>[0],
    ): ReturnType<FakeAgentRuntime["ensure"]> {
      const status = await super.ensure(spec);
      const withImage = { ...status, imageId: this.imageId };
      this.statuses.set(spec.appId, withImage);
      return withImage;
    }

    override async status(appId: string): ReturnType<FakeAgentRuntime["status"]> {
      this.statusCalls += 1;
      return super.status(appId);
    }
  }

  function instanceRow(db: SqliteDatabase): {
    state: string;
    runtimeState: string;
    appliedImageId: string | null;
    appliedSettingsHash: string | null;
    appliedProfile: number | null;
  } {
    return db
      .prepare(
        `SELECT state, runtime_state AS runtimeState, applied_image_id AS appliedImageId,
                applied_settings_hash AS appliedSettingsHash, applied_profile AS appliedProfile
         FROM instances WHERE app_id = 'p:web'`,
      )
      .get() as {
      state: string;
      runtimeState: string;
      appliedImageId: string | null;
      appliedSettingsHash: string | null;
      appliedProfile: number | null;
    };
  }

  it("records the applied image ID on a destructive ensure", async () => {
    const runtime = new ImageIdRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);

    await manager.ensure(APP);

    expect(instanceRow(db).appliedImageId).toBe("sha256:one");
  });

  it("records the applied image ID on reconnect without clearing launch settings", async () => {
    const runtime = new ImageIdRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    const recorded = instanceRow(db);
    db.prepare("UPDATE instances SET applied_image_id = NULL WHERE app_id = 'p:web'").run();

    await expect(manager.ensure(APP)).resolves.toBeDefined();

    const row = instanceRow(db);
    expect(row.appliedImageId).toBe("sha256:one");
    expect(row.appliedSettingsHash).toBe(recorded.appliedSettingsHash);
    expect(row.appliedProfile).toBe(recorded.appliedProfile);
    expect(runtime.deleted).toHaveLength(0);
    expect(runtime.ensured).toHaveLength(1);
  });

  it("records the applied image ID in resumeRunning without clearing launch settings", async () => {
    const runtime = new ImageIdRuntime();
    const initial = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await initial.manager.ensure(APP);
    const recorded = instanceRow(initial.db);
    initial.manager.detach();
    initial.db.prepare("UPDATE instances SET applied_image_id = NULL WHERE app_id = 'p:web'").run();

    const manager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      workspaceRoot: "/srv",
    });
    await manager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);

    const row = instanceRow(initial.db);
    expect(row.appliedImageId).toBe("sha256:one");
    expect(row.appliedSettingsHash).toBe(recorded.appliedSettingsHash);
    expect(row.appliedProfile).toBe(recorded.appliedProfile);
  });

  it("records the applied image ID from the reconciler", async () => {
    const runtime = new ImageIdRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    const status = runtime.statuses.get(APP.id);
    if (status === undefined) throw new Error("missing runtime status");
    runtime.statuses.set(APP.id, { ...status, imageId: "sha256:two" });

    await manager.reconcileStatuses();

    expect(instanceRow(db).appliedImageId).toBe("sha256:two");
  });

  it("does not probe or overwrite a persisted stopped row in the reconciler", async () => {
    const runtime = new ImageIdRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    db.prepare(
      "UPDATE instances SET state = 'stopped', runtime_state = 'stopped' WHERE app_id = 'p:web'",
    ).run();
    runtime.statusCalls = 0;

    await manager.reconcileStatuses();

    expect(runtime.statusCalls).toBe(0);
    expect(instanceRow(db)).toMatchObject({ state: "stopped", appliedImageId: "sha256:one" });
  });

  it("preserves the previous applied image ID when a stop status has no image", async () => {
    const runtime = new ImageIdRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    const status = runtime.statuses.get(APP.id);
    if (status === undefined) throw new Error("missing runtime status");
    runtime.statuses.set(APP.id, { ...status, imageId: null });

    await expect(manager.stopApp(APP.id)).resolves.toBe(true);

    expect(instanceRow(db)).toMatchObject({ state: "stopped", appliedImageId: "sha256:one" });
  });

  it("probes a stopped row once and persists the observed identity", async () => {
    const runtime = new ImageIdRuntime("sha256:probe");
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    await manager.stopApp(APP.id);
    db.prepare("UPDATE instances SET applied_image_id = NULL WHERE app_id = 'p:web'").run();
    const status = runtime.statuses.get(APP.id);
    runtime.statuses.set(APP.id, {
      ...(status ?? stoppedStatus(APP.id)),
      state: "running",
      endpoint: "http://127.0.0.1:4400",
      imageId: "sha256:probe",
    });

    await expect(manager.probeStatus(APP.id)).resolves.toBe(true);

    expect(instanceRow(db)).toMatchObject({
      state: "running",
      runtimeState: "running",
      appliedImageId: "sha256:probe",
    });
    expect(runtime.ensured).toHaveLength(1);
    expect(runtime.deleted).toHaveLength(1);
  });

  it("does not probe a row whose persisted state is not stopped", async () => {
    const runtime = new ImageIdRuntime();
    const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    runtime.statusCalls = 0;

    await expect(manager.probeStatus(APP.id)).resolves.toBe(false);

    expect(runtime.statusCalls).toBe(0);
  });
});

describe("InstanceManager image preflight", () => {
  const builtRef = "hanse-app-p:web:build-1";

  it.each(["building", "build_error"] as const)(
    "starts a build-configured app with a usable ref while the state is %s",
    async (state) => {
      const images = new FakeImages(
        imageStateView({ state, usableImageRef: builtRef, targetImageId: "sha256:one" }),
      );
      const f = imageFixture("building", builtRef, true, {}, images);

      await f.manager.ensure(f.app);

      expect(f.runtime.ensured[0]?.image).toBe(builtRef);
    },
  );

  it("starts a build-configured app with a usable ref after a configuration error", async () => {
    const images = new FakeImages(
      imageStateView({ state: "build_error", usableImageRef: builtRef }),
    );
    const f = imageFixture("ready", builtRef, true, {}, images);
    writeFileSync(path.join(f.appDir, ".hanse", "app.yaml"), "name: [broken", "utf8");

    await f.manager.ensure(f.app);

    expect(f.runtime.ensured[0]?.image).toBe(builtRef);
  });

  it("uses the digest-bearing default reference for a default app", async () => {
    const previousDigest = process.env.HANSE_AGENT_IMAGE_DIGEST;
    process.env.HANSE_AGENT_IMAGE_DIGEST = "sha256:deadbeef";
    try {
      const images = new FakeImages(
        imageStateView({
          buildConfigured: false,
          status: "missing",
          imageRef: null,
          usableImageRef: null,
          targetImageId: "sha256:default",
        }),
      );
      const f = imageFixture("missing", null, false, {}, images);

      await f.manager.ensure(f.app);

      expect(f.runtime.ensured[0]?.image).toBe("agent-default@sha256:deadbeef");
    } finally {
      if (previousDigest === undefined) delete process.env.HANSE_AGENT_IMAGE_DIGEST;
      else process.env.HANSE_AGENT_IMAGE_DIGEST = previousDigest;
    }
  });

  it("rejects a build-configured app without a usable image and leaves the container untouched", async () => {
    const images = new FakeImages(
      imageStateView({ state: "not_ready", usableImageRef: null, targetImageId: null }),
    );
    const f = imageFixture("ready", builtRef, true, {}, images);

    await expect(f.manager.ensure(f.app)).rejects.toBeInstanceOf(ImageNotReadyError);

    expect(f.runtime.ensured).toHaveLength(0);
    expect(f.runtime.deleted).toHaveLength(0);
  });

  it("rejects a default app when the target image is unknown", async () => {
    const images = new FakeImages(
      imageStateView({
        buildConfigured: false,
        status: "missing",
        imageRef: null,
        usableImageRef: null,
        targetImageId: null,
        state: "unknown",
      }),
    );
    const f = imageFixture("missing", null, false, {}, images);

    await expect(f.manager.ensure(f.app)).rejects.toBeInstanceOf(DefaultImageUnavailableError);

    expect(f.runtime.ensured).toHaveLength(0);
  });

  it("adopts the durable build before resolving the image state", async () => {
    const images = new FakeImages(imageStateView({ usableImageRef: builtRef }));
    const f = imageFixture("building", builtRef, true, {}, images);

    await f.manager.ensure(f.app);

    expect(images.order).toEqual(["adopt", "state"]);
    expect(images.adoptCalls).toEqual([f.app.id]);
  });

  it("launches the image ref selected by build adoption", async () => {
    const adoptedRef = "hanse-app-p:web:adopted";
    const images = new FakeImages(imageStateView({ usableImageRef: adoptedRef }));
    const f = imageFixture("building", "hanse-app-p:web:pending", true, {}, images);
    images.onAdopt = () => {
      f.db.prepare("UPDATE apps SET image_ref = ? WHERE id = ?").run(adoptedRef, f.app.id);
    };

    await f.manager.ensure(f.app);

    expect(f.runtime.ensured[0]?.image).toBe(adoptedRef);
  });

  it("preflightRestart rejects a not-ready image before touching a running container", async () => {
    const images = new FakeImages(imageStateView({ usableImageRef: builtRef }));
    const f = imageFixture("ready", builtRef, true, {}, images);
    await f.manager.ensure(f.app);
    images.view = imageStateView({
      state: "not_ready",
      usableImageRef: null,
      targetImageId: null,
    });

    await expect(f.manager.preflightRestart(f.app)).rejects.toBeInstanceOf(ImageNotReadyError);

    expect(images.adoptCalls).toEqual([f.app.id, f.app.id]);
    expect(f.runtime.deleted).toHaveLength(0);
    expect(f.runtime.ensured).toHaveLength(1);
  });

  it("preflightRestart does not probe or preflight a stopped app", async () => {
    const images = new FakeImages(imageStateView({ usableImageRef: builtRef }));
    const f = imageFixture("ready", builtRef, true, {}, images);

    await expect(f.manager.preflightRestart(f.app)).resolves.toBe(false);

    expect(images.adoptCalls).toHaveLength(0);
    expect(images.stateCalls).toHaveLength(0);
  });

  it("restartIfRunning rejects a not-ready image and keeps the running container", async () => {
    const images = new FakeImages(imageStateView({ usableImageRef: builtRef }));
    const f = imageFixture("ready", builtRef, true, {}, images);
    await f.manager.ensure(f.app);
    images.view = imageStateView({
      state: "build_error",
      usableImageRef: null,
      targetImageId: null,
    });

    await expect(f.manager.restartIfRunning(f.app)).rejects.toBeInstanceOf(ImageNotReadyError);

    expect(f.runtime.deleted).toHaveLength(0);
    expect(f.runtime.ensured).toHaveLength(1);
    expect(f.manager.isRestarting(f.app.id)).toBe(false);
  });

  it("restartIfRunning proceeds with a usable ref while the app is building", async () => {
    const images = new FakeImages(imageStateView({ usableImageRef: builtRef }));
    const f = imageFixture("ready", builtRef, true, {}, images);
    await f.manager.ensure(f.app);
    images.view = imageStateView({ state: "building", usableImageRef: builtRef });

    await expect(f.manager.restartIfRunning(f.app)).resolves.toBe(true);

    expect(f.runtime.deleted).toEqual([f.app.id]);
    expect(f.runtime.ensured).toHaveLength(2);
    expect(f.runtime.ensured[1]?.image).toBe(builtRef);
  });
});

describe("InstanceManager image rollback", () => {
  interface ImageRow {
    image_status: string;
    image_ref: string | null;
    image_hash: string | null;
    image_base_digest: string | null;
    image_built_at: string | null;
    image_error: string | null;
  }

  function imageRow(db: SqliteDatabase, appId: string): ImageRow {
    return db
      .prepare(
        `SELECT image_status, image_ref, image_hash, image_base_digest, image_built_at, image_error
         FROM apps WHERE id = ?`,
      )
      .get(appId) as ImageRow;
  }

  interface FullImageRow extends ImageRow {
    image_base_ref: string | null;
    image_base_kind: string | null;
    image_hash_version: number;
    image_build_id: string | null;
    image_build_ref: string | null;
    image_build_started_at: string | null;
    image_build_rejected_ref: string | null;
  }

  function fullImageRow(db: SqliteDatabase, appId: string): FullImageRow {
    return db
      .prepare(
        `SELECT image_status, image_ref, image_hash, image_base_digest, image_built_at,
                image_error, image_base_ref, image_base_kind, image_hash_version,
                image_build_id, image_build_ref, image_build_started_at,
                image_build_rejected_ref
         FROM apps WHERE id = ?`,
      )
      .get(appId) as FullImageRow;
  }

  function setImage(db: SqliteDatabase, appId: string, values: Partial<ImageRow>): void {
    const current = imageRow(db, appId);
    db.prepare(
      `UPDATE apps SET image_status = @image_status, image_ref = @image_ref,
         image_hash = @image_hash, image_base_digest = @image_base_digest,
         image_built_at = @image_built_at, image_error = @image_error
       WHERE id = @id`,
    ).run({ id: appId, ...current, ...values });
  }

  function rollbackOne(f: ImageFixture) {
    return async () => {
      setImage(f.db, f.app.id, {
        image_status: "ready",
        image_ref: "hanse-app-p:web:one",
        image_hash: "hash-one",
        image_base_digest: "base-one",
        image_built_at: "2026-01-01T00:00:00.000Z",
        image_error: null,
      });
      return {
        appId: f.app.id,
        appKey: "web",
        status: "ready" as const,
        imageRef: "hanse-app-p:web:one",
        previousImageRef: "hanse-app-p:web:two",
        builtAt: "2026-01-01T00:00:00.000Z",
      };
    };
  }

  it("updates a stopped app and re-reads the new ref on the next ensure", async () => {
    const f = imageFixture("ready", "hanse-app-p:web:two");

    const outcome = await f.manager.rollbackImage(f.app, rollbackOne(f));

    expect(outcome.restarted).toBe(false);
    expect(outcome.result.imageRef).toBe("hanse-app-p:web:one");
    expect(f.runtime.ensured).toHaveLength(0);
    expect(imageRow(f.db, f.app.id).image_ref).toBe("hanse-app-p:web:one");

    await f.manager.ensure({ ...f.app, imageRef: "hanse-app-p:web:two" });
    expect(f.runtime.ensured[0]?.image).toBe("hanse-app-p:web:one");
  });

  it("restarts a running app on the new image and reports restarted", async () => {
    const f = imageFixture("ready", "hanse-app-p:web:two");
    await f.manager.ensure(f.app);

    const outcome = await f.manager.rollbackImage(f.app, rollbackOne(f));

    expect(outcome.restarted).toBe(true);
    expect(f.runtime.deleted).toEqual([f.app.id]);
    expect(f.runtime.ensured).toHaveLength(2);
    expect(f.runtime.ensured[1]?.image).toBe("hanse-app-p:web:one");
    expect(f.manager.isRestarting(f.app.id)).toBe(false);
  });

  it("returns 409 without a DB change when a restart claim is already held", async () => {
    const f = imageFixture("ready", "hanse-app-p:web:two");
    await f.manager.ensure(f.app);
    const hold = f.manager.beginRestart(f.app);
    expect(hold.accepted).toBe(true);
    let called = false;

    await expect(
      f.manager.rollbackImage(f.app, async () => {
        called = true;
        return rollbackOne(f)();
      }),
    ).rejects.toBeInstanceOf(RestartInProgressError);

    expect(called).toBe(false);
    expect(imageRow(f.db, f.app.id).image_ref).toBe("hanse-app-p:web:two");
    await hold.completion;
    expect(f.manager.isRestarting(f.app.id)).toBe(false);
  });

  it("returns 409 without a claim or DB change when the deployment lock is active", async () => {
    const lockDir = mkdtempSync(path.join(tmpdir(), "hanse-manager-rollback-lock-"));
    dirs.push(lockDir);
    const lockPath = path.join(lockDir, "deploy.lock");
    const activity = new LifecycleActivity();
    const f = imageFixture("ready", "hanse-app-p:web:two", true, {
      deploymentLock: new DeploymentLock(lockPath),
      lifecycleActivity: activity,
    });
    await f.manager.ensure(f.app);
    const now = new Date();
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        id: "lock-1",
        phase: "switching",
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
      "utf8",
    );
    let called = false;

    await expect(
      f.manager.rollbackImage(f.app, async () => {
        called = true;
        return rollbackOne(f)();
      }),
    ).rejects.toBeInstanceOf(DeploymentInProgressError);

    expect(called).toBe(false);
    expect(imageRow(f.db, f.app.id).image_ref).toBe("hanse-app-p:web:two");
    expect(f.manager.isRestarting(f.app.id)).toBe(false);
    expect(activity.count).toBe(0);
  });

  it("restores every image field when the restart fails", async () => {
    const f = imageFixture("ready", "hanse-app-p:web:two");
    setImage(f.db, f.app.id, {
      image_hash: "hash-two",
      image_base_digest: "base-two",
      image_built_at: "2026-01-02T00:00:00.000Z",
      image_error: "stale-warning",
    });
    await f.manager.ensure(f.app);
    const before = imageRow(f.db, f.app.id);
    f.runtime.ensure = async () => {
      throw new Error("start failed");
    };

    await expect(f.manager.rollbackImage(f.app, rollbackOne(f))).rejects.toBeInstanceOf(
      ImageRollbackIncompleteError,
    );

    expect(imageRow(f.db, f.app.id)).toEqual(before);
    expect(f.manager.isRestarting(f.app.id)).toBe(false);
  });

  it("restores base/build fields and rethrows a typed error from the recomputed state", async () => {
    const images = new FakeImages(imageStateView({ usableImageRef: "hanse-app-p:web:two" }));
    const f = imageFixture("ready", "hanse-app-p:web:two", true, {}, images);
    setImage(f.db, f.app.id, {
      image_hash: "hash-two",
      image_base_digest: "base-two",
      image_built_at: "2026-01-02T00:00:00.000Z",
      image_error: "stale-warning",
    });
    f.db
      .prepare(
        `UPDATE apps SET image_base_ref = 'agent-base@sha256:two', image_base_kind = 'base',
           image_hash_version = 2, image_build_id = 'build-9',
           image_build_ref = 'hanse-app-p:web:two',
           image_build_started_at = '2026-01-02T00:00:00.000Z',
           image_build_rejected_ref = 'hanse-app-p:web:rejected'
         WHERE id = ?`,
      )
      .run(f.app.id);
    await f.manager.ensure(f.app);
    const before = fullImageRow(f.db, f.app.id);
    images.onImageState = () => {
      const current = fullImageRow(f.db, f.app.id);
      return current.image_ref === "hanse-app-p:web:one"
        ? imageStateView({ state: "not_ready", usableImageRef: null, targetImageId: null })
        : imageStateView({
            state: "current",
            usableImageRef: current.image_ref,
            targetImageId: "sha256:two",
          });
    };

    let thrown: unknown;
    try {
      await f.manager.rollbackImage(f.app, async () => {
        f.db
          .prepare(
            `UPDATE apps SET image_status = 'ready', image_ref = 'hanse-app-p:web:one',
               image_base_ref = 'agent-default', image_base_kind = 'default',
               image_hash_version = 1, image_build_id = NULL, image_build_ref = NULL,
               image_build_started_at = NULL, image_build_rejected_ref = NULL
             WHERE id = ?`,
          )
          .run(f.app.id);
        return {
          appId: f.app.id,
          appKey: "web",
          status: "ready" as const,
          imageRef: "hanse-app-p:web:one",
          previousImageRef: "hanse-app-p:web:two",
          builtAt: "2026-01-01T00:00:00.000Z",
        };
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ImageNotReadyError);
    expect((thrown as ImageNotReadyError).state).toBe("current");
    expect(fullImageRow(f.db, f.app.id)).toEqual(before);
    expect(f.runtime.deleted).toHaveLength(0);
  });

  it("returns 500 when restoring the snapshot also fails", async () => {
    const f = imageFixture("ready", "hanse-app-p:web:two");
    await f.manager.ensure(f.app);
    const original = f.runtime.ensure.bind(f.runtime);
    let calls = 0;
    f.runtime.ensure = async (spec) => {
      calls += 1;
      if (calls === 1) {
        f.db.exec("ALTER TABLE apps RENAME TO apps_archive");
        throw new Error("start failed");
      }
      return original(spec);
    };

    await expect(f.manager.rollbackImage(f.app, rollbackOne(f))).rejects.toBeInstanceOf(
      ImageRollbackRestoreError,
    );
    expect(f.manager.isRestarting(f.app.id)).toBe(false);
  });

  it("starts a queued ensure on the new image when the rollback waits for the lock", async () => {
    class GatedFirstEnsure extends FakeAgentRuntime {
      calls = 0;
      readonly entered = deferred<void>();
      readonly gate = deferred<void>();

      override async ensure(
        spec: Parameters<FakeAgentRuntime["ensure"]>[0],
      ): ReturnType<FakeAgentRuntime["ensure"]> {
        this.calls += 1;
        if (this.calls === 1) {
          this.entered.resolve();
          await this.gate.promise;
        }
        return super.ensure(spec);
      }
    }

    const runtime = new GatedFirstEnsure(() => "http://127.0.0.1:4310");
    const f = imageFixture("ready", "hanse-app-p:web:two");
    const manager = new InstanceManager(f.db, path.dirname(path.dirname(f.appDir)), {
      runtime,
      verify: async () => [],
      workspaceRoot: path.dirname(f.appDir),
    });
    const start = manager.ensure(f.app);
    await runtime.entered.promise;
    const rollback = manager.rollbackImage(f.app, rollbackOne(f));
    runtime.gate.resolve();
    await expect(start).resolves.toBe("http://127.0.0.1:4310");

    const outcome = await rollback;
    expect(outcome.restarted).toBe(true);
    expect(runtime.ensured[1]?.image).toBe("hanse-app-p:web:one");
  });

  it("never calls public ensure or restartIfRunning while holding the app lock", async () => {
    const f = imageFixture("ready", "hanse-app-p:web:two");
    await f.manager.ensure(f.app);
    let publicCalls = 0;
    f.manager.ensure = (async () => {
      publicCalls += 1;
      throw new Error("public ensure called");
    }) as InstanceManager["ensure"];
    f.manager.restartIfRunning = (async () => {
      publicCalls += 1;
      throw new Error("public restartIfRunning called");
    }) as InstanceManager["restartIfRunning"];

    const outcome = await f.manager.rollbackImage(f.app, rollbackOne(f));

    expect(outcome.restarted).toBe(true);
    expect(publicCalls).toBe(0);
  });
});

describe("InstanceManager deployment lock", () => {
  function activeLock(): string {
    const now = new Date();
    return JSON.stringify({
      version: 1,
      id: "lock-1",
      phase: "switching",
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
  }

  function lockFixture(): {
    f: Fixture;
    lock: DeploymentLock;
    lockPath: string;
    activity: LifecycleActivity;
    runtime: FakeAgentRuntime;
  } {
    const lockDir = mkdtempSync(path.join(tmpdir(), "hanse-manager-lock-"));
    dirs.push(lockDir);
    const lockPath = path.join(lockDir, "deploy.lock");
    const lock = new DeploymentLock(lockPath);
    const activity = new LifecycleActivity();
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4101");
    const f = fixture(
      runtime,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { deploymentLock: lock, lifecycleActivity: activity },
    );
    return { f, lock, lockPath, activity, runtime };
  }

  it("allows a fast reconnect under an active lock without counting it", async () => {
    const { f, lockPath, activity, runtime } = lockFixture();
    const endpoint = await f.manager.ensure(APP);
    expect(activity.count).toBe(0);
    writeFileSync(lockPath, activeLock(), "utf8");

    await expect(f.manager.ensure(APP)).resolves.toBe(endpoint);
    expect(runtime.ensured).toHaveLength(1);
    expect(runtime.deleted).toEqual([]);
    expect(activity.count).toBe(0);
  });

  it("refuses to start a stopped app under an active lock", async () => {
    const { f, lockPath, activity, runtime } = lockFixture();
    writeFileSync(lockPath, activeLock(), "utf8");

    await expect(f.manager.ensure(APP)).rejects.toBeInstanceOf(DeploymentInProgressError);
    expect(runtime.ensured).toEqual([]);
    expect(runtime.deleted).toEqual([]);
    expect(activity.count).toBe(0);
  });

  it("does not delete a running app whose endpoint is missing under a lock", async () => {
    const { f, lockPath, activity, runtime } = lockFixture();
    await f.manager.ensure(APP);
    const status = runtime.statuses.get(APP.id);
    if (status === undefined) throw new Error("missing status");
    runtime.statuses.set(APP.id, { ...status, endpoint: null });
    writeFileSync(lockPath, activeLock(), "utf8");

    const second = new InstanceManager(f.db, f.dir, {
      runtime,
      workspaceRoot: "/srv",
      deploymentLock: new DeploymentLock(lockPath),
      lifecycleActivity: activity,
    });
    await expect(second.ensure(APP)).rejects.toBeInstanceOf(DeploymentInProgressError);
    expect(runtime.deleted).toEqual([]);
    expect(runtime.ensured).toHaveLength(1);
    expect(activity.count).toBe(0);
  });

  it("guards stop, restart, deletion stop, and stopAll at entry", async () => {
    const { f, lockPath, runtime } = lockFixture();
    await f.manager.ensure(APP);
    writeFileSync(lockPath, activeLock(), "utf8");

    await expect(f.manager.stopApp(APP.id)).rejects.toBeInstanceOf(DeploymentInProgressError);
    await expect(f.manager.restartIfRunning(APP)).rejects.toBeInstanceOf(DeploymentInProgressError);
    await expect(f.manager.stopForDeletion(APP.id)).rejects.toBeInstanceOf(
      DeploymentInProgressError,
    );
    await expect(f.manager.stopAll()).rejects.toBeInstanceOf(DeploymentInProgressError);

    expect(runtime.deleted).toEqual([]);
    const deleting = f.db.prepare("SELECT deleting FROM apps WHERE id = ?").get(APP.id) as {
      deleting: number;
    };
    expect(deleting.deleting).toBe(0);
    expect(f.manager.isRunning(APP.id)).toBe(true);
  });

  it("runs an operation that passed its guard before the lock to completion", async () => {
    class GatedRuntime extends FakeAgentRuntime {
      readonly entered = deferred<void>();
      readonly gate = deferred<void>();

      override async ensure(
        spec: Parameters<FakeAgentRuntime["ensure"]>[0],
      ): ReturnType<FakeAgentRuntime["ensure"]> {
        this.entered.resolve();
        await this.gate.promise;
        return super.ensure(spec);
      }
    }

    const runtime = new GatedRuntime(() => "http://127.0.0.1:4102");
    const activity = new LifecycleActivity();
    const f = fixture(
      runtime,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { lifecycleActivity: activity },
    );
    const pending = f.manager.ensure(APP);
    await runtime.entered.promise;
    expect(activity.count).toBe(1);

    runtime.gate.resolve();
    await expect(pending).resolves.toBe("http://127.0.0.1:4102");
    expect(activity.count).toBe(0);
    expect(runtime.ensured).toHaveLength(1);
    expect(runtime.deleted).toEqual([]);
    expect(f.manager.isRunning(APP.id)).toBe(true);
  });

  it("keeps one activity span across a restart's stop and start", async () => {
    class SecondCallGate extends FakeAgentRuntime {
      calls = 0;
      readonly entered = deferred<void>();
      readonly gate = deferred<void>();

      override async ensure(
        spec: Parameters<FakeAgentRuntime["ensure"]>[0],
      ): ReturnType<FakeAgentRuntime["ensure"]> {
        this.calls += 1;
        if (this.calls === 2) {
          this.entered.resolve();
          await this.gate.promise;
        }
        return super.ensure(spec);
      }
    }

    const runtime = new SecondCallGate(() => "http://127.0.0.1:4103");
    const activity = new LifecycleActivity();
    const f = fixture(
      runtime,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { lifecycleActivity: activity },
    );
    await f.manager.ensure(APP);
    const pending = f.manager.restartIfRunning(APP);
    await runtime.entered.promise;
    expect(activity.count).toBe(1);
    expect(runtime.deleted).toEqual([APP.id]);
    runtime.gate.resolve();
    await expect(pending).resolves.toBe(true);
    expect(activity.count).toBe(0);
  });
});

describe("InstanceManager restart claims", () => {
  it("accepts exactly one same-tick async claim", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4300");
    const f = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await f.manager.ensure(APP);

    const first = f.manager.beginRestart(APP);
    const second = f.manager.beginRestart(APP);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.completion).toBeUndefined();

    await expect(first.completion).resolves.toBe(true);
    expect(f.manager.isRestarting(APP.id)).toBe(false);
    expect(runtime.ensured).toHaveLength(2);
  });

  it("rejects a synchronous restart while an async claim is held", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4301");
    const f = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await f.manager.ensure(APP);

    const claim = f.manager.beginRestart(APP);
    expect(claim.accepted).toBe(true);
    await expect(f.manager.restartIfRunning(APP)).rejects.toBeInstanceOf(RestartInProgressError);
    await expect(claim.completion).resolves.toBe(true);
    expect(f.manager.isRestarting(APP.id)).toBe(false);
  });

  it("returns before a slow async restart completes and releases the claim", async () => {
    class SlowRuntime extends FakeAgentRuntime {
      calls = 0;
      readonly entered = deferred<void>();
      readonly gate = deferred<void>();

      override async ensure(
        spec: Parameters<FakeAgentRuntime["ensure"]>[0],
      ): ReturnType<FakeAgentRuntime["ensure"]> {
        this.calls += 1;
        if (this.calls === 2) {
          this.entered.resolve();
          await this.gate.promise;
        }
        return super.ensure(spec);
      }
    }

    const runtime = new SlowRuntime(() => "http://127.0.0.1:4302");
    const f = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await f.manager.ensure(APP);

    const claim = f.manager.beginRestart(APP);
    expect(claim.accepted).toBe(true);
    await runtime.entered.promise;
    expect(f.manager.isRestarting(APP.id)).toBe(true);

    runtime.gate.resolve();
    await expect(claim.completion).resolves.toBe(true);
    expect(f.manager.isRestarting(APP.id)).toBe(false);
  });

  it("releases the claim when a restart fails", async () => {
    class FailingRestartRuntime extends FakeAgentRuntime {
      calls = 0;

      override async ensure(
        spec: Parameters<FakeAgentRuntime["ensure"]>[0],
      ): ReturnType<FakeAgentRuntime["ensure"]> {
        this.calls += 1;
        if (this.calls === 2) {
          throw new Error("start failed");
        }
        return super.ensure(spec);
      }
    }

    const runtime = new FailingRestartRuntime(() => "http://127.0.0.1:4303");
    const f = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await f.manager.ensure(APP);

    await expect(f.manager.restartIfRunning(APP)).rejects.toThrow("start failed");
    expect(f.manager.isRestarting(APP.id)).toBe(false);
  });

  it("completes a restart that passed its guard before a lock appeared", async () => {
    class GatedRuntime extends FakeAgentRuntime {
      calls = 0;
      readonly entered = deferred<void>();
      readonly gate = deferred<void>();

      override async ensure(
        spec: Parameters<FakeAgentRuntime["ensure"]>[0],
      ): ReturnType<FakeAgentRuntime["ensure"]> {
        this.calls += 1;
        if (this.calls === 2) {
          this.entered.resolve();
          await this.gate.promise;
        }
        return super.ensure(spec);
      }
    }

    const lockDir = mkdtempSync(path.join(tmpdir(), "hanse-manager-restart-lock-"));
    dirs.push(lockDir);
    const lockPath = path.join(lockDir, "deploy.lock");
    const runtime = new GatedRuntime(() => "http://127.0.0.1:4304");
    const f = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { deploymentLock: new DeploymentLock(lockPath), lifecycleActivity: new LifecycleActivity() },
    );
    await f.manager.ensure(APP);

    const pending = f.manager.restartIfRunning(APP);
    await runtime.entered.promise;
    const now = new Date();
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        id: "lock-1",
        phase: "switching",
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
      "utf8",
    );
    runtime.gate.resolve();

    await expect(pending).resolves.toBe(true);
    expect(runtime.ensured).toHaveLength(2);
  });

  it("keeps a 202 claim in memory only (process-exit limitation)", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4305");
    const f = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await f.manager.ensure(APP);

    const claim = f.manager.beginRestart(APP);
    expect(claim.accepted).toBe(true);
    expect(f.manager.isRestarting(APP.id)).toBe(true);

    // A replacement process has its own in-memory claim map; a 202 claim does not survive an exit.
    const replacement = new InstanceManager(f.db, f.dir, {
      runtime,
      verify: async () => [],
      workspaceRoot: "/srv",
    });
    expect(replacement.isRestarting(APP.id)).toBe(false);

    await claim.completion;
  });
});

describe("InstanceManager attachments policy and runner marker", () => {
  it("pre-creates the attachments root, passes credential denies, and marks the runner bind", async () => {
    const runtime = new FakeAgentRuntime();
    let denyPatterns: string[] = [];
    const { manager, dir } = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async (options) => {
        denyPatterns = options.denyPatterns;
        return [];
      },
      { hostWorkspace: "/srv", hostAgents: "/agents", workspaceRoot: "/srv" },
    );
    await manager.ensure(APP);
    expect(runtime.ensured[0]?.attachmentsReadOnly).toBe(true);
    expect(manager.attachmentsPathMode()).toBe("host");
    expect(manager.containerAgentsRoot()).toBe("/data/agents");
    expect(manager.attachmentVisibleRoot({ projectId: "p", appKey: "web" })).toBe(
      "/data/agents/p/web/attachments",
    );
    const appRoot = path.join(dir, "p", "web");
    expect(denyPatterns).toEqual(
      credentialDenyPatterns({
        appRoot,
        home: path.join(appRoot, "home"),
        xdgDataHome: path.join(appRoot, "data"),
        passwordFile: path.join(appRoot, "state", "opencode-password"),
      }),
    );
    expect(existsSync(path.join(dir, "p", "web", "attachments"))).toBe(true);
  });
});
