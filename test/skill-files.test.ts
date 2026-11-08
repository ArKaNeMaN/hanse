import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashValue } from "../src/settings/hash.js";
import { type SkillApplyOptions, SkillService } from "../src/skills/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { reconcileSkillFiles } from "../src/store/reconcile-skill-files.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  databases.length = 0;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-skill-files-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const service = new SkillService({ db });
  const appRoot = path.join(dir, "app");
  const xdg = path.join(appRoot, "config");
  const home = path.join(appRoot, "home");
  const cache = path.join(appRoot, "cache");
  const appDir = path.join(appRoot, "repo");
  for (const target of [xdg, home, cache, appDir]) {
    mkdirSync(target, { recursive: true });
  }
  const options: SkillApplyOptions = {
    appRoot,
    home,
    xdgCacheHome: cache,
    appDir,
  };
  return { db, service, xdg, options };
}

const binaryBytes = Buffer.from([0, 1, 2, 255, 254]);
const binaryBase64 = binaryBytes.toString("base64");

describe("local arbitrary skill files", () => {
  it("round-trips text and binary files, materializes them, and preserves non-projection files", () => {
    const f = fixture();
    const row = f.service.create(
      "global",
      {},
      {
        name: "files-demo",
        description: "Files",
        content: "Body",
        files: [
          { path: "references/guide.md", text: "guide" },
          { path: "scripts/run.sh", text: "#!/bin/sh\necho hi\n", executable: true },
          { path: "assets/logo.bin", base64: binaryBase64 },
        ],
      },
      "owner",
    );
    expect(row.files?.map((file) => file.path)).toEqual([
      "assets/logo.bin",
      "references/guide.md",
      "scripts/run.sh",
    ]);
    expect(row.references).toEqual([{ path: "references/guide.md", content: "guide" }]);

    const applied = f.service.apply({}, f.xdg, f.options);
    expect(applied.written).toContain("skills/files-demo/scripts/run.sh");
    expect(
      readFileSync(path.join(f.xdg, "opencode", "skills", "files-demo", "assets", "logo.bin")),
    ).toEqual(binaryBytes);
    expect(
      readFileSync(path.join(f.xdg, "opencode", "skills", "files-demo", "SKILL.md"), "utf8"),
    ).toContain("name: files-demo");

    const updated = f.service.update(row.id, { references: [] }, "owner");
    expect(updated.files?.map((file) => file.path)).toEqual(["assets/logo.bin", "scripts/run.sh"]);
    expect(updated.references).toEqual([]);
  });

  it("rejects a files payload containing SKILL.md and an occupied reference path", () => {
    const f = fixture();
    expect(() =>
      f.service.create(
        "global",
        {},
        {
          name: "bad",
          description: "Bad",
          content: "Body",
          files: [{ path: "SKILL.md", text: "no" }],
        },
        "owner",
      ),
    ).toThrow(/file path/);

    const row = f.service.create(
      "global",
      {},
      {
        name: "occupied",
        description: "Occupied",
        content: "Body",
        files: [{ path: "assets/logo.bin", base64: binaryBase64 }],
      },
      "owner",
    );
    expect(() =>
      f.service.update(
        row.id,
        { references: [{ path: "assets/logo.bin", content: "not a reference" }] },
        "owner",
      ),
    ).toThrow();
  });

  it("copies arbitrary files through override", () => {
    const f = fixture();
    const source = f.service.create(
      "global",
      {},
      {
        name: "copy-me",
        description: "Copy",
        content: "Body",
        files: [{ path: "assets/logo.bin", base64: binaryBase64 }],
      },
      "owner",
    );
    const override = f.service.override(source.id, "project", { projectId: "p" }, true, "owner");
    expect(override.files?.map((file) => file.path)).toEqual(["assets/logo.bin"]);
    expect(override.origin).toBe("local");
  });

  it("reconciles a rolled-back legacy reference edit into skill_files", () => {
    const f = fixture();
    const row = f.service.create(
      "global",
      {},
      {
        name: "reconcile",
        description: "Reconcile",
        content: "Body",
        references: [{ path: "references/guide.md", content: "before" }],
      },
      "owner",
    );
    const later = new Date(Date.now() + 60_000).toISOString();
    f.db
      .prepare("UPDATE skill_references SET content = ? WHERE skill_id = ? AND path = ?")
      .run("after", row.id, "references/guide.md");
    f.db.prepare("UPDATE skills SET updated_at = ? WHERE id = ?").run(later, row.id);
    reconcileSkillFiles(f.db);
    const files = f.service.get(row.id)?.files ?? [];
    expect(Buffer.from(files[0]?.content ?? []).toString("utf8")).toBe("after");
  });

  it("keeps the legacy hash for references-only skills and switches on an arbitrary file", () => {
    const f = fixture();
    const row = f.service.create(
      "global",
      {},
      {
        name: "hash-demo",
        description: "Hash",
        content: "Body",
        references: [{ path: "references/guide.md", content: "guide" }],
      },
      "owner",
    );
    const legacy = hashValue([
      {
        name: "hash-demo",
        description: "Hash",
        content: "Body",
        references: [{ path: "references/guide.md", content: "guide" }],
      },
    ]);
    expect(f.service.hash({})).toBe(legacy);
    f.service.update(
      row.id,
      {
        files: [
          { path: "references/guide.md", text: "guide" },
          { path: "assets/logo.bin", base64: binaryBase64 },
        ],
      },
      "owner",
    );
    expect(f.service.hash({})).not.toBe(legacy);
  });
});
