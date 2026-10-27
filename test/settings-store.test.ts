import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderKeyStore, type SettingsScope, SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(): { db: SqliteDatabase; dir: string; key: Buffer } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-settings-store-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  return { db, dir, key: randomBytes(32) };
}

const now = new Date("2026-10-19T10:00:00.000Z");

function providerLocation(
  scope: SettingsScope,
  projectId = "p",
  appKey = "web",
): { scope: SettingsScope; projectId: string; appKey: string } {
  if (scope === "global") {
    return { scope, projectId: "", appKey: "" };
  }
  if (scope === "project") {
    return { scope, projectId, appKey: "" };
  }
  return { scope, projectId, appKey };
}

describe("migration v3", () => {
  it("applies once and creates the settings tables", () => {
    const db = openDatabase(":memory:");
    expect(runMigrations(db)).toBe(19);
    expect(runMigrations(db)).toBe(0);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toContain("settings");
    expect(tables).toContain("provider_keys");
    expect(tables).toContain("setting_secrets");
    expect(tables).not.toContain("secrets");
    db.close();
  });

  it("enforces settings scope shape, key length, and JSON validity", () => {
    const { db } = fixture();
    const insert = db.prepare(
      "INSERT INTO settings (scope, project_id, app_key, key, value_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );

    expect(() => insert.run("global", "p", "", "llm.model", '"a/b"', now.toISOString())).toThrow();
    expect(() => insert.run("project", "", "", "llm.model", '"a/b"', now.toISOString())).toThrow();
    expect(() =>
      insert.run("project", "p", "web", "llm.model", '"a/b"', now.toISOString()),
    ).toThrow();
    expect(() => insert.run("app", "p", "", "llm.model", '"a/b"', now.toISOString())).toThrow();
    expect(() => insert.run("bogus", "", "", "llm.model", '"a/b"', now.toISOString())).toThrow();
    expect(() => insert.run("global", "", "", "", '"a/b"', now.toISOString())).toThrow();
    expect(() =>
      insert.run("global", "", "", "llm.model", "not-json", now.toISOString()),
    ).toThrow();

    insert.run("global", "", "", "llm.model", '"a/b"', now.toISOString());
    expect(() => insert.run("global", "", "", "llm.model", '"c/d"', now.toISOString())).toThrow();
    db.close();
  });

  it("enforces provider tombstone and scope constraints", () => {
    const { db } = fixture();
    const insert = db.prepare(
      `INSERT INTO provider_keys
         (scope, project_id, app_key, provider, cipher, nonce, cleared, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run("global", "", "", "", "cipher", "nonce", 0, now.toISOString()),
    ).toThrow();
    expect(() =>
      insert.run("global", "p", "", "deepseek", "cipher", "nonce", 0, now.toISOString()),
    ).toThrow();
    expect(() =>
      insert.run("app", "p", "", "deepseek", "cipher", "nonce", 0, now.toISOString()),
    ).toThrow();
    expect(() =>
      insert.run("global", "", "", "deepseek", null, null, 0, now.toISOString()),
    ).toThrow();
    expect(() =>
      insert.run("global", "", "", "deepseek", "cipher", "nonce", 1, now.toISOString()),
    ).toThrow();
    expect(() =>
      insert.run("global", "", "", "deepseek", null, null, 2, now.toISOString()),
    ).toThrow();

    insert.run("global", "", "", "deepseek", null, null, 1, now.toISOString());
    insert.run("global", "", "", "openai", "cipher", "nonce", 0, now.toISOString());
    db.close();
  });

  it("supports settings CRUD and uniqueness through SettingsService", () => {
    const { db, key } = fixture();
    const service = new SettingsService({ db, secretKey: key, now: () => now });

    service.set("global", {}, "llm.model", "provider/one", "owner");
    expect(
      (
        db.prepare("SELECT value_json FROM settings WHERE key = 'llm.model'").get() as {
          value_json: string;
        }
      ).value_json,
    ).toBe('"provider/one"');

    service.set("global", {}, "llm.model", "provider/two", "owner-2");
    const rows = db.prepare("SELECT updated_by FROM settings WHERE key = 'llm.model'").all() as {
      updated_by: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updated_by).toBe("owner-2");

    service.inherit("global", {}, "llm.model");
    expect(db.prepare("SELECT COUNT(*) AS count FROM settings").get()).toEqual({ count: 0 });
    db.close();
  });
});

describe("provider key storage", () => {
  it("seals on set and round-trips on resolve", () => {
    const { db, key } = fixture();
    const store = new ProviderKeyStore(db, key);
    store.set(providerLocation("global"), "deepseek", "sentinel-secret", "owner", now);

    const row = db
      .prepare("SELECT cipher, nonce, cleared FROM provider_keys WHERE provider = 'deepseek'")
      .get() as { cipher: string; nonce: string; cleared: number };
    expect(row.cipher).not.toContain("sentinel-secret");
    expect(row.nonce.length).toBeGreaterThan(0);
    expect(row.cleared).toBe(0);

    const resolved = store.resolve("deepseek", store.listFor(), {});
    expect(resolved.status).toEqual({ state: "set", source: "global" });
    expect(resolved.key).toBe("sentinel-secret");
    db.close();
  });

  it("removes the previous ciphertext from the DB/WAL on clear", () => {
    const { db, dir, key } = fixture();
    const dbPath = path.join(dir, "coordinator.db");
    const store = new ProviderKeyStore(db, key);
    const location = providerLocation("global");
    store.set(location, "deepseek", "sentinel-secret", "owner", now);
    const row = db
      .prepare("SELECT cipher FROM provider_keys WHERE provider = 'deepseek'")
      .get() as { cipher: string };
    store.clear(location, "deepseek", "owner", now);
    const files = [dbPath, `${dbPath}-wal`].filter((file) => existsSync(file));
    for (const file of files) {
      expect(readFileSync(file).includes(row.cipher)).toBe(false);
    }
  });

  it("clears ciphertext when writing a tombstone and deletes on inherit", () => {
    const { db, key } = fixture();
    const store = new ProviderKeyStore(db, key);
    const location = providerLocation("project", "p", "");
    store.set(location, "deepseek", "sentinel-secret", "owner", now);
    store.clear(location, "deepseek", "owner", now);

    const row = db
      .prepare(
        "SELECT cipher, nonce, cleared FROM provider_keys WHERE scope = 'project' AND provider = 'deepseek'",
      )
      .get() as { cipher: string | null; nonce: string | null; cleared: number };
    expect(row).toEqual({ cipher: null, nonce: null, cleared: 1 });
    expect(store.resolve("deepseek", store.listFor("p"), {})).toEqual({
      status: { state: "cleared", source: "project" },
    });

    store.inherit(location, "deepseek");
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_keys").get()).toEqual({ count: 0 });
    db.close();
  });

  it("updates instead of duplicating on repeated set", () => {
    const { db, key } = fixture();
    const store = new ProviderKeyStore(db, key);
    const location = providerLocation("app");
    store.set(location, "deepseek", "one", "owner", now);
    store.set(location, "deepseek", "two", "owner", now);
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_keys").get()).toEqual({ count: 1 });
    expect(store.resolve("deepseek", store.listFor("p", "web"), {}).key).toBe("two");
    db.close();
  });

  it("reports an error for corrupted or undecryptable ciphertext", () => {
    const { db, key } = fixture();
    const store = new ProviderKeyStore(db, key);
    store.set(providerLocation("global"), "deepseek", "sentinel-secret", "owner", now);
    const rows = store.listFor();
    const broken = rows.map((row) => ({ ...row, cipher: "not-a-valid-cipher" }));
    expect(store.resolve("deepseek", broken, {})).toEqual({
      status: {
        state: "error",
        message: 'provider key for "deepseek" could not be decrypted',
      },
    });

    const wrongKey = new ProviderKeyStore(db, randomBytes(32));
    const wrong = wrongKey.resolve("deepseek", rows, {});
    expect(wrong.status.state).toBe("error");
    expect(wrong.status.state === "error" ? wrong.status.message : "").not.toContain(
      "sentinel-secret",
    );
    db.close();
  });
});
