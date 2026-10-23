/*
 * Throwaway coordinator fixture for docs/design/skills-qa.mjs.
 *
 * The harness starts this file with `tsx` on a free loopback port, reads the
 * `READY {json}` line from stdout, and shuts it down with SIGTERM. Every value
 * here is synthetic: no deployment host, path, project, or operator data.
 *
 * The fixture seeds:
 *   global:  release-checklist (full bundle), ops-guide, deploy-notes,
 *            shared-rules, triage-bugs, repair-me (corrupt stored metadata)
 *   project: project-notes, triage-bugs tombstone
 *   app:     app-playbook, shared-rules (corrupt metadata -> Invalid local
 *            override), app-broken (corrupt metadata -> Invalid here)
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoordinatorService } from "../../src/coordinator/service.js";
import { GitService } from "../../src/git/service.js";
import type { HttpDeps } from "../../src/http/handler.js";
import { createHttpServer } from "../../src/http/server.js";
import { createPrincipal } from "../../src/identity/principals.js";
import { SkillService } from "../../src/skills/index.js";
import { openDatabase, runMigrations } from "../../src/store/index.js";

const ownedTemp = process.env.SKILLS_QA_TEMP === undefined;
const temp = process.env.SKILLS_QA_TEMP ?? mkdtempSync(path.join(tmpdir(), "hanse-skills-qa-"));
const workspace = path.join(temp, "workspace");
const projectRoot = path.join(workspace, "atlas");
const appRoot = path.join(projectRoot, "apps", "web");
mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
mkdirSync(appRoot, { recursive: true });

const db = openDatabase(path.join(temp, "coordinator.db"));
runMigrations(db);
const now = new Date().toISOString();
db.prepare(
  "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p1','Atlas','main',?,?,?)",
).run(projectRoot, now, now);
db.prepare(
  "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p1:web','p1','web','apps/web','app','AGENTS.md',?)",
).run(now);

const skills = new SkillService({ db });
const actor = "operator";

const releaseContent = [
  "# Release checklist",
  "",
  "Use this before every **production** release.",
  "",
  "## Steps",
  "",
  "1. Run `npm test`",
  "2. Update the changelog",
  "3. Tag the build",
  "",
  "| Step | Owner |",
  "| --- | --- |",
  "| Tests | CI |",
  "| Tag | Operator |",
  "",
  "```sh",
  "npm run release",
  "```",
  "",
  "Raw HTML stays text: <script>window.__qaXss = 1</script>",
  "",
  'An image probe: <img src="probe" onerror="window.__qaXss = 2">',
  "",
  "A dangerous link: [do not run](javascript:window.__qaXss=3).",
  "",
  "See [the release docs](https://example.test/releases?year=2026).",
].join("\n");

const release = skills.create(
  "global",
  {},
  {
    name: "release-checklist",
    description: "Ship a release without missing the boring parts.",
    content: releaseContent,
    license: "MIT",
    compatibility: "Node >= 20",
    metadata: {
      domain: "engineering",
      role: "release",
      "output-format": "report",
      version: "1.0.0",
      author: "operator",
      triggers: "release, ship",
    },
    references: [
      {
        path: "references/rollback.md",
        content: "# Rollback\n\n1. Revert the tag.\n2. Restore the previous image.\n",
      },
      {
        path: "references/checks.md",
        content: "# Checks\n\n- tests\n- changelog\n",
      },
    ],
  },
  actor,
);

const repair = skills.create(
  "global",
  {},
  {
    name: "repair-me",
    description: "A skill with corrupt stored metadata.",
    content: "# Repair me\n\nThe metadata needs repair.",
    metadata: { author: "operator" },
  },
  actor,
);

const opsGuide = skills.create(
  "global",
  {},
  {
    name: "ops-guide",
    description: "Operate an application with the synthetic runbook.",
    content: "# Operations guide\n\nUse this when operating the **web** application.",
    metadata: { domain: "operations", role: "on-call" },
    references: [
      {
        path: "references/runbook.md",
        content: "# Runbook\n\n1. Check the health endpoint.\n2. Read the latest log.\n",
      },
    ],
  },
  actor,
);

const deployNotes = skills.create(
  "global",
  {},
  {
    name: "deploy-notes",
    description: "Deployment notes inherited by narrower scopes.",
    content: "# Deploy notes\n\nBuild, smoke test, then deploy.",
    metadata: { domain: "operations", role: "deploy" },
  },
  actor,
);

skills.create(
  "global",
  {},
  {
    name: "shared-rules",
    description: "Shared engineering rules inherited by every scope.",
    content: "# Shared rules\n\nKeep changes small and verify before shipping.",
    metadata: { domain: "engineering" },
  },
  actor,
);

skills.create(
  "global",
  {},
  {
    name: "triage-bugs",
    description: "Triage an incoming bug report into a reproducible ticket.",
    content: "# Triage\n\nReproduce, isolate, and record the smallest failing case.",
  },
  actor,
);

skills.create(
  "project",
  { projectId: "p1" },
  {
    name: "project-notes",
    description: "Project-specific conventions for the Atlas project.",
    content: "# Project notes\n\nKeep changes small and run the project gates.",
    metadata: { domain: "engineering", scope: "project" },
  },
  actor,
);

skills.create(
  "project",
  { projectId: "p1" },
  {
    name: "triage-bugs",
    description: "Tombstone that hides the global triage skill.",
    content: "# Triage\n\nDisabled at the project scope.",
    enabled: false,
  },
  actor,
);

skills.create(
  "app",
  { projectId: "p1", appKey: "web" },
  {
    name: "app-playbook",
    description: "Application-specific deploy playbook for the web app.",
    content: "# App playbook\n\nBuild, smoke test, and deploy.",
    metadata: { domain: "operations", role: "deploy" },
  },
  actor,
);

const sharedApp = skills.create(
  "app",
  { projectId: "p1", appKey: "web" },
  {
    name: "shared-rules",
    description: "Local copy with corrupt stored metadata.",
    content: "# Shared rules\n\nLocal copy.",
    metadata: { domain: "engineering" },
  },
  actor,
);

const appBroken = skills.create(
  "app",
  { projectId: "p1", appKey: "web" },
  {
    name: "app-broken",
    description: "Invalid application-local row with no wider winner.",
    content: "# App broken\n\nThis row is invalid here.",
  },
  actor,
);

function corruptMetadata(id: number): void {
  db.pragma("ignore_check_constraints = ON");
  db.prepare("UPDATE skills SET metadata_json = ? WHERE id = ?").run('{"author":', id);
  db.pragma("ignore_check_constraints = OFF");
}

corruptMetadata(repair.id);
corruptMetadata(sharedApp.id);
corruptMetadata(appBroken.id);

const token = createPrincipal(db, { kind: "human", name: actor }).token;
const deps: HttpDeps = {
  db,
  workspaceRoot: workspace,
  git: new GitService({ workspaceRoot: workspace }),
  skills,
  agentsHome: path.join(temp, "agents"),
  baselinePlugins: [],
  getProjects: () => [
    {
      id: "p1",
      name: "Atlas",
      rootPath: projectRoot,
      workspaceRoot: workspace,
      service: new CoordinatorService(db, "p1"),
    },
  ],
};

const server = createHttpServer(deps);
let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  server.close(() => {
    db.close();
    if (ownedTemp) {
      rmSync(temp, { recursive: true, force: true });
    }
    process.exit(0);
  });
  setTimeout(() => {
    db.close();
    if (ownedTemp) {
      rmSync(temp, { recursive: true, force: true });
    }
    process.exit(0);
  }, 2000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (error) => {
  process.stderr.write(`skills-qa-server: ${String(error)}\n`);
  shutdown();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(
    `READY ${JSON.stringify({
      port,
      token,
      ids: {
        release: release.id,
        repair: repair.id,
        opsGuide: opsGuide.id,
        deployNotes: deployNotes.id,
        sharedApp: sharedApp.id,
        appBroken: appBroken.id,
      },
    })}\n`,
  );
});
