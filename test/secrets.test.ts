import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCredential,
  handleGitCredential,
  listCredentialHosts,
  loadOrCreateKey,
  open,
  putCredential,
  seal,
} from "../src/secrets/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(): { db: SqliteDatabase; key: Buffer; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-sec-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const key = loadOrCreateKey(path.join(dir, "secret.key"));
  return { db, key, dir };
}

describe("secrets", () => {
  it("creates a 32-byte key with restrictive permissions", () => {
    const { dir } = fixture();
    const keyPath = path.join(dir, "secret.key");
    expect(readFileSync(keyPath).length).toBe(32);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("round-trips seal/open and rejects a wrong key", () => {
    const key = randomBytes(32);
    const sealed = seal(key, "token-value");
    expect(open(key, sealed)).toBe("token-value");
    expect(() => open(randomBytes(32), sealed)).toThrow();
  });

  it("stores credentials encrypted at rest", () => {
    const { db, key } = fixture();
    putCredential(db, key, { host: "github.com", username: "x-access-token", token: "s3cret" });
    expect(getCredential(db, key, "github.com")?.token).toBe("s3cret");
    const row = db.prepare("SELECT cipher FROM secrets WHERE host = 'github.com'").get() as {
      cipher: string;
    };
    expect(row.cipher).not.toContain("s3cret");
    expect(listCredentialHosts(db)).toEqual(["github.com"]);
    db.close();
  });

  it("answers git credential requests for a stored host only", () => {
    const { db, key } = fixture();
    putCredential(db, key, { host: "github.com", username: "x-access-token", token: "s3cret" });
    const found = handleGitCredential(db, key, "protocol=https\nhost=github.com\n\n");
    expect(found.found).toBe(true);
    expect(found.output).toContain("username=x-access-token");
    expect(found.output).toContain("password=s3cret");
    const missing = handleGitCredential(db, key, "protocol=https\nhost=gitlab.com\n\n");
    expect(missing.found).toBe(false);
    db.close();
  });
});
