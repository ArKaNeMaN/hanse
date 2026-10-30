import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transitionHandoff, updateHandoff } from "../../src/coordinator/handoff.js";
import { CoordinatorService } from "../../src/coordinator/service.js";
import type { RunSshKeygen } from "../../src/git/credentials.js";
import { upsertPrincipalWithToken } from "../../src/identity/principals.js";
import {
  MASTER_APP_KEY,
  MASTER_DIR_NAME,
  MASTER_PROJECT_ID,
  MASTER_PROJECT_NAME,
} from "../../src/master/constants.js";
import { ModelProviderService } from "../../src/model-providers/index.js";
import { SettingsService } from "../../src/settings/index.js";
import { SkillService } from "../../src/skills/index.js";
import { SshService } from "../../src/ssh/service.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../../src/store/index.js";
import type { FixtureMessage, FixtureSession } from "./opencode-upstream.js";

/** Obvious test literal; never a deployment credential. */
export const E2E_TOKEN = "test-operator-token";
export const E2E_OPERATOR = "test-operator";

/** Deterministic chat identities served by the fake opencode upstream. Synthetic only. */
export const E2E_CHAT_SESSION_ID = "ses_e2ealpha";
export const E2E_CHAT_CHILD_SESSION_ID = "ses_e2echild";
export const E2E_CHAT_GRANDCHILD_SESSION_ID = "ses_e2egrandchild";
export const E2E_CHAT_HISTORY_SESSION_ID = "ses_e2ehistory";
export const E2E_CHAT_RENDER_SESSION_ID = "ses_e2erender";
export const E2E_CHAT_PERF_SESSION_ID = "ses_e2eperf";

function historyMessages(): readonly FixtureMessage[] {
  return Array.from({ length: 35 }, (_, index) => {
    const number = index + 1;
    const suffix = String(number).padStart(2, "0");
    return {
      info: {
        id: `msg_e2e_history_${suffix}`,
        sessionID: E2E_CHAT_HISTORY_SESSION_ID,
        role: number % 2 === 0 ? "assistant" : "user",
        time: { created: 1_760_000_100_000 + number },
      },
      parts: [
        {
          id: `prt_e2e_history_${suffix}`,
          sessionID: E2E_CHAT_HISTORY_SESSION_ID,
          messageID: `msg_e2e_history_${suffix}`,
          type: "text",
          text: `Synthetic history message ${number}.`,
        },
      ],
    } satisfies FixtureMessage;
  });
}

