import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunSshKeygen } from "../src/git/credentials.js";
import {
  type GitAuthLocation,
  GitAuthStore,
  type StoredGitAuthRow,
} from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const now = new Date("2026-10-21T10:00:00.000Z");
const VALID_SSH_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nsentinel-private-body\n-----END OPENSSH PRIVATE KEY-----\n";

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fakeSshKeygen(): RunSshKeygen {
  return (args) => {
    if (args[0] === "-y") {
      return { status: 0, stdout: "ssh-ed25519 AAAAC3NzaFake fake@test\n", stderr: "" };
    }
    if (args[0] === "-lf") {
      return { status: 0, stdout: "256 SHA256:fakefingerprint fake@test (ED25519)\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function fixture(): { db: SqliteDatabase; dir: string; key: Buffer; store: GitAuthStore } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-git-auth-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const key = randomBytes(32);
  return { db, dir, key, store: new GitAuthStore(db, key, { runSshKeygen: fakeSshKeygen() }) };
}

function location(scope: "global" | "project" | "app"): GitAuthLocation {
  if (scope === "global") {
    return { scope, projectId: "", appKey: "" };
  }
  if (scope === "project") {
    return { scope, projectId: "p", appKey: "" };
  }
  return { scope, projectId: "p", appKey: "web" };
}

const HTTPS_VALUE = {
  hosts: ["GitHub.com", "github.com"],
  username: "x-access-token",
  token: "sentinel-token",
};

function row(
  db: SqliteDatabase,
  scope: string,
  key = "git.auth.https",
): { cipher: string | null; nonce: string | null; meta_json: string; cleared: number } | undefined {
  return db
    .prepare(
      "SELECT cipher, nonce, meta_json, cleared FROM setting_secrets WHERE scope = ? AND key = ?",
    )
    .get(scope, key) as
    | { cipher: string | null; nonce: string | null; meta_json: string; cleared: number }
    | undefined;
}

describe("git auth store", () => {
  it("sets HTTPS metadata without plaintext and resolves status", () => {
    const { db, store } = fixture();
    store.set(location("global"), "https", HTTPS_VALUE, "owner", now);

    const stored = row(db, "global");
    expect(stored?.cipher).not.toBeNull();
    expect(stored?.cipher).not.toContain("sentinel-token");
    expect(stored?.meta_json).not.toContain("sentinel-token");
    expect(stored?.meta_json).not.toContain("sentinel-private-body");
    expect(JSON.parse(stored?.meta_json ?? "")).toEqual({
      kind: "https",
      hosts: ["github.com"],
      username: "x-access-token",
    });

    const resolved = store.resolve(store.listFor());
    expect(resolved.https.status).toEqual({
      state: "set",
      kind: "https",
      source: "global",
      hosts: ["github.com"],
      username: "x-access-token",
    });
    expect(resolved.https.value).toEqual({
      hosts: ["github.com"],
      username: "x-access-token",
      token: "sentinel-token",
    });
    expect(resolved.ssh.status).toEqual({ state: "missing", kind: "ssh" });
    expect(JSON.stringify(resolved.ssh)).not.toContain("sentinel-token");
    db.close();
  });

  it("stores SSH public metadata separately from the sealed private key", () => {
    const { db, store } = fixture();
    store.set(location("global"), "ssh", { privateKey: VALID_SSH_KEY }, "owner", now);

    const stored = row(db, "global", "git.auth.ssh");
    expect(stored?.meta_json).not.toContain("sentinel-private-body");
    expect(JSON.parse(stored?.meta_json ?? "")).toEqual({
      kind: "ssh",
      publicKey: "ssh-ed25519 AAAAC3NzaFake fake@test",
      fingerprint: "SHA256:fakefingerprint",
      hasKnownHosts: false,
    });

    const resolved = store.resolve(store.listFor());
    expect(resolved.ssh.status).toEqual({
      state: "set",
      kind: "ssh",
      source: "global",
      publicKey: "ssh-ed25519 AAAAC3NzaFake fake@test",
      fingerprint: "SHA256:fakefingerprint",
      hasKnownHosts: false,
    });
    expect(resolved.ssh.value?.privateKey).toBe(VALID_SSH_KEY);
    expect(JSON.stringify(resolved.ssh.status)).not.toContain("sentinel-private-body");
    db.close();
  });

  it("clears to a tombstone, removes ciphertext, and inherits by deleting the row", () => {
    const { db, dir, store } = fixture();
    const dbPath = path.join(dir, "coordinator.db");
    store.set(location("project"), "https", HTTPS_VALUE, "owner", now);
    const cipher = row(db, "project")?.cipher ?? "";
    expect(cipher.length).toBeGreaterThan(0);

    store.clear(location("project"), "https", "owner", now);
    expect(row(db, "project")).toEqual({
      cipher: null,
      nonce: null,
      meta_json: "{}",
      cleared: 1,
    });
    for (const file of [dbPath, `${dbPath}-wal`].filter((candidate) => existsSync(candidate))) {
      expect(readFileSync(file).includes(cipher)).toBe(false);
    }
    expect(store.resolve(store.listFor("p")).https.status).toEqual({
      state: "cleared",
      kind: "https",
      source: "project",
    });

    store.inherit(location("project"), "https");
    expect(db.prepare("SELECT COUNT(*) AS count FROM setting_secrets").get()).toEqual({ count: 0 });
    db.close();
  });

  it("resolves wide to narrow and keeps the two kinds independent", () => {
    const { store } = fixture();
    store.set(location("global"), "ssh", { privateKey: VALID_SSH_KEY }, "owner", now);
    store.set(location("global"), "https", HTTPS_VALUE, "owner", now);
    store.set(
      location("project"),
      "https",
      { hosts: ["gitlab.com"], username: "project-user", token: "project-token" },
      "owner",
      now,
    );
    store.clear(location("app"), "https", "owner", now);

    const resolved = store.resolve(store.listFor("p", "web"));
    expect(resolved.https.status).toEqual({
      state: "cleared",
      kind: "https",
      source: "app",
    });
    expect(resolved.https.value).toBeUndefined();
    expect(resolved.ssh.status).toMatchObject({ state: "set", source: "global" });
    expect(resolved.ssh.scoped).toEqual({ global: "set", project: "absent", app: "absent" });
    expect(resolved.https.scoped).toEqual({ global: "set", project: "set", app: "cleared" });

    const projectScope = store.resolve(store.listFor("p"));
    expect(projectScope.https.status).toMatchObject({
      state: "set",
      source: "project",
      hosts: ["gitlab.com"],
    });
    expect(projectScope.https.scoped).toEqual({
      global: "set",
      project: "set",
      app: "absent",
    });
  });

  it("reports decrypt and schema failures without falling back or leaking plaintext", () => {
    const { db, store } = fixture();
    store.set(location("global"), "https", HTTPS_VALUE, "owner", now);
    store.set(
      location("project"),
      "https",
      { hosts: ["gitlab.com"], username: "project-user", token: "project-token" },
      "owner",
      now,
    );
    db.prepare(
      "UPDATE setting_secrets SET cipher = 'broken-cipher' WHERE scope = 'project' AND key = 'git.auth.https'",
    ).run();

    const broken = store.resolve(store.listFor("p"));
    expect(broken.https.status).toEqual({
      state: "error",
      kind: "https",
      message: "The stored HTTPS credential could not be decrypted.",
    });
    expect(broken.https.value).toBeUndefined();
    expect(JSON.stringify(broken.https.status)).not.toContain("project-token");

    const globalRow = db
      .prepare(
        "SELECT cipher, nonce FROM setting_secrets WHERE scope = 'global' AND key = 'git.auth.https'",
      )
      .get() as { cipher: string; nonce: string };
    db.prepare(
      "UPDATE setting_secrets SET cipher = ?, nonce = ?, meta_json = '{\"kind\":\"https\"}' WHERE scope = 'project' AND key = 'git.auth.https'",
    ).run(globalRow.cipher, globalRow.nonce);
    const missingMeta = store.resolve(store.listFor("p"));
    expect(missingMeta.https.status).toEqual({
      state: "error",
      kind: "https",
      message: "The stored HTTPS credential is invalid.",
    });
    db.close();
  });

  it("only accepts the v1 keys and rejects an unsupported kind", () => {
    const { db, store } = fixture();
    expect(() => store.set(location("global"), "gpg" as "ssh", HTTPS_VALUE, "owner", now)).toThrow(
      "Unsupported git credential kind",
    );
    expect(() => store.clear(location("global"), "gpg" as "ssh", "owner", now)).toThrow(
      "Unsupported git credential kind",
    );

    db.prepare(
      `INSERT INTO setting_secrets
         (scope, project_id, app_key, key, cipher, nonce, meta_json, cleared, updated_at)
       VALUES ('global','','','git.auth.ssh.example.com','c','n','{}',0,?)`,
    ).run(now.toISOString());
    const rows: StoredGitAuthRow[] = store.listFor();
    const resolved = store.resolve(rows);
    expect(resolved.ssh.status).toEqual({ state: "missing", kind: "ssh" });
    expect(resolved.https.status).toEqual({ state: "missing", kind: "https" });
    db.close();
  });

  it("hashes plaintext credentials and changes when either kind changes", () => {
    const { store } = fixture();
    const empty = store.resolve(store.listFor()).gitAuthHash;
    store.set(location("global"), "https", HTTPS_VALUE, "owner", now);
    const httpsHash = store.resolve(store.listFor()).gitAuthHash;
    expect(httpsHash).not.toBe(empty);
    expect(httpsHash).not.toContain("sentinel-token");

    store.set(location("global"), "ssh", { privateKey: VALID_SSH_KEY }, "owner", now);
    expect(store.resolve(store.listFor()).gitAuthHash).not.toBe(httpsHash);
    store.clear(location("global"), "https", "owner", now);
    expect(store.resolve(store.listFor()).gitAuthHash).not.toBe(httpsHash);
  });
});
