import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoordinatorService } from "../../src/coordinator/service.js";
import type { RunSshKeygen } from "../../src/git/credentials.js";
import { upsertPrincipalWithToken } from "../../src/identity/principals.js";
import { SettingsService } from "../../src/settings/index.js";
import { SkillService } from "../../src/skills/index.js";
import { SshService } from "../../src/ssh/service.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../../src/store/index.js";

/** Obvious test literal; never a deployment credential. */
export const E2E_TOKEN = "test-operator-token";
export const E2E_OPERATOR = "test-operator";

const PROJECT_ONE = "e2e-project-one";
const PROJECT_TWO = "e2e-project-two";

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "ZTJlLXRlc3Qta2V5LW5vdC1yZWFs",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

/** Deterministic stand-in for ssh-keygen so the fixture carries no real key material. */
const fakeSshKeygen: RunSshKeygen = (args) => {
  if (args[0] === "-y") {
    return {
      status: 0,
      stdout: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEUyRUZpeHR1cmU e2e@example.test\n",
      stderr: "",
    };
  }
  if (args[0] === "-lf") {
    return {
      status: 0,
      stdout: "256 SHA256:e2e-fixture-fingerprint e2e@example.test (ED25519)\n",
      stderr: "",
    };
  }
  return { status: 0, stdout: "", stderr: "" };
};

export interface SeedOptions {
  dbPath?: string;
  token?: string;
}

export interface SeededProject {
  id: string;
  name: string;
  rootPath: string;
  appKeys: string[];
}

export interface SeedResult {
  db: SqliteDatabase;
  workspaceRoot: string;
  projects: SeededProject[];
  projectRoots: Record<string, string>;
  settings: SettingsService;
  skills: SkillService;
  ssh: SshService;
  handoffId: string;
  skillIds: number[];
  sshHostId: string;
  cleanup: () => void;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "E2E Fixture",
    GIT_AUTHOR_EMAIL: "e2e@example.test",
    GIT_COMMITTER_NAME: "E2E Fixture",
    GIT_COMMITTER_EMAIL: "e2e@example.test",
  };
}

function initFixtureRepo(directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "README.md"), "# E2E fixture application\n", "utf8");
  const env = gitEnv();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, env, stdio: "ignore" });
  execFileSync("git", ["add", "README.md"], { cwd: directory, env, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture commit"], {
    cwd: directory,
    env,
    stdio: "ignore",
  });
}

function writeProjectManifest(rootPath: string, project: SeededProject): void {
  const directory = path.join(rootPath, ".hanse");
  mkdirSync(directory, { recursive: true });
  const apps = project.appKeys.map((key) => `  - key: ${key}\n    path: apps/${key}`).join("\n");
  writeFileSync(
    path.join(directory, "project.yaml"),
    `id: ${project.id}\nname: ${project.name}\nbase_branch: main\napps:\n${apps}\n`,
    "utf8",
  );
}

