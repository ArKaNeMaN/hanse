import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import type { connectSsh, SshConnection } from "../src/ssh/connection.js";
import { SshService } from "../src/ssh/service.js";
import { SshError } from "../src/ssh/types.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): {
  service: SshService;
  db: SqliteDatabase;
  agent: { appId: string; projectId: string; appKey: string };
  hostId: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ssh-approvals-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  mkdirSync(path.join(workspace, "p", "apps", "a"), { recursive: true });
  const db = openDatabase(":memory:");
  dbs.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(path.join(workspace, "p"), now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  const keyFile = path.join(dir, "id");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyFile, "-q"]);
  const connect = (() => Promise.resolve(fakeConnection())) as unknown as typeof connectSsh;
  const service = new SshService({
    db,
    secretKey: Buffer.alloc(32, 3),
    workspaceRoot: workspace,
    agentsHome: path.join(dir, "agents"),
    connect,
    approvalWaitMs: 2,
    approvalPollMs: 1,
    busyWaitMs: 20,
  });
  const agent = { appId: "p:a", projectId: "p", appKey: "a" };
  const host = service.createHost(
    {
      name: "h",
      address: "127.0.0.1",
      username: "deploy",
      privateKey: readFileSync(keyFile, "utf8"),
      requireApproval: true,
    },
    "op",
  );
  service.replaceAppHosts(agent.appId, [host.id], "op");
  return { service, db, agent, hostId: host.id };
}

function fakeConnection(): SshConnection {
  const client = {
    exec(
      _command: string,
      _opts: unknown,
      cb: (error: Error | null, stream: EventEmitter & { stderr: EventEmitter }) => void,
    ) {
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      stream.stderr = new EventEmitter();
      cb(null, stream);
      queueMicrotask(() => {
        stream.emit("data", Buffer.from("ok"));
        stream.emit("close", 0, null);
      });
    },
    end() {},
  } as unknown as Client;
  return {
    client,
    presented: Buffer.from([]),
    presentedPin: {
      text: "ssh-ed25519 AAAA",
      type: "ssh-ed25519",
      bits: 256,
      fingerprint: "SHA256:pin",
    },
  };
}

async function expectPending(
  service: SshService,
  agent: { appId: string; projectId: string; appKey: string },
  hostId: string,
  command: string,
): Promise<void> {
  await expect(service.exec(agent, { hostId, command })).rejects.toMatchObject({
    code: "ssh_approval_pending",
  });
}

describe("SSH approvals", () => {
  it("caps approval requests per app", async () => {
    const f = fixture();
    for (let index = 0; index < 10; index += 1) {
      await expectPending(f.service, f.agent, f.hostId, `echo ${index}`);
    }
    expect(f.service.listPending(f.agent.appId)).toHaveLength(10);
    await expect(
      f.service.exec(f.agent, { hostId: f.hostId, command: "echo 10" }),
    ).rejects.toMatchObject({
      code: "ssh_rate_limited",
    });
  });

  it("transitions expired pending rows and allows a fresh request", async () => {
    const f = fixture();
    await expectPending(f.service, f.agent, f.hostId, "echo one");
    f.db
      .prepare("UPDATE ssh_approvals SET expires_at = ? WHERE status = 'pending'")
      .run("2000-01-01T00:00:00.000Z");
    expect(f.service.listPending(f.agent.appId)).toHaveLength(0);
    await expectPending(f.service, f.agent, f.hostId, "echo fresh");
    expect(f.service.listPending(f.agent.appId)).toHaveLength(1);
  });

  it("enforces a rejection cooldown", async () => {
    const f = fixture();
    await expectPending(f.service, f.agent, f.hostId, "echo one");
    const pending = f.service.listPending(f.agent.appId)[0];
    if (pending === undefined) throw new Error("pending approval missing");
    f.service.decideApproval(pending.id, f.agent.appId, "reject", "op");
    await expect(
      f.service.exec(f.agent, { hostId: f.hostId, command: "echo after-reject" }),
    ).rejects.toMatchObject({
      code: "ssh_rate_limited",
    });
  });

  it("does not let a rejected approval be approved later", async () => {
    const f = fixture();
    await expectPending(f.service, f.agent, f.hostId, "echo one");
    const pending = f.service.listPending(f.agent.appId)[0];
    if (pending === undefined) throw new Error("pending approval missing");
    f.service.decideApproval(pending.id, f.agent.appId, "reject", "op");
    expect(() => f.service.decideApproval(pending.id, f.agent.appId, "approve", "op")).toThrow(
      SshError,
    );
  });
});
