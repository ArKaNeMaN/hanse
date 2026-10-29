import { type ChildProcess, spawn } from "node:child_process";
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
import type { ImageService, ImageStateView } from "../../src/images/service.js";
import type { InstanceManager } from "../../src/opencode/manager.js";
import { seed } from "./seed.js";

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
const manager = {
  startChatMaintenance() {},
  pendingRestart: () => ({ pending: false, reasons: [] }),
  profileWarnings: () => [],
  probeStatus: async () => false,
  isRestarting: () => false,
} as unknown as InstanceManager;

function imageView(appId: string): ImageStateView {
  const row = fixture.db.prepare("SELECT app_key AS appKey FROM apps WHERE id = ?").get(appId) as
    | { appKey: string }
    | undefined;
  return {
    appId,
    appKey: row?.appKey ?? "",
    status: "ready",
    imageRef: null,
    imageId: null,
    buildId: null,
    hash: null,
    currentHash: null,
    baseDigest: null,
    builtAt: null,
    error: null,
    updatedAt: null,
    previousImageRef: null,
    previousImageBuiltAt: null,
    runnerAvailable: false,
    buildConfigured: false,
    state: "current",
    running: false,
    usableImageRef: null,
    targetImageId: null,
    appliedImageId: null,
    hashVersion: null,
    currentBaseDigest: null,
    baseKind: "default",
    baseRef: null,
    baseDrift: false,
    hashDrift: false,
    blocked: false,
    selectedImage: "unknown",
    imageBuildId: null,
    latestBuildImageId: null,
  };
}

/** No image runner in the fixture; the page only needs a stable read view. */
const images = {
  status: async (appId: string) => imageView(appId),
  logs: async () => ({ logs: "" }),
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
  git: new GitService({ workspaceRoot: fixture.workspaceRoot }),
  manager,
  settings: fixture.settings,
  ssh: fixture.ssh,
  skills: fixture.skills,
  images,
  dispatcher,
  deletion,
  // Previews and Docker remain unconfigured: their routes keep the existing 503 contracts.
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
  server.close(() => {
    fixture.cleanup();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", (error) => {
  process.stderr.write(`e2e fixture server error: ${error.message}\n`);
  gitDaemon?.kill("SIGTERM");
  fixture.cleanup();
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`e2e fixture ready on http://127.0.0.1:${actualPort} (${mode})\n`);
});
