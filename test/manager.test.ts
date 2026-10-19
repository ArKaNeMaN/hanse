import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { endpointFor, type LaunchInput, type RunningInstance } from "../src/opencode/launcher.js";
import {
  InstanceManager,
  type ManagedApp,
  type OmoProfileSource,
  type SettingsSource,
  verifyAgentModels,
} from "../src/opencode/manager.js";
import type { OmoProfileInput, OmoProfileResult } from "../src/opencode/omo-profile.js";
import type {
  EffectiveSettings,
  EffectiveValue,
  LaunchSettingsSnapshot,
} from "../src/settings/types.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import type { WebToolConfig } from "../src/web/types.js";

const dirs: string[] = [];
const servers: Server[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
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

class FakeProcess extends EventEmitter {
  readonly pid = 4242;
  readonly signals: string[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  ignoreTerm = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) {
      return true;
    }
    this.exitCode = signal === "SIGKILL" ? null : 0;
    this.signalCode = signal;
    this.emit("exit", this.exitCode, signal);
    return true;
  }
}

interface Harness {
  inputs: LaunchInput[];
  processes: FakeProcess[];
  launch: (db: SqliteDatabase, input: LaunchInput) => RunningInstance;
}

function createHarness(options: { ignoreTerm?: boolean } = {}): Harness {
  const harness: Harness = {
    inputs: [],
    processes: [],
    launch: () => {
      throw new Error("harness not initialized");
    },
  };
  harness.launch = (_db, input) => {
    harness.inputs.push(input);
    const server = createServer((_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end("[]");
    });
    server.listen(input.port, "127.0.0.1");
    servers.push(server);
    const fake = new FakeProcess();
    fake.ignoreTerm = options.ignoreTerm ?? false;
    fake.once("exit", () => server.close());
    harness.processes.push(fake);
    return {
      id: `run-${harness.inputs.length}`,
      appId: input.appId,
      endpoint: endpointFor("127.0.0.1", input.port),
      pid: fake.pid,
      bootId: "boot",
      process: fake as unknown as ChildProcess,
    };
  };
  return harness;
}

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
  previews: OmoProfileInput[];
}

