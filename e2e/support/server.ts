import { type ChildProcess, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type DeleteOptions,
  DeletionError,
  type DeletionService,
} from "../../src/coordinator/deletion.js";
import type { HandoffDispatcher } from "../../src/coordinator/dispatcher.js";
import { getHandoff, updateHandoff } from "../../src/coordinator/handoff.js";
import { CoordinatorService } from "../../src/coordinator/service.js";
import { GitService } from "../../src/git/service.js";
import type { HttpDeps } from "../../src/http/handler.js";
import { createHttpServer } from "../../src/http/server.js";
import {
  type ImageService,
  ImageServiceError,
  type ImageStateView,
} from "../../src/images/service.js";
import type { InstanceManager } from "../../src/opencode/manager.js";
import type { PreviewView } from "../../src/preview/types.js";
import { startOpencodeUpstream } from "./opencode-upstream.js";
import { E2E_CHAT_MESSAGES, E2E_CHAT_SESSIONS, seed } from "./seed.js";

const port = Number(process.env.HANSE_E2E_PORT ?? 4310);
const mode = process.env.HANSE_E2E_MODE === "legacy" ? "legacy" : "spa";
if (mode === "legacy") {
  process.env.HANSE_UI_LEGACY = "1";
}

const fixtureRemotePath = path.join(tmpdir(), `hanse-e2e-git-${port}`, "remote.git");
const fixture = seed({
  ...(process.env.HANSE_E2E_DB === undefined ? {} : { dbPath: process.env.HANSE_E2E_DB }),
  ...(process.env.HANSE_E2E_TOKEN === undefined ? {} : { token: process.env.HANSE_E2E_TOKEN }),
  remotePath: fixtureRemotePath,
});
const services = new Map(
  fixture.projects.map((project) => [project.id, new CoordinatorService(fixture.db, project.id)]),
);

const fixtureReposPath = path.join(tmpdir(), `hanse-e2e-repos-${port}.json`);
const upstreamInfoPath = path.join(tmpdir(), `hanse-e2e-upstream-${port}.json`);
const appRepos = Object.fromEntries(
  fixture.projects.flatMap((project) =>
    project.appKeys.map((appKey) => [
      `${project.id}:${appKey}`,
      path.join(fixture.projectRoots[project.id] ?? "", "apps", appKey),
    ]),
  ),
);
writeFileSync(
  fixtureReposPath,
  JSON.stringify({ workspaceRoot: fixture.workspaceRoot, apps: appRepos }),
);

const FIXTURE_FINGERPRINT = "SHA256:e2e-fixture-fingerprint";
const FIXTURE_ALPHA_APP = "e2e-project-one:alpha";

/**
 * Deterministic stand-in for the SSH transport. Hosts whose address starts with `fail.` always
 * time out; every other host authenticates and pins the fixture fingerprint. Re-pin uses the real
 * service after Prepare re-pin writes the pending observation. No network or real key is used.
 */
