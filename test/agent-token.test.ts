import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentTokenMatches,
  ensureAgentToken,
  hashAgentToken,
  mcpTokenPath,
  mintAgentToken,
  revokeAgentToken,
  verifyAgentToken,
  writeAgentTokenFile,
} from "../src/mcp/agent-tokens.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): { db: SqliteDatabase; tokenFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-agent-token-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/workspace/p',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:b','p','b','apps/b','AGENTS.md',?)",
  ).run(now);
  return { db, tokenFile: mcpTokenPath(dir, { projectId: "p", app: "a" }) };
}

function activeHashes(db: SqliteDatabase): string[] {
  return (
    db
      .prepare("SELECT token_hash FROM agent_tokens WHERE app_id = 'p:a' AND revoked_at IS NULL")
      .all() as { token_hash: string }[]
  ).map((row) => row.token_hash);
}

describe("agent tokens", () => {
  it("mints, verifies, and revokes a token", () => {
    const { db } = fixture();
    const token = mintAgentToken(db, "p:a");

    expect(verifyAgentToken(db, token)).toEqual({ appId: "p:a", projectId: "p", appKey: "a" });
    expect(verifyAgentToken(db, "not-a-token")).toBeUndefined();

    revokeAgentToken(db, "p:a");
    expect(verifyAgentToken(db, token)).toBeUndefined();
  });

  it("stores only the hash and revokes the previous token when minting", () => {
    const { db } = fixture();
    const first = mintAgentToken(db, "p:a");
    const second = mintAgentToken(db, "p:a");

    expect(first).not.toBe(second);
    expect(activeHashes(db)).toEqual([hashAgentToken(second)]);
    expect(verifyAgentToken(db, first)).toBeUndefined();
    expect(verifyAgentToken(db, second)).toBeDefined();
  });

  it("rolls back the revoke when the insert fails in one transaction", () => {
    const { db } = fixture();
    const first = mintAgentToken(db, "p:a");
    db.prepare(
      `CREATE TRIGGER reject_token_insert BEFORE INSERT ON agent_tokens
       BEGIN SELECT RAISE(ABORT, 'insert rejected'); END;`,
    ).run();

    expect(() => mintAgentToken(db, "p:a")).toThrow(/insert rejected/);

    expect(activeHashes(db)).toEqual([hashAgentToken(first)]);
    expect(verifyAgentToken(db, first)).toBeDefined();
  });

  it("writes the token file atomically with mode 0600", () => {
    const { tokenFile } = fixture();
    writeAgentTokenFile(tokenFile, "token-value");

    expect(readFileSync(tokenFile, "utf8")).toBe("token-value");
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it("reuses a valid file and hash on coordinator restart", () => {
    const { db, tokenFile } = fixture();
    const first = ensureAgentToken(db, "p:a", tokenFile);
    const second = ensureAgentToken(db, "p:a", tokenFile);

    expect(second).toBe(first);
    expect(readFileSync(tokenFile, "utf8")).toBe(first);
    expect(activeHashes(db)).toEqual([hashAgentToken(first)]);
    expect(agentTokenMatches(db, "p:a", tokenFile)).toBe(true);
  });

  it("rotates when the token file is missing", () => {
    const { db, tokenFile } = fixture();
    const first = ensureAgentToken(db, "p:a", tokenFile);
    rmSync(tokenFile);

    const second = ensureAgentToken(db, "p:a", tokenFile);

    expect(second).not.toBe(first);
    expect(verifyAgentToken(db, first)).toBeUndefined();
    expect(verifyAgentToken(db, second)).toBeDefined();
    expect(readFileSync(tokenFile, "utf8")).toBe(second);
  });

  it("rotates when the file hash does not match the stored row", () => {
    const { db, tokenFile } = fixture();
    const first = ensureAgentToken(db, "p:a", tokenFile);
    writeAgentTokenFile(tokenFile, "some-other-token");

    const second = ensureAgentToken(db, "p:a", tokenFile);

    expect(second).not.toBe(first);
    expect(verifyAgentToken(db, first)).toBeUndefined();
    expect(verifyAgentToken(db, second)).toBeDefined();
    expect(readFileSync(tokenFile, "utf8")).toBe(second);
  });

  it("rotates when the stored row is missing", () => {
    const { db, tokenFile } = fixture();
    const first = ensureAgentToken(db, "p:a", tokenFile);
    db.prepare("DELETE FROM agent_tokens").run();

    const second = ensureAgentToken(db, "p:a", tokenFile);

    expect(second).not.toBe(first);
    expect(verifyAgentToken(db, first)).toBeUndefined();
    expect(verifyAgentToken(db, second)).toBeDefined();
  });

  it("leaves no active row when the token file write fails, then repairs on retry", () => {
    const { db, tokenFile } = fixture();
    const first = ensureAgentToken(db, "p:a", tokenFile);
    rmSync(tokenFile);
    mkdirSync(tokenFile);

    expect(() => ensureAgentToken(db, "p:a", tokenFile)).toThrow();
    expect(activeHashes(db)).toEqual([]);
    expect(verifyAgentToken(db, first)).toBeUndefined();

    rmSync(tokenFile, { recursive: true });
    const repaired = ensureAgentToken(db, "p:a", tokenFile);

    expect(activeHashes(db)).toEqual([hashAgentToken(repaired)]);
    expect(readFileSync(tokenFile, "utf8")).toBe(repaired);
    expect(verifyAgentToken(db, repaired)).toBeDefined();
  });

  it("sanitizes the project and app segments of the token path", () => {
    expect(mcpTokenPath("/data/agents", { projectId: "p/1", app: "web app" })).toBe(
      path.join("/data/agents", "p-1", "web-app", "mcp-token"),
    );
  });
});
