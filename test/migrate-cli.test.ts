import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/cli.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function collector(): {
  lines: string[];
  io: { stdout(line: string): void; stderr(line: string): void };
} {
  const lines: string[] = [];
  return {
    lines,
    io: {
      stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(line),
    },
  };
}

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-migrate-"));
  dirs.push(dir);
  return path.join(dir, "coordinator.db");
}

function ensureDatabase(file: string): void {
  const db = openDatabase(file);
  runMigrations(db);
  db.close();
}

describe("hanse migrate", () => {
  it("returns exit 0 for a fully migrated database", async () => {
    const file = tempDb();
    ensureDatabase(file);
    const { lines, io } = collector();
    const code = await runCli(["migrate", "--check", "--db", file, "--json"], io);
    expect(code).toBe(0);
    const report = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(report).toMatchObject({
      current: 27,
      target: 27,
      pending: [],
      pendingCount: 0,
      backwardCompatible: true,
      requiresExclusive: false,
      estimatedMs: 0,
    });
  });

  it("returns exit 10 when migrations are pending", async () => {
    const file = tempDb();
    const db = openDatabase(file);
    db.close();
    const { lines, io } = collector();
    const code = await runCli(["migrate", "--check", "--db", file, "--json"], io);
    expect(code).toBe(10);
    const report = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(report).toMatchObject({
      current: 0,
      target: 27,
      pendingCount: 27,
      backwardCompatible: false,
      requiresExclusive: true,
    });
    expect((report.pending as unknown[]).length).toBe(27);
  });

  it("returns exit 20 for a database newer than the binary", async () => {
    const file = tempDb();
    ensureDatabase(file);
    const db = openDatabase(file);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (999, 'future', 'x', '2026-01-01T00:00:00.000Z')",
    ).run();
    db.close();
    const { lines, io } = collector();
    const code = await runCli(["migrate", "--check", "--db", file, "--json"], io);
    expect(code).toBe(20);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ current: 999, newer: true });
  });

  it("applies only additive pending migrations with --online", async () => {
    const file = tempDb();
    ensureDatabase(file);
    const db = openDatabase(file);
    db.exec(
      "DELETE FROM schema_migrations WHERE version = 26; " +
        "DROP TABLE notification_outbox; DROP TABLE notification_watermarks; " +
        "DROP TABLE notification_meta; DROP TABLE notification_channel_state;",
    );
    db.close();
    const { lines, io } = collector();
    const code = await runCli(["migrate", "--online", "--db", file, "--json"], io);
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ applied: 1, current: 27, target: 27 });
    const verify = openDatabase(file);
    const row = verify
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_outbox'",
      )
      .get();
    expect(row).toBeDefined();
    verify.close();
  });

  it("refuses --online when a pending migration needs an offline upgrade", async () => {
    const file = tempDb();
    const db = openDatabase(file);
    db.close();
    const { lines, io } = collector();
    const code = await runCli(["migrate", "--online", "--db", file, "--json"], io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("migration_requires_offline");
  });

  it("refuses --online for the v27 idle-maintenance migration", async () => {
    const file = tempDb();
    ensureDatabase(file);
    const db = openDatabase(file);
    db.prepare("DELETE FROM schema_migrations WHERE version = 27").run();
    db.close();
    const { lines, io } = collector();
    const code = await runCli(["migrate", "--online", "--db", file, "--json"], io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("migration_requires_offline");
    const report = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(report).toMatchObject({
      code: "migration_requires_offline",
      current: 26,
      target: 27,
      pendingCount: 1,
      requiresExclusive: true,
    });
  });
});
