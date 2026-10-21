import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  appDir: string;
  privateKey: string;
  pin: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ssh-service-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  const appDir = path.join(workspace, "p", "apps", "a");
  mkdirSync(appDir, { recursive: true });
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
  const privateKey = readFileSync(keyFile, "utf8");
  const pin = "SHA256:test-pin";
  const connect = (() => Promise.resolve(fakeConnection(pin))) as unknown as typeof connectSsh;
  const service = new SshService({
    db,
    secretKey: Buffer.alloc(32, 7),
    workspaceRoot: workspace,
    agentsHome: path.join(dir, "agents"),
    connect,
    approvalWaitMs: 10,
    approvalPollMs: 1,
    busyWaitMs: 20,
  });
  return {
    service,
    db,
    agent: { appId: "p:a", projectId: "p", appKey: "a" },
    appDir,
    privateKey,
    pin,
  };
}

function fakeConnection(pin: string, authFailure = false): SshConnection {
  const files = new Map<string, Buffer>();
  const sftp = {
    realpath(value: string, cb: (error: Error | null, resolved?: string) => void) {
      cb(null, path.posix.dirname(value));
    },
    lstat(
      value: string,
      cb: (
        error: Error | null,
        attrs?: { isFile(): boolean; isSymbolicLink(): boolean; size: number },
      ) => void,
    ) {
      if (value.endsWith("new.txt")) cb(new Error("No such file"));
      else
        cb(null, {
          isFile: () => true,
          isSymbolicLink: () => false,
          size: files.get(value)?.length ?? 6,
        });
    },
    writeFile(value: string, data: Buffer, _opts: unknown, cb: (error: Error | null) => void) {
      files.set(value, Buffer.from(data));
      cb(null);
    },
    rename(from: string, to: string, cb: (error: Error | null) => void) {
      const data = files.get(from);
      if (data !== undefined) files.set(to, data);
      cb(null);
    },
    chmod(_value: string, _mode: number, cb: (error: Error | null) => void) {
      cb(null);
    },
    unlink(value: string, cb: (error: Error | null) => void) {
      files.delete(value);
      cb(null);
    },
    readFile(value: string, cb: (error: Error | null, data?: Buffer) => void) {
      cb(null, files.get(value) ?? Buffer.from("remote"));
    },
  };
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
        stream.emit("data", Buffer.from("ok\n"));
        stream.emit("close", 0, null);
      });
    },
    sftp(cb: (error: Error | null, value: unknown) => void) {
      cb(null, sftp);
    },
    end() {},
  } as unknown as Client;
  if (authFailure) {
    return Promise.reject(
      new SshError("ssh_auth_failed", "auth failed"),
    ) as unknown as SshConnection;
  }
  return {
    client,
    presented: Buffer.from([0, 0, 0, 11, ...Buffer.from("ssh-ed25519")]),
    presentedPin: { text: "ssh-ed25519 AAAA", type: "ssh-ed25519", bits: 256, fingerprint: pin },
    banner: "test",
  };
}