async function fixtureTestHost(
  hostId: string,
  options: { ignorePin?: boolean } = {},
): Promise<{
  ok: boolean;
  authOk: boolean;
  code?: "ssh_connect_timeout";
  message?: string;
  fingerprint?: string;
  previousFingerprint?: string | null;
  mismatch?: boolean;
}> {
  const row = fixture.db
    .prepare(
      "SELECT name, address, host_key_fingerprint AS fingerprint FROM ssh_hosts WHERE id = ?",
    )
    .get(hostId) as { name: string; address: string; fingerprint: string | null } | undefined;
  if (row === undefined) {
    throw new Error("Host not found");
  }
  if (row.address.startsWith("fail.")) {
    return {
      ok: false,
      authOk: false,
      code: "ssh_connect_timeout",
      message: "Timed out while connecting to the test host.",
      previousFingerprint: row.fingerprint,
    };
  }
  const now = new Date().toISOString();
  if (options.ignorePin === true) {
    fixture.db
      .prepare(
        `UPDATE ssh_hosts SET pending_host_key = ?, pending_host_key_type = ?,
         pending_host_key_fingerprint = ?, pending_host_key_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEUyRUZpeHR1cmU e2e@example.test",
        "ssh-ed25519",
        FIXTURE_FINGERPRINT,
        now,
        now,
        hostId,
      );
  } else {
    fixture.db
      .prepare(
        `UPDATE ssh_hosts SET host_key = ?, host_key_type = ?, host_key_bits = ?,
         host_key_fingerprint = ?, host_key_pinned_at = ?, host_key_mismatch_at = NULL,
         updated_at = ? WHERE id = ?`,
      )
      .run(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEUyRUZpeHR1cmU e2e@example.test",
        "ssh-ed25519",
        256,
        FIXTURE_FINGERPRINT,
        now,
        now,
        hostId,
      );
  }
  return {
    ok: true,
    authOk: true,
    fingerprint: FIXTURE_FINGERPRINT,
    previousFingerprint: row.fingerprint,
    mismatch: false,
  };
}

const ssh = new Proxy(fixture.ssh, {
  get(target, property) {
    if (property === "testHost") {
      return fixtureTestHost;
    }
    const value = Reflect.get(target, property) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  },
});

function projectService(projectId: string): CoordinatorService {
  const existing = services.get(projectId);
  if (existing !== undefined) {
    return existing;
  }
  const created = new CoordinatorService(fixture.db, projectId);
  services.set(projectId, created);
  return created;
}

/**
 * The fixture never starts Docker or opencode. `createHttpServer` only calls
 * `startChatMaintenance`; the remaining methods keep page rendering deterministic.
 */
let alphaRestartPending = true;
let chatEndpoint: string | undefined;
const chatContextListeners = new Map<string, Set<(snapshot: unknown) => void>>();
const chatNoticeListeners = new Map<string, Set<(notice: unknown) => void>>();

function subscribe(
  map: Map<string, Set<(value: unknown) => void>>,
  appId: string,
  listener: (value: unknown) => void,
): () => void {
  let listeners = map.get(appId);
  if (listeners === undefined) {
    listeners = new Set();
    map.set(appId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
  };
}

function fanOut(
  map: Map<string, Set<(value: unknown) => void>>,
  appId: string,
  value: unknown,
): void {
  for (const listener of map.get(appId) ?? []) listener(value);
}

const manager = {
  startChatMaintenance() {},
  endpointFor: (appId: string) => (appId === FIXTURE_ALPHA_APP ? chatEndpoint : undefined),
  ensure: async (app: { id?: string }) => (app.id === FIXTURE_ALPHA_APP ? chatEndpoint : undefined),
  subscribeContext: (appId: string, listener: (snapshot: unknown) => void) =>
    subscribe(chatContextListeners, appId, listener),
  subscribeNotices: (appId: string, listener: (notice: unknown) => void) =>
    subscribe(chatNoticeListeners, appId, listener),
  pendingRestart: (appId: string) =>
    appId === FIXTURE_ALPHA_APP && alphaRestartPending
      ? { pending: true, reasons: ["settings_changed"] }
      : { pending: false, reasons: [] },
  profileWarnings: () => [],
  policyWarnings: (appId: string) =>
    appId === FIXTURE_ALPHA_APP ? ["Fixture policy warning."] : [],
  probeStatus: async () => false,
  rollbackImage: async (_app: unknown, rollback: () => Promise<unknown>) => ({
    result: await rollback(),
    restarted: false,
  }),
  isRestarting: () => false,
  isRunning: (appId: string) => appId === FIXTURE_ALPHA_APP,
  contextSnapshot: async (appId: string, sessionId: string) =>
    appId === FIXTURE_ALPHA_APP
      ? {
          sessionID: sessionId,
          state: "ready",
          used: 1000,
          limit: 2000,
          percent: 50,
          model: { providerID: "fixture", modelID: "fixture-model" },
          status: "idle",
          updatedAt: "2026-10-30T10:00:00.000Z",
          lastCompactedAt: null,
          lastError: null,
          autoCompact: {
            enabled: false,
            percent: 80,
            source: "default",
            percentSource: "default",
          },
        }
      : undefined,
  compactSession: async () => ({ accepted: true }),
  preflightRestart: async () => true,
  beginRestart: () => {
    alphaRestartPending = false;
    return { accepted: true, completion: Promise.resolve(true) };
  },
} as unknown as InstanceManager;

/**
 * Loopback opencode/runner stand-in. The control endpoint (`/__control`) advances scripted SSE
 * frames; `context.updated`/`notice.created` controls fan out through the manager subscriptions
 * because the coordinator sources those events from the manager, not the upstream feed.
 */
const upstream = await startOpencodeUpstream({
  appId: FIXTURE_ALPHA_APP,
  sessions: E2E_CHAT_SESSIONS,
  messages: E2E_CHAT_MESSAGES,
  savedPermissions: [
    {
      id: "e2e-saved-permission",
      projectID: "e2e-project-one",
      action: "bash",
      resource: "echo fixture",
    },
  ],
  todos: {
    ses_e2ealpha: [
      { content: "Fixture plan step", status: "in_progress", priority: "high" },
      { content: "Finished fixture step", status: "completed", priority: "low" },
    ],
  },
  onControl: (event) => {
    if ((event as { seedChatApprovals?: unknown }).seedChatApprovals === true) {
      const hostRow = fixture.db
        .prepare("SELECT id FROM ssh_hosts WHERE name = 'app-host'")
        .get() as { id: string } | undefined;
      if (hostRow !== undefined) {
        const insert = fixture.db.prepare(
          `INSERT OR REPLACE INTO ssh_approvals
             (id, app_id, host_id, action, command_hash, command_preview, command_bytes, status,
              requested_at, expires_at)
           VALUES (?, ?, ?, 'exec', ?, ?, ?, 'pending', ?, '2099-01-01T00:00:00.000Z')`,
        );
        const now = new Date().toISOString();
        for (const [id, preview] of [
          ["e2e-chat-ssh-approve", "echo chat approve e2e"],
          ["e2e-chat-ssh-reject", "echo chat reject e2e"],
        ] as const) {
          insert.run(
            id,
            "e2e-project-one:alpha",
            hostRow.id,
            `e2e-${id}-hash`,
            preview,
            preview.length,
            now,
          );
        }
      }
      return true;
    }
    if (typeof (event as { restartPending?: unknown }).restartPending === "boolean") {
      alphaRestartPending = (event as { restartPending: boolean }).restartPending;
      return true;
    }
    const properties =
      typeof event.properties === "object" && event.properties !== null
        ? (event.properties as Record<string, unknown>)
        : undefined;
    if (event.type === "context.updated") {
      const context = event.context ?? properties?.context;
      if (context !== undefined) {
        fanOut(chatContextListeners, FIXTURE_ALPHA_APP, context);
      }
      return true;
    }
    if (event.type === "notice.created") {
      const notice = event.notice ?? properties?.notice;
      if (notice !== undefined) {
        fanOut(chatNoticeListeners, FIXTURE_ALPHA_APP, notice);
      }
      return true;
    }
    return false;
  },
});
chatEndpoint = upstream.url;
writeFileSync(
  upstreamInfoPath,
  JSON.stringify({ url: upstream.url, port: upstream.port, streamID: upstream.streamID }),
);

/** Deterministic git remote check; no network, runner, or credential material is used. */
const git = new Proxy(new GitService({ workspaceRoot: fixture.workspaceRoot }), {
  get(target, property) {
    if (property === "testConnection") {
      return async () => ({
        ok: true,
        kind: "https",
        remote: "origin",
        refs: 2,
        head: "main",
        warnings: ["Host key is not pinned."],
      });
    }
    const value = Reflect.get(target, property) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as unknown as GitService;

interface ImageRow {
  appKey: string;
  buildConfigured: number;
  imageStatus: string;
  imageRef: string | null;
  imageHash: string | null;
  imageBuiltAt: string | null;
  imageError: string | null;
  imageBaseRef: string | null;
  imageBaseKind: string | null;
  imageBaseDigest: string | null;
  imageHashVersion: number;
  imageRollbackRef: string | null;
  imageRollbackBuiltAt: string | null;
}

function imageRow(appId: string): ImageRow {
  const row = fixture.db
    .prepare(
      `SELECT app_key AS appKey, build_configured AS buildConfigured,
         image_status AS imageStatus, image_ref AS imageRef, image_hash AS imageHash,
         image_built_at AS imageBuiltAt, image_error AS imageError,
         image_base_ref AS imageBaseRef, image_base_kind AS imageBaseKind,
         image_base_digest AS imageBaseDigest, image_hash_version AS imageHashVersion,
         (SELECT v.image_ref FROM app_image_versions v
           WHERE v.app_id = apps.id AND apps.image_ref IS NOT NULL
             AND v.image_ref <> apps.image_ref
           ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS imageRollbackRef,
         (SELECT v.built_at FROM app_image_versions v
           WHERE v.app_id = apps.id AND apps.image_ref IS NOT NULL
             AND v.image_ref <> apps.image_ref
           ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS imageRollbackBuiltAt
       FROM apps WHERE id = ?`,
    )
    .get(appId) as ImageRow | undefined;
  if (row === undefined) throw new ImageServiceError(404, "app not found", "not_found");
  return row;
}

function imageState(row: ImageRow, buildActive: boolean): ImageStateView["state"] {
  if (!row.buildConfigured) return "current";
  if (buildActive) return "building";
  if (row.imageStatus === "error") return "build_error";
  if (row.imageRef === null) return "not_ready";
  if (row.imageStatus === "stale") return "rebuild_required";
  return "current";
}

function imageView(appId: string, buildActive = false): ImageStateView {
  const row = imageRow(appId);
  const usable =
    row.buildConfigured && row.imageRef !== null && row.imageStatus !== "error"
      ? row.imageRef
      : null;
  const state = imageState(row, buildActive);
  return {
    appId,
    appKey: row.appKey,
    status: row.imageStatus as ImageStateView["status"],
    imageRef: row.imageRef,
    imageId: row.imageRef === null ? null : `sha256:${row.appKey}-image`,
    buildId: buildActive ? `e2e-build-${appId}` : null,
    hash: row.imageHash,
    currentHash: row.imageHash,
    baseDigest: row.imageBaseDigest,
    builtAt: row.imageBuiltAt,
    error: row.imageError,
    updatedAt: null,
    previousImageRef: row.imageRollbackRef,
    previousImageBuiltAt: row.imageRollbackBuiltAt,
    runnerAvailable: true,
    buildConfigured: row.buildConfigured === 1,
    state,
    running: row.appKey === "alpha",
    usableImageRef: usable,
    targetImageId: row.imageRef === null ? null : `sha256:${row.appKey}-image`,
    appliedImageId: row.imageRef === null ? null : `sha256:${row.appKey}-image`,
    hashVersion: row.imageHashVersion,
    currentBaseDigest: row.imageBaseDigest,
    baseKind: (row.imageBaseKind ?? "unknown") as ImageStateView["baseKind"],
    baseRef: row.imageBaseRef,
    baseDrift: row.imageStatus === "stale",
    hashDrift: row.imageStatus === "stale",
    blocked: row.buildConfigured === 1 && usable === null && row.imageRef === null,
    selectedImage: row.imageRef === null ? "missing" : "present",
    imageBuildId: null,
    latestBuildImageId: null,
  };
}

const buildStarted = new Map<string, number>();
const buildLogs = new Map<string, string>();
const BUILD_MS = 3_500;

function insertImageVersion(appId: string, ref: string | null, builtAt: string | null): void {
  if (ref === null) return;
  fixture.db
    .prepare(
      `INSERT OR IGNORE INTO app_image_versions
         (app_id, image_ref, image_id, built_at, created_at, hash_version)
       VALUES (?, ?, ?, ?, ?, 2)`,
    )
    .run(appId, ref, `sha256:${ref}`, builtAt, new Date().toISOString());
}

function updateImage(appId: string, fields: Record<string, string | number | null>): void {
  const keys = Object.keys(fields);
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  fixture.db
    .prepare(`UPDATE apps SET ${assignments} WHERE id = ?`)
    .run(...keys.map((key) => fields[key] ?? null), appId);
}

/** Stateful deterministic image service: build, poll, rollback, check, and logs for E2E. */
const images = {
  status: async (appId: string) => {
    const started = buildStarted.get(appId);
    if (started !== undefined) {
      if (Date.now() - started < BUILD_MS) return imageView(appId, true);
      buildStarted.delete(appId);
      const row = imageRow(appId);
      const builtAt = new Date().toISOString();
      insertImageVersion(appId, row.imageRef, row.imageBuiltAt);
      insertImageVersion(appId, `hanse-${row.appKey}:rebuilt`, builtAt);
      updateImage(appId, {
        image_status: "ready",
        image_ref: `hanse-${row.appKey}:rebuilt`,
        image_hash: `sha256:${row.appKey}-rebuilt`,
        image_built_at: builtAt,
        image_error: null,
      });
      buildLogs.set(appId, "Build complete.\n");
    }
    return imageView(appId);
  },
  build: async (appId: string, appKey?: string) => {
    const row = imageRow(appId);
    insertImageVersion(appId, row.imageRef, row.imageBuiltAt);
    updateImage(appId, {
      image_status: "building",
      image_error: null,
    });
    buildStarted.set(appId, Date.now());
    buildLogs.set(appId, "Building fixture image...\nStep 1/2: context loaded\n");
    return {
      appId,
      appKey: appKey ?? row.appKey,
      status: "building",
      imageRef: row.imageRef,
      buildId: `e2e-build-${appId}`,
    };
  },
  rollback: async (appId: string, appKey?: string) => {
    const row = imageRow(appId);
    if (row.imageRollbackRef === null) {
      throw new ImageServiceError(409, "no previous image to roll back to", "no_rollback");
    }
    const previous = row.imageRollbackRef;
    insertImageVersion(appId, row.imageRef, row.imageBuiltAt);
    updateImage(appId, {
      image_status: "ready",
      image_ref: previous,
      image_hash: `sha256:${row.appKey}-previous`,
      image_built_at: row.imageRollbackBuiltAt,
      image_error: null,
    });
    return {
      appId,
      appKey: appKey ?? row.appKey,
      status: "ready",
      imageRef: previous,
      previousImageRef: row.imageRef,
      builtAt: row.imageRollbackBuiltAt,
    };
  },
  check: async (appId: string, appKey?: string) => {
    const row = imageRow(appId);
    return {
      appId,
      appKey: appKey ?? row.appKey,
      status: row.imageStatus,
      imageRef: row.imageRef,
      imageHash: row.imageHash,
      buildConfigured: row.buildConfigured === 1,
      state: imageState(row, false),
      notice: row.buildConfigured ? "Image is up to date." : "Default image is current.",
      tone: "success" as const,
    };
  },
  logs: async (appId: string) => {
    const row = imageRow(appId);
    return {
      appId,
      buildId: `e2e-build-${appId}`,
      status: row.imageStatus,
      logs: buildLogs.get(appId) ?? "No build logs yet.",
      runnerAvailable: true,
    };
  },
  usage: async () => ({ totalBytes: 0, images: [] }),
  gc: async () => ({ removed: 0, reclaimedBytes: 0 }),
} as unknown as ImageService;

/**
 * Deterministic dispatcher for the reply-relaunch/retry/cancel contract. It mutates only the handoff
 * row and never contacts opencode, so the flow is stable and cheap.
 */
const dispatcher = {
  async relaunchReply(handoffId: string, note?: string) {
    const handoff = getHandoff(fixture.db, handoffId);
    if (handoff === undefined) throw new Error(`Handoff not found: ${handoffId}`);
    const sessionId = "ses_e2e_relaunch";
    const messageId = "msg_e2e_relaunch";
    updateHandoff(fixture.db, handoffId, {
      replyState: "delivered",
      replyDeliveredSessionId: sessionId,
      replyDeliveredAt: new Date().toISOString(),
      replyError: null,
      operatorNote: note === undefined || note.trim().length === 0 ? null : note.trim(),
      deliveredVia: "operator_relaunch",
    });
    return { sessionId, messageId };
  },
  retryReplyDelivery(handoffId: string) {
    return updateHandoff(fixture.db, handoffId, {
      replyState: "pending",
      replyError: null,
      replyAttempts: 0,
    });
  },
  cancelReply(handoffId: string) {
    return updateHandoff(fixture.db, handoffId, { replyState: "cancelled", replyError: null });
  },
} as unknown as HandoffDispatcher;

/** Contract-only deletion: validates the exact name and never removes fixture data. */
function projectName(projectId: string): string | undefined {
  const row = fixture.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as
    | { name: string }
    | undefined;
  return row?.name;
}

const deletion = {
  isActive: () => false,
  isDeletingProject: () => false,
  isDeletingApp: () => false,
  isDeletingAppState: () => false,
  isDeletingPath: () => false,
  async deleteProject(projectId: string, options: DeleteOptions) {
    const name = projectName(projectId);
    if (name === undefined) {
      throw new DeletionError(404, "not_found", "project not found");
    }
    if (options.confirm !== name) {
      throw new DeletionError(400, "confirm_mismatch", "The project name must match exactly.");
    }
    return { deleted: true, kind: "project", projectId, warnings: [] };
  },
  async deleteApp(projectId: string, appKey: string, options: DeleteOptions) {
    if (options.confirm !== appKey) {
      throw new DeletionError(400, "confirm_mismatch", "The application name must match exactly.");
    }
    return { deleted: true, kind: "app", projectId, warnings: [] };
  },
} as unknown as DeletionService;

const previewState = new Map<string, PreviewView[]>([
  [
    FIXTURE_ALPHA_APP,
    [
      {
        key: "e2e-preview",
        name: "Fixture preview",
        port: 3000,
        url: "/preview/e2e-fixture/",
        basePath: "/preview/e2e-fixture/",
        basePathWithoutTrailingSlash: "/preview/e2e-fixture",
        createdAt: "2026-10-30T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
  ],
]);
const previews = {
  recordOperatorHost: () => undefined,
  views: (appId: string) => previewState.get(appId) ?? [],
  close: (appId: string, key: string) => {
    const current = previewState.get(appId) ?? [];
    const next = current.filter((preview) => preview.key !== key);
    previewState.set(appId, next);
    return next.length !== current.length;
  },
} as unknown as NonNullable<HttpDeps["previews"]>;

const deps: HttpDeps = {
  db: fixture.db,
  workspaceRoot: fixture.workspaceRoot,
  getProjects: () => {
    const rows = fixture.db
      .prepare("SELECT id, name, root_path, deleting FROM projects ORDER BY rowid")
      .all() as Array<{ id: string; name: string; root_path: string; deleting: number }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      workspaceRoot: fixture.workspaceRoot,
      deleting: row.deleting === 1,
      service: projectService(row.id),
    }));
  },
  git,
  runner: { url: upstream.runnerUrl, token: upstream.token },
  manager,
  settings: fixture.settings,
  modelProviders: fixture.modelProviders,
  ssh,
  skills: fixture.skills,
  images,
  dispatcher,
  deletion,
  previews,
  // Docker remains unconfigured: those routes keep the existing 503 contracts.
};

/**
 * Serve the deterministic bare repository over git:// so add-app clone passes the production
 * remote-scheme validation without contacting an external host.
 */
let gitDaemon: ChildProcess | undefined;
if (fixture.fixtureRemotePath !== null) {
  const root = path.dirname(fixture.fixtureRemotePath);
  gitDaemon = spawn(
    "git",
    [
      "daemon",
      "--reuseaddr",
      "--listen=127.0.0.1",
      `--port=${port + 1000}`,
      `--base-path=${root}`,
      "--export-all",
      root,
    ],
    { stdio: "ignore" },
  );
  gitDaemon.on("error", (error) => {
    process.stderr.write(`e2e git daemon error: ${error.message}\n`);
  });
}

const server = createHttpServer(deps);

function shutdown(): void {
  gitDaemon?.kill("SIGTERM");
  void upstream.stop();
  server.close(() => {
    rmSync(fixtureReposPath, { force: true });
    rmSync(upstreamInfoPath, { force: true });
    fixture.cleanup();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", (error) => {
  process.stderr.write(`e2e fixture server error: ${error.message}\n`);
  gitDaemon?.kill("SIGTERM");
  void upstream.stop();
  rmSync(fixtureReposPath, { force: true });
  rmSync(upstreamInfoPath, { force: true });
  fixture.cleanup();
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`e2e fixture ready on http://127.0.0.1:${actualPort} (${mode})\n`);
});