function diffPatch(path: string, lines: number): string {
  const body = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${lines} +1,${lines} @@`];
  for (let line = 1; line <= lines; line += 1) {
    body.push(`+export const e2e${line} = "${"x".repeat(56)}";`);
  }
  return body.join("\n");
}

function renderMessages(): readonly FixtureMessage[] {
  const session = E2E_CHAT_RENDER_SESSION_ID;
  const createdAt = 1_760_000_200_000;
  return [
    {
      info: {
        id: "msg_e2e_render_user",
        sessionID: session,
        role: "user",
        time: { created: createdAt },
      },
      parts: [
        {
          id: "prt_e2e_render_user",
          sessionID: session,
          messageID: "msg_e2e_render_user",
          type: "text",
          text: "Render every supported surface.",
        },
      ],
    },
    {
      info: {
        id: "msg_e2e_render_omo",
        sessionID: session,
        role: "user",
        time: { created: createdAt + 1 },
      },
      parts: [
        {
          id: "prt_e2e_render_omo",
          sessionID: session,
          messageID: "msg_e2e_render_omo",
          type: "text",
          synthetic: true,
          text: "[BACKGROUND TASK COMPLETED]\n\nThe background fixture finished.",
        },
      ],
    },
    {
      info: {
        id: "msg_e2e_render_handoff",
        sessionID: session,
        role: "user",
        time: { created: createdAt + 2 },
        hanse: {
          handoff: {
            id: "handoff_e2e_render_0001",
            direction: "reply",
            agent: "fixture-agent",
            from: "fixture-agent",
            to: "alpha",
            state: "delivered",
            summary: "Fixture handoff reply",
            body: "## Handoff result\n\nThe fixture reply body.",
            operatorNote: "Reviewed in the fixture.",
            outcome: "completed",
            replyState: "delivered",
          },
        },
      },
      parts: [
        {
          id: "prt_e2e_render_handoff",
          sessionID: session,
          messageID: "msg_e2e_render_handoff",
          type: "text",
          text: "Handoff envelope fixture.",
        },
      ],
    },
    {
      info: {
        id: "msg_e2e_render_attachment_file",
        sessionID: session,
        role: "user",
        time: { created: createdAt + 2.5 },
        hanse: {
          attachments: [
            {
              id: "att_e2e_file",
              name: "fixture.csv",
              mime: "text/csv",
              size: 42,
              kind: "file",
              mode: "file",
              state: "sent",
              downloadURL: "/api/apps/alpha/attachments/att_e2e_file?project=e2e-project-one",
              inline: false,
            },
          ],
        },
      },
      parts: [
        {
          id: "prt_e2e_render_attachment_file",
          sessionID: session,
          messageID: "msg_e2e_render_attachment_file",
          type: "text",
          text: "File-only fixture attachment.",
        },
      ],
    },
    {
      info: {
        id: "msg_e2e_render_attachment_inline",
        sessionID: session,
        role: "user",
        time: { created: createdAt + 2.6 },
      },
      parts: [
        {
          id: "prt_e2e_render_attachment_inline",
          sessionID: session,
          messageID: "msg_e2e_render_attachment_inline",
          type: "file",
          url: "/assets/favicon.svg",
          mime: "image/png",
          filename: "inline.png",
          attachment: {
            id: "att_e2e_inline",
            size: 64,
            mode: "inline",
            kind: "image",
            inline: true,
          },
        },
      ],
    },
    {
      info: {
        id: "msg_e2e_render_assistant",
        sessionID: session,
        role: "assistant",
        parentID: "msg_e2e_render_user",
        finish: "stop",
        time: { created: createdAt + 3, completed: createdAt + 4 },
      },
      parts: [
        {
          id: "prt_e2e_render_text",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "text",
          text: "## Render fixture\n\n| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n| beta | 2 |\n\nAdversarial <script>window.__bad = true</script> stays text.",
        },
        {
          id: "prt_e2e_render_reasoning",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "reasoning",
          text: "I should inspect the fixture output.",
        },
        {
          id: "prt_e2e_render_bash",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "tool",
          callID: "call_e2e_render_bash",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "npm test" },
            metadata: { output: "fixture tests passed\nall green" },
            output: "fixture tests passed\nall green",
          },
        },
        {
          id: "prt_e2e_render_edit",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "tool",
          callID: "call_e2e_render_edit",
          tool: "edit",
          state: {
            status: "completed",
            input: { filePath: "src/e2e.ts" },
            metadata: {
              filediff: {
                file: "src/e2e.ts",
                patch: diffPatch("src/e2e.ts", 12),
              },
            },
          },
        },
        {
          id: "prt_e2e_render_oversized",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "tool",
          callID: "call_e2e_render_oversized",
          tool: "edit",
          state: {
            status: "completed",
            input: { filePath: "src/oversized.ts" },
            metadata: {
              filediff: {
                file: "src/oversized.ts",
                patch: diffPatch("src/oversized.ts", 1_100),
              },
            },
          },
        },
        {
          id: "prt_e2e_render_patch",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "patch",
          title: "Fixture patch",
          patch: diffPatch("src/patch.ts", 4),
        },
        {
          id: "prt_e2e_render_file",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "file",
          filename: "src/read.ts",
          content: "export const read = true;",
        },
        {
          id: "prt_e2e_render_subtask",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "subtask",
          description: "Fixture subtask",
          prompt: "Review the fixture subtask.",
        },
        {
          id: "prt_e2e_render_step_start",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "step-start",
        },
        {
          id: "prt_e2e_render_step_finish",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "step-finish",
        },
        {
          id: "prt_e2e_render_retry",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "retry",
        },
        {
          id: "prt_e2e_render_compaction",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "compaction",
        },
        {
          id: "prt_e2e_render_snapshot",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "snapshot",
        },
        {
          id: "prt_e2e_render_agent",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "agent",
        },
        {
          id: "prt_e2e_render_unknown",
          sessionID: session,
          messageID: "msg_e2e_render_assistant",
          type: "mystery",
          text: "Unknown fixture part",
        },
      ],
    },
  ];
}

function perfMessages(): readonly FixtureMessage[] {
  return Array.from({ length: 500 }, (_, index) => {
    const number = index + 1;
    const suffix = String(number).padStart(3, "0");
    return {
      info: {
        id: `msg_e2e_perf_${suffix}`,
        sessionID: E2E_CHAT_PERF_SESSION_ID,
        role: number % 2 === 0 ? "assistant" : "user",
        time: { created: 1_760_000_300_000 + number },
      },
      parts: [
        {
          id: `prt_e2e_perf_${suffix}`,
          sessionID: E2E_CHAT_PERF_SESSION_ID,
          messageID: `msg_e2e_perf_${suffix}`,
          type: "text",
          text: `Perf fixture message ${number}.`,
        },
      ],
    } satisfies FixtureMessage;
  });
}

export const E2E_CHAT_SESSIONS: readonly FixtureSession[] = [
  {
    id: E2E_CHAT_SESSION_ID,
    title: "E2E alpha session",
    time: { created: 1_760_000_000_000, updated: 1_760_000_005_000 },
  },
  {
    id: E2E_CHAT_CHILD_SESSION_ID,
    title: "E2E child session",
    parentID: E2E_CHAT_SESSION_ID,
    time: { created: 1_760_000_001_000, updated: 1_760_000_004_000 },
  },
  {
    id: E2E_CHAT_GRANDCHILD_SESSION_ID,
    title: "E2E grandchild session",
    parentID: E2E_CHAT_CHILD_SESSION_ID,
    time: { created: 1_760_000_002_000, updated: 1_760_000_003_000 },
  },
  {
    id: E2E_CHAT_HISTORY_SESSION_ID,
    title: "E2E history session",
    time: { created: 1_760_000_100_000, updated: 1_760_000_100_035 },
  },
  {
    id: E2E_CHAT_RENDER_SESSION_ID,
    title: "E2E render session",
    time: { created: 1_760_000_200_000, updated: 1_760_000_200_004 },
  },
  {
    id: E2E_CHAT_PERF_SESSION_ID,
    title: "E2E perf session",
    time: { created: 1_760_000_300_000, updated: 1_760_000_300_500 },
  },
];
export const E2E_CHAT_MESSAGES: Readonly<Record<string, readonly FixtureMessage[]>> = {
  [E2E_CHAT_SESSION_ID]: [
    {
      info: {
        id: "msg_e2e_user",
        sessionID: E2E_CHAT_SESSION_ID,
        role: "user",
        time: { created: 1_760_000_001_000 },
      },
      parts: [
        {
          id: "prt_e2e_user_text",
          sessionID: E2E_CHAT_SESSION_ID,
          messageID: "msg_e2e_user",
          type: "text",
          text: "Hello from the synthetic E2E fixture.",
        },
      ],
    },
    {
      info: {
        id: "msg_e2e_assistant",
        sessionID: E2E_CHAT_SESSION_ID,
        role: "assistant",
        parentID: "msg_e2e_user",
        finish: "stop",
        time: { created: 1_760_000_002_000, completed: 1_760_000_003_000 },
      },
      parts: [
        {
          id: "prt_e2e_assistant_text",
          sessionID: E2E_CHAT_SESSION_ID,
          messageID: "msg_e2e_assistant",
          type: "text",
          text: "Synthetic assistant reply.",
        },
      ],
    },
  ],
  [E2E_CHAT_CHILD_SESSION_ID]: [],
  [E2E_CHAT_GRANDCHILD_SESSION_ID]: [],
  [E2E_CHAT_HISTORY_SESSION_ID]: historyMessages(),
  [E2E_CHAT_RENDER_SESSION_ID]: renderMessages(),
  [E2E_CHAT_PERF_SESSION_ID]: perfMessages(),
};

export const PROJECT_ONE = "e2e-project-one";
const PROJECT_TWO = "e2e-project-two";

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "ZTJlLXRlc3Qta2V5LW5vdC1yZWFs",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

/** Synthetic sentinels used by the settings specs to prove secret material never reaches the DOM. */
export const E2E_PROVIDER_SECRET = "e2e-provider-secret-sentinel";
export const E2E_HTTPS_TOKEN = "e2e-https-token-sentinel";
export const E2E_PRIVATE_KEY_SENTINEL = "e2e-private-key-sentinel";
export const E2E_KNOWN_HOSTS_SENTINEL = "e2e-known-hosts-sentinel";
export const E2E_GIT_SSH_PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  E2E_PRIVATE_KEY_SENTINEL,
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");
export const E2E_GIT_KNOWN_HOSTS = `git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEUyRUZpeHR1cmU ${E2E_KNOWN_HOSTS_SENTINEL}\n`;

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
  /** When provided, a deterministic bare git repository is created at this path for clone E2E. */
  remotePath?: string;
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
  agentsHome: string;
  projects: SeededProject[];
  projectRoots: Record<string, string>;
  settings: SettingsService;
  modelProviders: ModelProviderService;
  skills: SkillService;
  ssh: SshService;
  handoffId: string;
  replyHandoffId: string;
  retryReplyHandoffId: string;
  cancelHandoffId: string;
  fixtureRemotePath: string | null;
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
  execFileSync("git", ["config", "user.name", "E2E Fixture"], {
    cwd: directory,
    env,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "e2e@example.test"], {
    cwd: directory,
    env,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "README.md"], { cwd: directory, env, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture commit"], {
    cwd: directory,
    env,
    stdio: "ignore",
  });
}

/**
 * Give the alpha application a deterministic local remote and upstream. The bare repository lives
 * inside `.git`, so it never appears in the working tree and needs no network or credentials.
 */
function addFixtureOrigin(directory: string): void {
  const env = gitEnv();
  const bare = path.join(directory, ".git", "e2e-remote.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { env, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", pathToFileURL(bare).href], {
    cwd: directory,
    env,
    stdio: "ignore",
  });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], {
    cwd: directory,
    env,
    stdio: "ignore",
  });
  execFileSync("git", ["branch", "feature"], { cwd: directory, env, stdio: "ignore" });
}

/** Create a bare repository with one commit so add-app clone has a deterministic remote. */
function initBareRemote(directory: string, sourceDirectory: string): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(path.dirname(directory), { recursive: true });
  const env = gitEnv();
  execFileSync("git", ["clone", "--bare", "-q", sourceDirectory, directory], {
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
  const masterProject = {
    id: MASTER_PROJECT_ID,
    name: MASTER_PROJECT_NAME,
    rootPath: path.join(workspaceRoot, "master"),
    appKeys: [MASTER_APP_KEY],
  };

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
      const directory = path.join(project.rootPath, appPath);
      initFixtureRepo(directory);
      if (project.id === PROJECT_ONE && appKey === "alpha") {
        addFixtureOrigin(directory);
      }
      insertApp.run(appId, project.id, appKey, appPath, "service", now);
    }
  }

  insertInstance.run(`${PROJECT_ONE}:alpha`, `${PROJECT_ONE}:alpha`, "running", "running", now);
  insertInstance.run(`${PROJECT_ONE}:beta`, `${PROJECT_ONE}:beta`, "stopped", "stopped", now);
  insertInstance.run(`${PROJECT_TWO}:gamma`, `${PROJECT_TWO}:gamma`, "stopped", "stopped", now);

  // Beta is the deterministic custom-image fixture: a failed build with a previous image to roll
  // back to, which the app E2E drives forward through build/rollback. Gamma starts out of date.
  db.prepare(
    `UPDATE apps SET build_configured = 1, image_status = 'error', image_ref = 'hanse-beta:broken',
       image_hash = 'sha256:beta-broken', image_built_at = '2026-10-20T10:00:00.000Z',
       image_error = 'fixture build failed', image_base_kind = 'default',
       image_base_ref = 'hanse-agent-default:latest', image_base_digest = 'sha256:base-v1',
       image_hash_version = 2
     WHERE id = ?`,
  ).run(`${PROJECT_ONE}:beta`);
  db.prepare(
    `INSERT INTO app_image_versions
       (app_id, image_ref, image_id, base_digest, built_at, created_at, base_ref, base_kind,
        hash_version)
     VALUES (?, 'hanse-beta:previous', 'sha256:beta-previous', 'sha256:base-v1',
        '2026-10-19T10:00:00.000Z', '2026-10-19T10:00:00.000Z',
        'hanse-agent-default:latest', 'default', 2)`,
  ).run(`${PROJECT_ONE}:beta`);
  db.prepare(
    `UPDATE apps SET build_configured = 1, image_status = 'stale', image_ref = 'hanse-gamma:latest',
       image_hash = 'sha256:gamma', image_built_at = '2026-10-20T10:00:00.000Z',
       image_base_kind = 'base', image_base_ref = 'hanse-agent-base:latest',
       image_base_digest = 'sha256:old-base', image_hash_version = 2
     WHERE id = ?`,
  ).run(`${PROJECT_TWO}:gamma`);

  // Reserved master project: powers the read-only master variant. It is excluded from operator
  // aggregates, so its presence does not change project/application counts.
  mkdirSync(path.join(masterProject.rootPath, MASTER_DIR_NAME), { recursive: true });
  insertProject.run(masterProject.id, masterProject.name, masterProject.rootPath, now, now);
  insertApp.run(
    `${MASTER_PROJECT_ID}:${MASTER_APP_KEY}`,
    MASTER_PROJECT_ID,
    MASTER_APP_KEY,
    MASTER_DIR_NAME,
    "master",
    now,
  );
  insertInstance.run(
    `${MASTER_PROJECT_ID}:${MASTER_APP_KEY}`,
    `${MASTER_PROJECT_ID}:${MASTER_APP_KEY}`,
    "running",
    "running",
    now,
  );

  const modelProviders = new ModelProviderService({ db });
  const settings = new SettingsService({
    db,
    secretKey: randomBytes(32),
    providerIds: () => modelProviders.list().map((provider) => provider.id),
    runSshKeygen: fakeSshKeygen,
  });
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
  settings.setProviderKey("global", {}, "deepseek", E2E_PROVIDER_SECRET, E2E_OPERATOR);
  modelProviders.create(
    {
      id: "e2e-llm",
      name: "E2E LLM",
      baseUrl: "http://llm.example.test/v1",
      models: [{ id: "e2e-model", name: "E2E Model", limit: { context: 100000, output: 8192 } }],
    },
    E2E_OPERATOR,
  );
  const alphaSettingsTarget = { projectId: PROJECT_ONE, appKey: "alpha" };
  settings.setGitAuth(
    "app",
    alphaSettingsTarget,
    "ssh",
    { privateKey: E2E_GIT_SSH_PRIVATE_KEY, knownHosts: E2E_GIT_KNOWN_HOSTS },
    E2E_OPERATOR,
  );
  settings.setGitAuth(
    "app",
    alphaSettingsTarget,
    "https",
    { hosts: ["git.example.test"], username: "x-access-token", token: E2E_HTTPS_TOKEN },
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
  ssh.createHost(
    {
      name: "app-host",
      address: "203.0.113.11",
      username: "tester",
      privateKey: PRIVATE_KEY,
      requireApproval: false,
    },
    E2E_OPERATOR,
  );
  ssh.replaceAppHosts(`${PROJECT_ONE}:beta`, [host.id], E2E_OPERATOR);

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

  const pendingApproval = db.prepare(
    `INSERT INTO ssh_approvals
       (id, app_id, host_id, action, command_hash, command_preview, command_bytes, status,
        requested_at, expires_at)
     VALUES (?, ?, ?, 'exec', ?, ?, ?, 'pending', ?, ?)`,
  );
  for (const [id, preview] of [
    ["e2e-ssh-approval-approve", "echo approve e2e"],
    ["e2e-ssh-approval-reject", "echo reject e2e"],
  ] as const) {
    pendingApproval.run(
      id,
      `${PROJECT_ONE}:alpha`,
      host.id,
      `e2e-${id}-hash`,
      preview,
      preview.length,
      requestedAt.toISOString(),
      "2099-01-01T00:00:00.000Z",
    );
  }

  // Application-page SSH actions use beta so the global SSH console spec keeps alpha's rows.
  const betaGrantApproval = "e2e-ssh-app-grant";
  pendingApproval.run(
    betaGrantApproval,
    `${PROJECT_ONE}:beta`,
    host.id,
    "e2e-ssh-app-grant-hash",
    "echo grant app e2e",
    "echo grant app e2e".length,
    requestedAt.toISOString(),
    "2099-01-01T00:00:00.000Z",
  );
  ssh.decideApproval(betaGrantApproval, `${PROJECT_ONE}:beta`, "approve", E2E_OPERATOR);
  for (const [id, preview] of [
    ["e2e-ssh-app-approve", "echo approve app e2e"],
    ["e2e-ssh-app-reject", "echo reject app e2e"],
  ] as const) {
    pendingApproval.run(
      id,
      `${PROJECT_ONE}:beta`,
      host.id,
      `e2e-${id}-hash`,
      preview,
      preview.length,
      requestedAt.toISOString(),
      "2099-01-01T00:00:00.000Z",
    );
  }
  db.prepare(
    `INSERT INTO ssh_audit
       (app_id, project_id, app_key, host_id, host_name, address, username, action,
        command_hash, command_preview, started_at, finished_at, exit_code, truncated)
     VALUES (?, ?, 'beta', ?, 'test-host', '203.0.113.10', 'tester', 'exec',
        'e2e-app-audit-hash', 'echo app audit e2e', '2026-10-28T09:00:00.000Z',
        '2026-10-28T09:00:01.000Z', 0, 0)`,
  ).run(`${PROJECT_ONE}:beta`, PROJECT_ONE, host.id);

  const projectOne = new CoordinatorService(db, PROJECT_ONE);
  const { handoffId } = projectOne.requestSiblingChange({
    fromAppKey: "alpha",
    toAppKey: "beta",
    summary: "E2E handoff summary",
    spec: "E2E handoff spec",
    requiresApproval: true,
  });

  function deliveredReply(summary: string, spec = "E2E reply spec"): string {
    const { handoffId: id } = projectOne.requestSiblingChange({
      fromAppKey: "beta",
      toAppKey: "alpha",
      summary,
      spec,
    });
    transitionHandoff(db, id, "dispatching");
    transitionHandoff(db, id, "in_progress");
    transitionHandoff(db, id, "delivered", { result: "E2E reply result", outcome: "completed" });
    updateHandoff(db, id, {
      replyState: "waiting_operator",
      sourceSessionId: "ses_e2e_source_reply",
    });
    return id;
  }

  const replyHandoffId = deliveredReply("E2E reply handoff");
  const retryReplyHandoffId = deliveredReply("E2E retry reply handoff");
  const { handoffId: cancelHandoffId } = projectOne.requestSiblingChange({
    fromAppKey: "alpha",
    toAppKey: "beta",
    summary: "E2E cancel handoff",
    spec: "E2E cancel spec",
  });

  // Dedicated inbox rows for the handoffs spec. Their timestamps are older so the overview's
  // recent-handoffs list and project ordering keep the rows the other specs assert on.
  const inboxRelaunchReplyId = deliveredReply(
    "E2E inbox relaunch reply",
    "## Relaunch reply\n\nA **bold** reply and `code`.",
  );
  const inboxRetryReplyId = deliveredReply("E2E inbox retry reply", "E2E inbox retry spec");
  const { handoffId: inboxCancelId } = projectOne.requestSiblingChange({
    fromAppKey: "alpha",
    toAppKey: "beta",
    summary: "E2E inbox cancel handoff",
    spec: "E2E inbox cancel spec",
  });
  const old = "2020-01-01T00:00:00.000Z";
  db.prepare("UPDATE handoffs SET created_at = ?, updated_at = ? WHERE id IN (?, ?, ?)").run(
    old,
    old,
    inboxRelaunchReplyId,
    inboxRetryReplyId,
    inboxCancelId,
  );
  // Keep the overview's recent-handoffs row stable even after the inbox spec updates its own rows
  // (relaunch/retry/cancel refresh `updated_at`). The fixture sorts by `updated_at`, so the
  // long-lived summary must rank above those test-owned rows.
  db.prepare("UPDATE handoffs SET updated_at = ? WHERE id = ?").run(
    "2099-01-01T00:00:00.000Z",
    handoffId,
  );

  let fixtureRemotePath: string | null = null;
  if (options.remotePath !== undefined) {
    const source = path.join(tempRoot, "remote-source");
    initFixtureRepo(source);
    initBareRemote(options.remotePath, source);
    fixtureRemotePath = options.remotePath;
  }

  return {
    db,
    workspaceRoot,
    agentsHome,
    projects,
    projectRoots: Object.fromEntries(projects.map((project) => [project.id, project.rootPath])),
    settings,
    modelProviders,
    skills,
    ssh,
    handoffId,
    replyHandoffId,
    retryReplyHandoffId,
    cancelHandoffId,
    fixtureRemotePath,
    skillIds: [globalSkill.id, projectSkill.id],
    sshHostId: host.id,
    cleanup: () => {
      if (fixtureRemotePath !== null) {
        rmSync(fixtureRemotePath, { recursive: true, force: true });
      }
      cleanup();
    },
  };
}
