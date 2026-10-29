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

const fixture = seed({
  ...(process.env.HANSE_E2E_DB === undefined ? {} : { dbPath: process.env.HANSE_E2E_DB }),
  ...(process.env.HANSE_E2E_TOKEN === undefined ? {} : { token: process.env.HANSE_E2E_TOKEN }),
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
  // Docker, deletion, previews, and the handoff dispatcher are intentionally unconfigured:
  // Phase 0 only renders pages, and their routes then return their existing 503 contracts.
};

const server = createHttpServer(deps);

function shutdown(): void {
  server.close(() => {
    fixture.cleanup();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", (error) => {
  process.stderr.write(`e2e fixture server error: ${error.message}\n`);
  fixture.cleanup();
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`e2e fixture ready on http://127.0.0.1:${actualPort} (${mode})\n`);
});
