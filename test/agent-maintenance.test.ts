import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentMaintenanceScheduler,
  type MaintenanceActivitySource,
  type MaintenanceConfig,
  type MaintenanceImageSource,
  type MaintenanceManager,
  type MaintenanceReport,
} from "../src/coordinator/agent-maintenance.js";
import type { ImagePullReport } from "../src/images/service.js";
import type { LaunchSnapshot } from "../src/opencode/launch.js";
import type { ManagedApp } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const START = Date.parse("2026-11-11T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

function at(ms: number): string {
  return new Date(ms).toISOString();
}

function report(ok = true): ImagePullReport {
  return {
    ok,
    startedAt: at(START),
    finishedAt: at(START),
    durationMs: 0,
    attempts: [],
    truncated: false,
  };
}

class FakeManager implements MaintenanceManager {
  readonly restarting = new Set<string>();
  readonly launching = new Set<string>();
  readonly building = new Set<string>();
  readonly pending = new Map<string, { pending: boolean; reasons: string[] }>();
  readonly fingerprints = new Map<string, string>();
  readonly stopCalls: Array<{
    appId: string;
    options: Parameters<MaintenanceManager["stopApp"]>[1];
  }> = [];
  readonly restartCalls: Array<{
    app: ManagedApp;
    options: Parameters<MaintenanceManager["restartIfRunning"]>[1];
  }> = [];
  stopResult = true;
  restartResult = true;
  stopError: unknown;
  restartError: unknown;

  isRestarting(appId: string): boolean {
    return this.restarting.has(appId);
  }

  isLaunching(appId: string): boolean {
    return this.launching.has(appId);
  }

  async isBuilding(appId: string): Promise<boolean> {
    return this.building.has(appId);
  }

  launchSnapshot(app: ManagedApp): LaunchSnapshot {
    return {
      fingerprint: this.fingerprints.get(app.id) ?? `fp:${app.id}`,
    } as unknown as LaunchSnapshot;
  }

  launchFingerprint(snapshot: LaunchSnapshot): string {
    return (snapshot as unknown as { fingerprint: string }).fingerprint;
  }

  pendingRestart(appId: string): { pending: boolean; reasons: string[] } {
    return this.pending.get(appId) ?? { pending: false, reasons: [] };
  }

  async stopApp(
    appId: string,
    options: Parameters<MaintenanceManager["stopApp"]>[1],
  ): Promise<boolean> {
    this.stopCalls.push({ appId, options });
    if (options.guard !== undefined && !(await options.guard())) {
      return false;
    }
    if (this.stopError !== undefined) {
      throw this.stopError;
    }
    return this.stopResult;
  }

  async restartIfRunning(
    app: ManagedApp,
    options: Parameters<MaintenanceManager["restartIfRunning"]>[1],
  ): Promise<boolean> {
    this.restartCalls.push({ app, options });
    if (options.guard !== undefined && !(await options.guard())) {
      return false;
    }
    if (this.restartError !== undefined) {
      throw this.restartError;
    }
    return this.restartResult;
  }
}

interface ImageState {
  state: string;
  targetImageId: string | null;
  appliedImageId: string | null;
}

class FakeImages implements MaintenanceImageSource {
  readonly states = new Map<string, ImageState>();
  pullCalls = 0;
  pullSignal: AbortSignal | undefined;
  pullBody:
    | ((options: { signal?: AbortSignal; isDraining?: () => boolean }) => Promise<ImagePullReport>)
    | undefined;

  async imageState(appId: string): Promise<ImageState> {
    return (
      this.states.get(appId) ?? { state: "current", targetImageId: null, appliedImageId: null }
    );
  }

  async pullConfigured(
    options: { signal?: AbortSignal; isDraining?: () => boolean } = {},
  ): Promise<ImagePullReport> {
    this.pullCalls += 1;
    this.pullSignal = options.signal;
    return this.pullBody === undefined ? report() : this.pullBody(options);
  }

  set(appId: string, state: ImageState): void {
    this.states.set(appId, state);
  }
}

class FakeActivity implements MaintenanceActivitySource {
  readonly active = new Set<string>();
  calls = 0;
  onIsActive: ((appId: string) => boolean | Promise<boolean>) | undefined;

  async isActive(appId: string): Promise<boolean> {
    this.calls += 1;
    if (this.onIsActive !== undefined) {
      return await this.onIsActive(appId);
    }
    return this.active.has(appId);
  }

  lastActivityAt(): number | null {
    return null;
  }
}

class FakeTerminals {
  readonly active = new Set<string>();

  isActive(appId: string): boolean {
    return this.active.has(appId);
  }
}

class FakeDrain {
  draining = false;
  shuttingDown = false;

  isDraining(): boolean {
    return this.draining;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}

class FakeDeploymentLock {
  active = false;

  isActive(): boolean {
    return this.active;
  }
}

interface Harness {
  db: SqliteDatabase;
  manager: FakeManager;
  images: FakeImages;
  activity: FakeActivity;
  terminals: FakeTerminals;
  drain: FakeDrain;
  lock: FakeDeploymentLock;
  apps: Map<string, ManagedApp>;
  scheduler: AgentMaintenanceScheduler;
  now: { value: number };
}

interface SeedOptions {
  id?: string;
  projectId?: string;
  appKey?: string;
  createdAt?: number;
  lastActivityAt?: number | null;
  startedAt?: number | null;
  state?: string;
  runtimeState?: string | null;
  phase?: string | null;
  appDeleting?: 0 | 1;
  projectDeleting?: 0 | 1;
  appliedLaunchHash?: string | null;
  managed?: boolean;
}

function harness(
  options: {
    config?: Partial<MaintenanceConfig>;
    images?: boolean;
    maxConcurrent?: number;
    deadlineMs?: number;
    failureCooldownMs?: number;
  } = {},
): Harness {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const manager = new FakeManager();
  const images = new FakeImages();
  const activity = new FakeActivity();
  const terminals = new FakeTerminals();
  const drain = new FakeDrain();
  const lock = new FakeDeploymentLock();
  const apps = new Map<string, ManagedApp>();
  const now = { value: START };
  const scheduler = new AgentMaintenanceScheduler({
    db,
    manager,
    ...(options.images === false ? {} : { images }),
    activity,
    drain,
    deploymentLock: lock,
    terminalSessions: terminals,
    managedAppFor: (appId) => apps.get(appId),
    now: () => now.value,
    config: {
      autoStopMs: 2 * DAY,
      autoUpdateMs: 3 * HOUR,
      intervalMs: 300_000,
      autoPullMs: 900_000,
      ...options.config,
    },
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.failureCooldownMs === undefined
      ? {}
      : { failureCooldownMs: options.failureCooldownMs }),
  });
  return { db, manager, images, activity, terminals, drain, lock, apps, scheduler, now };
}

function seed(h: Harness, options: SeedOptions = {}): ManagedApp {
  const id = options.id ?? "p:a";
  const projectId = options.projectId ?? "p";
  const appKey = options.appKey ?? "a";
  const createdAt = at(options.createdAt ?? START - 10 * DAY);
  const project = h.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as
    | { id: string }
    | undefined;
  if (project === undefined) {
    h.db
      .prepare(
        "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at,deleting) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        projectId,
        projectId,
        "main",
        "/tmp",
        createdAt,
        createdAt,
        options.projectDeleting ?? 0,
      );
  }
  h.db
    .prepare(
      `INSERT INTO apps
         (id, project_id, app_key, path, contract, created_at, last_agent_activity_at, deleting)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      appKey,
      `apps/${appKey}`,
      "AGENTS.md",
      createdAt,
      options.lastActivityAt === null ? null : at(options.lastActivityAt ?? START - 3 * DAY),
      options.appDeleting ?? 0,
    );
  h.db
    .prepare(
      `INSERT INTO instances
         (id, app_id, state, runtime_state, process_phase, started_at, updated_at, applied_launch_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      id,
      options.state ?? "running",
      options.runtimeState === undefined ? (options.state ?? "running") : options.runtimeState,
      options.phase === undefined ? "ready" : options.phase,
      options.startedAt === null ? null : at(options.startedAt ?? START - 3 * DAY),
      at(START),
      options.appliedLaunchHash === undefined
        ? (h.manager.fingerprints.get(id) ?? `fp:${id}`)
        : options.appliedLaunchHash,
    );
  const app: ManagedApp = {
    id,
    projectId,
    appKey,
    appDir: `/tmp/${appKey}`,
    imageStatus: "ready",
    imageRef: null,
    instructions: [],
    sharedInstructions: [],
  };
  h.manager.fingerprints.set(id, `fp:${id}`);
  if (options.managed !== false) {
    h.apps.set(id, app);
  }
  return app;
}

function restartReady(h: Harness, appId = "p:a"): void {
  h.images.set(appId, {
    state: "restart_required",
    targetImageId: "sha256:new",
    appliedImageId: "sha256:old",
  });
}

function reasons(report: MaintenanceReport): Array<{ appId: string; reason: string }> {
  return report.skipped;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AgentMaintenanceScheduler idle pass", () => {
  it("uses MAX(last activity, start, created) so a recent start protects the app", async () => {
    const h = harness();
    seed(h, { lastActivityAt: START - 10 * DAY, startedAt: START - 60_000 });
    const result = await h.scheduler.runOnce();
    expect(result.evaluated).toBe(0);
    expect(h.manager.stopCalls).toHaveLength(0);
    expect(h.manager.restartCalls).toHaveLength(0);
  });

  it("stops an idle app through system/auto_stop and audits it", async () => {
    const h = harness();
    seed(h, { lastActivityAt: START - 3 * DAY });
    h.manager.pending.set("p:a", { pending: true, reasons: ["settings_changed"] });
    const result = await h.scheduler.runOnce();
    expect(result.stopped).toEqual(["p:a"]);
    expect(result.updated).toEqual([]);
    expect(h.manager.stopCalls).toHaveLength(1);
    expect(h.manager.stopCalls[0]?.options).toMatchObject({
      source: "system",
      reason: "auto_stop",
    });
    const event = h.db
      .prepare("SELECT payload FROM events WHERE type = 'app.auto_stopped'")
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      appId: "p:a",
      pendingRestartReasons: ["settings_changed"],
    });
  });

  it("stops instead of updating when both thresholds are due", async () => {
    const h = harness();
    seed(h, { lastActivityAt: START - 3 * DAY });
    restartReady(h);
    const result = await h.scheduler.runOnce();
    expect(result.stopped).toEqual(["p:a"]);
    expect(result.updated).toEqual([]);
    expect(h.manager.stopCalls).toHaveLength(1);
    expect(h.manager.restartCalls).toHaveLength(0);
  });

  it("auto-updates only with restart_required, an unchanged fingerprint, and a pinned image", async () => {
    const h = harness();
    seed(h, { lastActivityAt: START - 4 * HOUR });
    restartReady(h);
    const result = await h.scheduler.runOnce();
    expect(result.updated).toEqual(["p:a"]);
    expect(result.stopped).toEqual([]);
    expect(h.manager.restartCalls).toHaveLength(1);
    expect(h.manager.restartCalls[0]?.options).toMatchObject({
      source: "system",
      reason: "auto_update",
      expectedLaunchFingerprint: "fp:p:a",
      expectedImageId: "sha256:new",
    });
    const event = h.db
      .prepare("SELECT payload FROM events WHERE type = 'app.auto_updated'")
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      appId: "p:a",
      previousImageId: "sha256:old",
      imageId: "sha256:new",
    });
  });

  it("skips auto-update while pending configuration would be applied", async () => {
    const h = harness();
    seed(h, { lastActivityAt: START - 4 * HOUR });
    restartReady(h);
    h.manager.pending.set("p:a", { pending: true, reasons: ["skills_changed"] });
    const result = await h.scheduler.runOnce();
    expect(result.updated).toEqual([]);
    expect(h.manager.restartCalls).toHaveLength(0);
    expect(reasons(result)).toContainEqual({ appId: "p:a", reason: "configuration_changed" });
  });

  it("skips auto-update when the launch fingerprint differs", async () => {
    const h = harness();
    seed(h, { appliedLaunchHash: "fp:older", lastActivityAt: START - 4 * HOUR });
    restartReady(h);
    const result = await h.scheduler.runOnce();
    expect(result.updated).toEqual([]);
    expect(h.manager.restartCalls).toHaveLength(0);
    expect(reasons(result)).toContainEqual({ appId: "p:a", reason: "configuration_changed" });
  });

  it("skips auto-update without a pinned target image", async () => {
    const h = harness();
    seed(h, { lastActivityAt: START - 4 * HOUR });
    h.images.set("p:a", {
      state: "restart_required",
      targetImageId: null,
      appliedImageId: "sha256:old",
    });
    const result = await h.scheduler.runOnce();
    expect(h.manager.restartCalls).toHaveLength(0);
    expect(reasons(result)).toContainEqual({ appId: "p:a", reason: "image_changed" });
  });

  it("skips each non-actionable candidate with its reason", async () => {
    const h = harness({ config: { autoStopMs: 0 } });
    for (const state of ["rebuild_required", "build_error", "not_ready", "unknown", "current"]) {
      const id = `p:${state}`;
      seed(h, { id, appKey: state });
      h.images.set(id, { state, targetImageId: "sha256:new", appliedImageId: "sha256:old" });
    }
    seed(h, { id: "p:building", appKey: "building" });
    h.manager.building.add("p:building");
    seed(h, { id: "p:transition", appKey: "transition" });
    h.manager.restarting.add("p:transition");
    seed(h, { id: "p:unknown-app", appKey: "unknown-app", managed: false });
    h.images.set("p:unknown-app", {
      state: "restart_required",
      targetImageId: "sha256:new",
      appliedImageId: "sha256:old",
    });
    seed(h, {
      id: "hanse-master:master",
      projectId: "hanse-master",
      appKey: "master",
    });
    h.images.set("hanse-master:master", {
      state: "restart_required",
      targetImageId: "sha256:new",
      appliedImageId: "sha256:old",
    });
    const result = await h.scheduler.runOnce();
    const skipped = reasons(result);
    for (const [appId, reason] of [
      ["p:rebuild_required", "rebuild_required"],
      ["p:build_error", "build_error"],
      ["p:not_ready", "not_ready"],
      ["p:unknown", "unknown"],
      ["p:current", "current"],
      ["p:building", "building"],
      ["p:transition", "transitioning"],
      ["p:unknown-app", "unknown"],
      ["hanse-master:master", "master"],
    ] as const) {
      expect(skipped).toContainEqual({ appId, reason });
    }
    expect(h.manager.restartCalls).toHaveLength(0);
  });

  it("excludes deleting apps and projects from the candidate query", async () => {
    const h = harness({ config: { autoStopMs: 0 } });
    seed(h, { id: "p:deleting", appKey: "deleting", appDeleting: 1 });
    restartReady(h, "p:deleting");
    seed(h, { id: "q:live", projectId: "q", appKey: "live", projectDeleting: 1 });
    restartReady(h, "q:live");
    const result = await h.scheduler.runOnce();
    expect(result.evaluated).toBe(0);
    expect(h.manager.stopCalls).toHaveLength(0);
    expect(h.manager.restartCalls).toHaveLength(0);
  });

  it("skips when draining, shutting down, deployment-locked, or a terminal is active", async () => {
    const h = harness();
    seed(h);
    h.drain.draining = true;
    expect((await h.scheduler.runOnce()).evaluated).toBe(0);
    h.drain.draining = false;
    h.drain.shuttingDown = true;
    expect((await h.scheduler.runOnce()).evaluated).toBe(0);
    h.drain.shuttingDown = false;
    h.lock.active = true;
    const locked = await h.scheduler.runOnce();
    expect(reasons(locked)).toContainEqual({ appId: "p:a", reason: "deployment_locked" });
    h.lock.active = false;
    h.terminals.active.add("p:a");
    const terminal = await h.scheduler.runOnce();
    expect(reasons(terminal)).toContainEqual({ appId: "p:a", reason: "terminal" });
    expect(h.manager.stopCalls).toHaveLength(0);
  });

  it("keeps auto-stop when no image service is configured", async () => {
    const h = harness({ images: false });
    seed(h, { lastActivityAt: START - 3 * DAY });
    const result = await h.scheduler.runOnce();
    expect(result.stopped).toEqual(["p:a"]);
    expect(h.manager.stopCalls).toHaveLength(1);
  });

  it("skips auto-update when no image service is configured", async () => {
    const h = harness({ images: false, config: { autoStopMs: 0 } });
    seed(h);
    const result = await h.scheduler.runOnce();
    expect(result.updated).toEqual([]);
    expect(reasons(result)).toContainEqual({ appId: "p:a", reason: "images_unavailable" });
  });

  it("bounds per-app concurrency", async () => {
    const h = harness({ config: { autoStopMs: 1, autoUpdateMs: 0 }, maxConcurrent: 2 });
    for (let index = 0; index < 6; index += 1) {
      seed(h, { id: `p:a${index}`, appKey: `a${index}`, lastActivityAt: START - HOUR });
    }
    let inFlight = 0;
    let peak = 0;
    h.activity.onIsActive = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return false;
    };
    const result = await h.scheduler.runOnce();
    expect(result.stopped).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it("stops scheduling new apps after the pass deadline", async () => {
    const h = harness({
      config: { autoStopMs: 1, autoUpdateMs: 0 },
      maxConcurrent: 1,
      deadlineMs: 100,
    });
    for (let index = 0; index < 5; index += 1) {
      seed(h, { id: `p:a${index}`, appKey: `a${index}`, lastActivityAt: START - HOUR });
    }
    h.activity.onIsActive = () => {
      h.now.value += 60;
      return false;
    };
    const result = await h.scheduler.runOnce();
    expect(result.stopped).toHaveLength(1);
    expect(result.skipped.filter((skip) => skip.reason === "deadline")).toHaveLength(4);
  });

  it("returns before a hung per-app check exceeds the pass deadline", async () => {
    const h = harness({
      config: { autoStopMs: 1, autoUpdateMs: 0 },
      maxConcurrent: 1,
      deadlineMs: 25,
    });
    seed(h, { lastActivityAt: START - HOUR });
    h.activity.onIsActive = () => new Promise<boolean>(() => {});
    const result = await h.scheduler.runOnce();
    expect(result.skipped).toContainEqual({ appId: "p:a", reason: "deadline" });
    expect(h.manager.stopCalls).toHaveLength(0);
  });

  it("applies a one-hour failure cooldown per app", async () => {
    const h = harness({
      config: { autoStopMs: 1, autoUpdateMs: 0 },
      failureCooldownMs: 1_000,
    });
    seed(h, { lastActivityAt: START - HOUR });
    h.manager.stopError = new Error("delete failed");
    const first = await h.scheduler.runOnce();
    expect(first.skipped).toContainEqual({ appId: "p:a", reason: "error" });
    const second = await h.scheduler.runOnce();
    expect(second.skipped).toContainEqual({ appId: "p:a", reason: "cooldown" });
    expect(h.manager.stopCalls).toHaveLength(1);
  });
});

