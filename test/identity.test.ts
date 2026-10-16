import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthError, authenticate, requireKind } from "../src/identity/auth.js";
import { createPrincipal, verifyToken } from "../src/identity/principals.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(): SqliteDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-id-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  return db;
}

describe("identity", () => {
  it("verifies a token round-trip and rejects others", () => {
    const db = fixture();
    const { principal, token } = createPrincipal(db, { kind: "human", name: "alice" });
    expect(verifyToken(db, token)?.id).toBe(principal.id);
    expect(verifyToken(db, "nope")).toBeUndefined();
    db.close();
  });

  it("authenticates a bearer token and rejects missing or invalid ones", () => {
    const db = fixture();
    const { token } = createPrincipal(db, { kind: "agent", name: "web" });
    expect(authenticate(db, `Bearer ${token}`).name).toBe("web");
    expect(() => authenticate(db, undefined)).toThrow(AuthError);
    expect(() => authenticate(db, "Bearer bad")).toThrow(AuthError);
    db.close();
  });

  it("enforces principal kinds", () => {
    const db = fixture();
    const { principal } = createPrincipal(db, { kind: "agent", name: "web" });
    expect(() => requireKind(principal, ["human"])).toThrow(AuthError);
    expect(() => requireKind(principal, ["agent", "human"])).not.toThrow();
    db.close();
  });
});