function fakeProfiles(
  options: { applied?: boolean; warning?: string; contentHash?: string } = {},
): FakeProfiles {
  const ensures: OmoProfileInput[] = [];
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
    previews,
    source: {
      ensure: async (input) => {
        ensures.push(input);
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
  db: SqliteDatabase;
  dir: string;
}

function fixture(
  harness: Harness,
  settings?: SettingsSource,
  profiles?: OmoProfileSource,
  stopTimeoutMs = 50,
  modelVerifier?: (endpoint: string, expected: string) => Promise<string[]>,
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
  const manager = new InstanceManager(db, path.join(dir, "coordinator.db"), dir, {
    launch: harness.launch,
    verify: async () => [],
    settings,
    omoProfiles: profiles,
    stopTimeoutMs,
    modelVerifier,
    portBase: 5400,
  });
  return { manager, db, dir };
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
  it("single-flights concurrent ensure calls for one app", async () => {
    const harness = createHarness();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager } = fixture(harness, settings, profiles.source);

    const [first, second] = await Promise.all([manager.ensure(APP), manager.ensure(APP)]);

    expect(harness.inputs).toHaveLength(1);
    expect(first).toBe(second);
    expect(manager.isRunning(APP.id)).toBe(true);
    expect(harness.inputs[0]?.model).toBe("deepseek/deepseek-flash");
    expect(harness.inputs[0]?.auth).toEqual({
      deepseek: { type: "api", key: "sk-test" },
    });
    expect(harness.inputs[0]?.omoProfile).toBe("hanse-app-test");
    expect(profiles.ensures).toHaveLength(1);
  });

  it("waits for an in-flight launch before restarting", async () => {
    const harness = createHarness();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const gate = deferred<void>();
    let verifyStarted = false;
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
    const manager = new InstanceManager(db, path.join(dir, "coordinator.db"), dir, {
      launch: harness.launch,
      verify: async () => {
        verifyStarted = true;
        await gate.promise;
        return [];
      },
      settings,
      omoProfiles: profiles.source,
      stopTimeoutMs: 50,
      portBase: 5400,
    });

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
    expect(harness.processes[0]?.signalCode).toBe("SIGTERM");
  });

  it("treats a signal-terminated child as not running", async () => {
    const harness = createHarness();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager } = fixture(harness, settings, profiles.source);
    await manager.ensure(APP);

    const process = harness.processes[0];
    if (process === undefined) throw new Error("missing fake process");
    process.signalCode = "SIGTERM";

    expect(manager.isRunning(APP.id)).toBe(false);
    await expect(manager.stopApp(APP.id)).resolves.toBe(false);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("sends SIGKILL after the stop timeout", async () => {
    const harness = createHarness({ ignoreTerm: true });
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager } = fixture(harness, settings, profiles.source, 20);
    await manager.ensure(APP);

    await expect(manager.stopApp(APP.id)).resolves.toBe(true);

    const process = harness.processes[0];
    if (process === undefined) throw new Error("missing fake process");
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(process.signalCode).toBe("SIGKILL");
    expect(manager.isRunning(APP.id)).toBe(false);
  });

  it("reports settings_changed when the snapshot hash changes", async () => {
    const harness = createHarness();
    const settings = fakeSettings({ model: "deepseek/deepseek-flash" });
    const profiles = fakeProfiles();
    const { manager } = fixture(harness, settings, profiles.source);
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
    expect(harness.inputs[1]?.model).toBe("deepseek/deepseek-pro");
  });

  it("reports profile_not_applied when the profile write failed", async () => {
    const harness = createHarness();
    const settings = fakeSettings();
    const profiles = fakeProfiles({
      applied: false,
      warning: "omo_profile_unavailable: parse failure",
    });
    const { manager } = fixture(harness, settings, profiles.source);

    await manager.ensure(APP);

    expect(harness.inputs[0]?.omoProfile).toBeUndefined();
    expect(manager.profileWarnings(APP.id)).toEqual(["omo_profile_unavailable: parse failure"]);
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["profile_not_applied"],
    });
  });

  it("has no pending state when stopped or unknown", async () => {
    const harness = createHarness();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager } = fixture(harness, settings, profiles.source);

    expect(manager.pendingRestart("unknown")).toEqual({ pending: false, reasons: [] });
    await manager.ensure(APP);
    await manager.stopApp(APP.id);

    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("registers hanse_web and disables OMO websearch for managed search", async () => {
    const harness = createHarness();
    const settings = fakeSettings({
      search: { driver: "deepseek", options: { provider: "deepseek" } },
    });
    const profiles = fakeProfiles();
    const { manager, dir } = fixture(harness, settings, profiles.source);

    await manager.ensure(APP);

    const input = harness.inputs[0];
    if (input === undefined) throw new Error("missing launch input");
    expect(input.mcpServers?.hanse_web?.command).toEqual([
      process.execPath,
      process.argv[1] ?? "",
      "web-mcp",
    ]);
    expect(input.mcpServers?.hanse_web?.environment).toEqual({
      HANSE_WEB_CONFIG: JSON.stringify({ search: { provider: "deepseek" } }),
      HANSE_OPENCODE_AUTH_FILE: path.join(
        dir,
        "projects",
        "p",
        "apps",
        "web",
        "data",
        "opencode",
        "auth.json",
      ),
    });
    expect(profiles.ensures[0]?.disableWebsearch).toBe(true);
  });

  it("keeps the existing behavior when settings and profiles are absent", async () => {
    const harness = createHarness();
    const { manager } = fixture(harness);

    await manager.ensure(APP);

    const input = harness.inputs[0];
    if (input === undefined) throw new Error("missing launch input");
    expect(input.model).toBeUndefined();
    expect(input.auth).toBeUndefined();
    expect(input.omoProfile).toBeUndefined();
    expect(input.mcpServers).toBeUndefined();
    expect(input.web).toBeUndefined();
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("records model mismatch warnings from the model verifier", async () => {
    const harness = createHarness();
    const warning =
      'model_mismatch: agent "oracle" uses deepseek/other, expected deepseek/deepseek-flash';
    const { manager } = fixture(harness, fakeSettings(), fakeProfiles().source, 50, async () => [
      warning,
    ]);

    await manager.ensure(APP);

    expect(manager.profileWarnings(APP.id)).toEqual([warning]);
  });

  it("parses /agent model mismatches", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify([
          { name: "oracle", model: { providerID: "deepseek", modelID: "other" } },
          {
            name: "explore",
            model: { providerID: "deepseek", modelID: "deepseek-flash" },
          },
        ]),
        { status: 200 },
      );

    await expect(
      verifyAgentModels("http://127.0.0.1:4100", "deepseek/deepseek-flash", fetchImpl),
    ).resolves.toEqual([
      'model_mismatch: agent "oracle" uses deepseek/other, expected deepseek/deepseek-flash',
    ]);
  });
});