describe("AgentMaintenanceScheduler pull pass", () => {
  it("pulls on its timer pass and logs failures without stopping the idle timer", async () => {
    const h = harness();
    h.images.pullBody = async () => report(false);
    const result = await h.scheduler.runPullOnce();
    expect(result?.ok).toBe(false);
    expect(h.images.pullCalls).toBe(1);
  });

  it("shares one single-flight guard between idle and pull passes", async () => {
    const h = harness({ config: { autoStopMs: 1, autoUpdateMs: 0 } });
    seed(h, { lastActivityAt: START - HOUR });
    const gate = deferred<boolean>();
    h.activity.onIsActive = async () => gate.promise;
    const idle = h.scheduler.runOnce();
    await flush();
    await expect(h.scheduler.runPullOnce()).resolves.toBeUndefined();
    expect(h.images.pullCalls).toBe(0);
    gate.resolve(false);
    await idle;
  });

  it("does not start an idle pass while a pull is in flight", async () => {
    const h = harness({ config: { autoStopMs: 1, autoUpdateMs: 0 } });
    seed(h, { lastActivityAt: START - HOUR });
    const gate = deferred<ImagePullReport>();
    h.images.pullBody = async () => gate.promise;
    const pull = h.scheduler.runPullOnce();
    await flush();
    const idle = await h.scheduler.runOnce();
    expect(idle.evaluated).toBe(0);
    expect(h.manager.stopCalls).toHaveLength(0);
    gate.resolve(report());
    await pull;
  });

  it("stop() aborts an in-flight pull", async () => {
    const h = harness();
    const gate = deferred<ImagePullReport>();
    h.images.pullBody = async ({ signal }) => {
      if (signal !== undefined) {
        signal.addEventListener(
          "abort",
          () => {
            gate.resolve(report(false));
          },
          { once: true },
        );
      }
      return gate.promise;
    };
    const pull = h.scheduler.runPullOnce();
    await flush();
    const signal = h.images.pullSignal;
    expect(signal?.aborted).toBe(false);
    h.scheduler.stop();
    await pull;
    expect(signal?.aborted).toBe(true);
  });

  it("does not pull when the pull timer is disabled", async () => {
    const h = harness({ config: { autoPullMs: 0 } });
    await expect(h.scheduler.runPullOnce()).resolves.toBeUndefined();
    expect(h.images.pullCalls).toBe(0);
  });

  it("creates unref'ed timers and clears them on stop", () => {
    const h = harness();
    const unref = vi.fn();
    const interval = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((() => ({ unref })) as unknown as typeof setInterval);
    h.scheduler.start();
    expect(interval).toHaveBeenCalledTimes(2);
    expect(unref).toHaveBeenCalledTimes(2);
    h.scheduler.stop();
    interval.mockRestore();
  });
});
