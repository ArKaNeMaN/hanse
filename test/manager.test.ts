import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSpecHash } from "../src/agent/spec.js";
import { verifyAgentToken } from "../src/mcp/agent-tokens.js";
import { authorizationFor, setEndpointAuthorization } from "../src/opencode/endpoint-auth.js";
import {
  InstanceManager,
  type ManagedApp,
  type OmoProfileSource,
  type SettingsSource,
  verifyAgentModels,
} from "../src/opencode/manager.js";
import type { OmoProfileInput, OmoProfileResult } from "../src/opencode/omo-profile.js";
import type { VerifyPolicyOptions } from "../src/opencode/policy.js";
import type {
  EffectiveSettings,
  EffectiveValue,
  LaunchSettingsSnapshot,
} from "../src/settings/types.js";
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
}

function fakeSettings(
  options: { model?: string; search?: WebToolConfig | null } = {},
): FakeSettings {
  let model = options.model ?? "deepseek/deepseek-flash";
  let search: WebToolConfig | null = options.search ?? { driver: "builtin" };
  return {
    setModel(next) {
      model = next;
    },
    setSearch(next) {
      search = next;
    },
    snapshot: (_target): LaunchSettingsSnapshot => {
      const effective: EffectiveSettings = {
        llm: { model: value(model) },
        web: { search: value(search), fetch: value({ driver: "builtin" }) },
      };
      return {
        resolved: { effective, scoped: {}, providerKeys: {}, warnings: [] },
        mergedAuth: { deepseek: { type: "api", key: "sk-test" } },
        authHash: "auth-hash",
        providerKeys: new Map(),
      };
    },
  };
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
  const manager = new InstanceManager(db, dir, {
    runtime,
    verify,
    settings,
    omoProfiles: profiles,
    modelVerifier,
    workspaceRoot: "/srv",
  });
  return { manager, runtime, db, dir };
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

  it("recreates a running instance when the token file no longer matches", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const firstEndpoint = await manager.ensure(APP);

    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const previousToken = readFileSync(tokenFile, "utf8");
    writeFileSync(tokenFile, "tampered-token", { mode: 0o600 });

    const endpoint = await manager.ensure(APP);

    expect(endpoint).toBe(firstEndpoint);
    expect(runtime.ensured).toHaveLength(2);
    expect(runtime.deleted).toEqual([APP.id]);
    const token = readFileSync(tokenFile, "utf8");
    expect(token).not.toBe(previousToken);
    expect(verifyAgentToken(db, previousToken)).toBeUndefined();
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(manager.isRunning(APP.id)).toBe(true);
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