function removeDatabaseFiles(filename: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${filename}${suffix}`, { force: true });
  }
}

/**
 * Create a deterministic coordinator fixture: a temp workspace with two synthetic projects, three
 * application repositories, a test operator, settings, skills, one SSH host/grant, and one handoff.
 */
export function seed(options: SeedOptions = {}): SeedResult {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "hanse-e2e-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const dbPath =
    options.dbPath === undefined
      ? path.join(tempRoot, "coordinator.db")
      : path.resolve(options.dbPath);
  removeDatabaseFiles(dbPath);

  const db = openDatabase(dbPath);
  let closed = false;
  const cleanup = () => {
    if (!closed) {
      closed = true;
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    removeDatabaseFiles(dbPath);
    rmSync(tempRoot, { recursive: true, force: true });
  };

  runMigrations(db);
  upsertPrincipalWithToken(db, {
    kind: "human",
    name: E2E_OPERATOR,
    token: options.token ?? E2E_TOKEN,
  });

  const projects: SeededProject[] = [
    {
      id: PROJECT_ONE,
      name: "E2E Project One",
      rootPath: path.join(workspaceRoot, "project-one"),
      appKeys: ["alpha", "beta"],
    },
    {
      id: PROJECT_TWO,
      name: "E2E Project Two",
      rootPath: path.join(workspaceRoot, "project-two"),
      appKeys: ["gamma"],
    },
  ];

  const now = new Date().toISOString();
  const insertProject = db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?,?,'main',?,?,?)",
  );
  const insertApp = db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES (?,?,?,?,?, 'AGENTS.md', ?)",
  );
  const insertInstance = db.prepare(
    "INSERT INTO instances (id,app_id,state,runtime_state,updated_at) VALUES (?,?,?,?,?)",
  );

  for (const project of projects) {
    writeProjectManifest(project.rootPath, project);
    insertProject.run(project.id, project.name, project.rootPath, now, now);
    for (const appKey of project.appKeys) {
      const appId = `${project.id}:${appKey}`;
      const appPath = `apps/${appKey}`;
      initFixtureRepo(path.join(project.rootPath, appPath));
      insertApp.run(appId, project.id, appKey, appPath, "service", now);
    }
  }

  insertInstance.run(`${PROJECT_ONE}:alpha`, `${PROJECT_ONE}:alpha`, "running", "running", now);
  insertInstance.run(`${PROJECT_ONE}:beta`, `${PROJECT_ONE}:beta`, "stopped", "stopped", now);
  insertInstance.run(`${PROJECT_TWO}:gamma`, `${PROJECT_TWO}:gamma`, "stopped", "stopped", now);

  const settings = new SettingsService({ db, secretKey: randomBytes(32) });
  settings.set("global", {}, "llm.model", "test-provider/test-model", E2E_OPERATOR);
  settings.set(
    "project",
    { projectId: PROJECT_ONE },
    "context.auto_compact.percent",
    75,
    E2E_OPERATOR,
  );
  settings.set(
    "app",
    { projectId: PROJECT_ONE, appKey: "alpha" },
    "git.user.name",
    "E2E Operator",
    E2E_OPERATOR,
  );

  const skills = new SkillService({ db });
  const globalSkill = skills.create(
    "global",
    {},
    {
      name: "e2e-global-skill",
      description: "Global skill bundle used by the deterministic E2E fixture.",
      content: "# E2E global skill\n\nSynthetic content only.\n",
    },
    E2E_OPERATOR,
  );
  const projectSkill = skills.create(
    "project",
    { projectId: PROJECT_ONE },
    {
      name: "e2e-project-skill",
      description: "Project skill bundle used by the deterministic E2E fixture.",
      content: "# E2E project skill\n\nSynthetic content only.\n",
    },
    E2E_OPERATOR,
  );

  const agentsHome = path.join(tempRoot, "agents");
  mkdirSync(agentsHome, { recursive: true });
  const ssh = new SshService({
    db,
    secretKey: randomBytes(32),
    workspaceRoot,
    agentsHome,
    runSshKeygen: fakeSshKeygen,
  });
  const host = ssh.createHost(
    {
      name: "test-host",
      address: "203.0.113.10",
      username: "tester",
      privateKey: PRIVATE_KEY,
      requireApproval: true,
    },
    E2E_OPERATOR,
  );
  ssh.replaceAppHosts(`${PROJECT_ONE}:alpha`, [host.id], E2E_OPERATOR);

  const approvalId = "e2e-ssh-approval";
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + 5 * 60_000);
  db.prepare(
    `INSERT INTO ssh_approvals
       (id, app_id, host_id, action, command_hash, command_preview, command_bytes, status,
        requested_at, expires_at)
     VALUES (?, ?, ?, 'exec', 'e2e-command-hash', 'echo e2e', 8, 'pending', ?, ?)`,
  ).run(
    approvalId,
    `${PROJECT_ONE}:alpha`,
    host.id,
    requestedAt.toISOString(),
    expiresAt.toISOString(),
  );
  ssh.decideApproval(approvalId, `${PROJECT_ONE}:alpha`, "approve", E2E_OPERATOR);

  const { handoffId } = new CoordinatorService(db, PROJECT_ONE).requestSiblingChange({
    fromAppKey: "alpha",
    toAppKey: "beta",
    summary: "E2E handoff summary",
    spec: "E2E handoff spec",
    requiresApproval: true,
  });

  return {
    db,
    workspaceRoot,
    projects,
    projectRoots: Object.fromEntries(projects.map((project) => [project.id, project.rootPath])),
    settings,
    skills,
    ssh,
    handoffId,
    skillIds: [globalSkill.id, projectSkill.id],
    sshHostId: host.id,
    cleanup,
  };
}