describe("SshService", () => {
  it("pins a host only after a successful test and executes an allowed command", async () => {
    const f = fixture();
    const host = f.service.createHost(
      {
        name: "h",
        address: "127.0.0.1",
        username: "deploy",
        privateKey: f.privateKey,
        requireApproval: false,
      },
      "op",
    );
    f.service.replaceAppHosts(f.agent.appId, [host.id], "op");
    const test = await f.service.testHost(host.id);
    expect(test.ok).toBe(true);
    expect(f.service.getHostView(host.id)?.hostKeyFingerprint).toBe(f.pin);
    const result = await f.service.exec(f.agent, { hostId: host.id, command: "echo ok" });
    expect(result).toMatchObject({ ok: true, exit_code: 0, stdout: "ok\n" });
    expect(f.service.listAudit(f.agent.appId).some((entry) => entry.action === "exec")).toBe(true);
  });

  it("does not pin on failed authentication and rejects a non-allowlisted host", async () => {
    const f = fixture();
    const failing = new SshService({
      db: f.db,
      secretKey: Buffer.alloc(32, 7),
      workspaceRoot: path.dirname(f.appDir),
      agentsHome: path.join(path.dirname(f.appDir), "agents"),
      connect: (() =>
        Promise.reject(new SshError("ssh_auth_failed", "no"))) as unknown as typeof connectSsh,
    });
    const host = failing.createHost(
      { name: "h", address: "127.0.0.1", username: "deploy", privateKey: f.privateKey },
      "op",
    );
    const test = await failing.testHost(host.id);
    expect(test.ok).toBe(false);
    expect(failing.getHostView(host.id)?.hostKeyFingerprint).toBeNull();
    await expect(
      f.service.exec(f.agent, { hostId: "missing", command: "true" }),
    ).rejects.toMatchObject({
      code: "ssh_host_not_allowed",
    });
  });

  it("requires approval, then reuses the grant for exec/upload/download", async () => {
    const f = fixture();
    const host = f.service.createHost(
      {
        name: "h",
        address: "127.0.0.1",
        username: "deploy",
        privateKey: f.privateKey,
        requireApproval: true,
      },
      "op",
    );
    f.service.replaceAppHosts(f.agent.appId, [host.id], "op");
    await expect(
      f.service.exec(f.agent, { hostId: host.id, command: "true" }),
    ).rejects.toMatchObject({
      code: "ssh_approval_pending",
    });
    const pending = f.service.listPending(f.agent.appId)[0];
    if (pending === undefined) throw new Error("pending approval missing");
    f.service.decideApproval(pending.id, f.agent.appId, "approve", "op");
    await expect(
      f.service.exec(f.agent, { hostId: host.id, command: "true" }),
    ).resolves.toMatchObject({ ok: true });
    writeFileSync(path.join(f.appDir, "new.txt"), "payload");
    await expect(
      f.service.upload(f.agent, {
        hostId: host.id,
        localPath: "new.txt",
        remotePath: "/srv/app/new.txt",
      }),
    ).resolves.toMatchObject({ ok: true, bytes: 7 });
    await expect(
      f.service.download(f.agent, {
        hostId: host.id,
        remotePath: "/srv/app/old.txt",
        localPath: "old.txt",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("prepares a re-pin observation and clears the pin when the address changes", async () => {
    const f = fixture();
    const host = f.service.createHost(
      { name: "h", address: "127.0.0.1", username: "deploy", privateKey: f.privateKey },
      "op",
    );
    f.service.replaceAppHosts(f.agent.appId, [host.id], "op");
    await f.service.testHost(host.id);
    expect(f.service.getHostView(host.id)?.hostKeyFingerprint).toBe(f.pin);

    const nextPin = "SHA256:next-pin";
    const rotating = new SshService({
      db: f.db,
      secretKey: Buffer.alloc(32, 7),
      workspaceRoot: path.dirname(f.appDir),
      agentsHome: path.join(path.dirname(f.appDir), "agents"),
      connect: (() => Promise.resolve(fakeConnection(nextPin))) as unknown as typeof connectSsh,
    });
    const prepared = await rotating.testHost(host.id, { ignorePin: true });
    expect(prepared).toMatchObject({ ok: true, fingerprint: nextPin, previousFingerprint: f.pin });
    rotating.rePin(host.id, nextPin, "op");
    expect(rotating.getHostView(host.id)?.hostKeyFingerprint).toBe(nextPin);

    rotating.updateHost(host.id, { address: "127.0.0.2" }, "op");
    expect(rotating.getHostView(host.id)?.hostKeyFingerprint).toBeNull();
  });

  it("records a host-key mismatch without accepting the new key", async () => {
    const f = fixture();
    const host = f.service.createHost(
      { name: "h", address: "127.0.0.1", username: "deploy", privateKey: f.privateKey },
      "op",
    );
    f.service.replaceAppHosts(f.agent.appId, [host.id], "op");
    await f.service.testHost(host.id);
    const mismatch = new SshService({
      db: f.db,
      secretKey: Buffer.alloc(32, 7),
      workspaceRoot: path.dirname(f.appDir),
      agentsHome: path.join(path.dirname(f.appDir), "agents"),
      connect: (() =>
        Promise.reject(
          new SshError("ssh_host_key_mismatch", "changed", {
            presentedFingerprint: "SHA256:attacker",
          }),
        )) as unknown as typeof connectSsh,
    });
    const result = await mismatch.testHost(host.id);
    expect(result).toMatchObject({ ok: false, code: "ssh_host_key_mismatch" });
    const view = mismatch.getHostView(host.id);
    expect(view?.hostKeyFingerprint).toBe(f.pin);
    expect(view?.hostKeyMismatchAt).not.toBeNull();
  });
});
