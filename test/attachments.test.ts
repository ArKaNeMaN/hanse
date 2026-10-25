import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalPathFor, tempPathFor } from "../src/attachments/commit.js";
import { attachmentsForRefs } from "../src/attachments/delivery.js";
import { sniffMime } from "../src/attachments/mime.js";
import {
  encodeContentDisposition,
  safeOriginalName,
  storedNameFor,
} from "../src/attachments/names.js";
import { attachmentsHostRoot, attachmentVisibleRoot } from "../src/attachments/paths.js";
import { quotaView, uploadCoordinator } from "../src/attachments/quota.js";
import {
  listAppAttachmentRoots,
  markMissingFiles,
  reconcileUploading,
  sweepOrphanFiles,
} from "../src/attachments/reconcile.js";
import { openAttachmentFile } from "../src/attachments/storage.js";
import { readAttachment } from "../src/attachments/store.js";
import { attachmentTitle } from "../src/attachments/title.js";
import type { AttachmentKind } from "../src/attachments/types.js";
import { attachmentView, deriveAttachmentState } from "../src/attachments/views.js";
import {
  ATTACHMENTS_POLICY_VERSION,
  buildPermissionPolicy,
  resolvePermissionPaths,
} from "../src/opencode/policy.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  uploadCoordinator.resetForTests();
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { db: SqliteDatabase; agentsHome: string; appRoot: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-attachments-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(path.join(dir, "project"), now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  const agentsHome = path.join(dir, "agents");
  const appRoot = path.dirname(attachmentsHostRoot(agentsHome, "p", "a"));
  mkdirSync(path.join(appRoot, "attachments", "ses_1", ".tmp"), { recursive: true });
  return { db, agentsHome, appRoot };
}

function insertRow(
  db: SqliteDatabase,
  input: {
    id: string;
    kind?: AttachmentKind | null;
    state?: "uploading" | "available" | "missing";
    tempRelPath?: string | null;
    relPath?: string | null;
    storedName?: string | null;
    mime?: string | null;
    size?: number | null;
    declaredSize?: number | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_attachments
       (id, app_id, session_id, original_name, stored_name, rel_path, temp_rel_path, mime, size,
        declared_size, kind, mode, state, created_at, updated_at)
     VALUES (?, 'p:a', 'ses_1', 'file.bin', ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)`,
  ).run(
    input.id,
    input.storedName ?? null,
    input.relPath ?? null,
    input.tempRelPath ?? null,
    input.mime ?? null,
    input.size ?? null,
    input.declaredSize ?? null,
    input.kind ?? null,
    input.state ?? "uploading",
    now,
    now,
  );
}

describe("attachment names and MIME", () => {
  it("normalizes names, removes separators and control characters, and caps bytes", () => {
    expect(safeOriginalName("  ..\\evil\r\nname\u0000.svg ")).toBe("evilname.svg");
    expect(safeOriginalName("../")).toBe("");
    const long = `${"é".repeat(300)}.txt`;
    expect(Buffer.byteLength(safeOriginalName(long), "utf8")).toBeLessThanOrEqual(255);
    const stored = storedNameFor("att_1", "é".repeat(300));
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(255);
    expect(stored.startsWith("att_1-")).toBe(true);
  });

  it("emits a plain filename fallback and strips line separators", () => {
    const header = encodeContentDisposition("attachment", "a'b.txt");
    expect(header).toContain('filename="a\'b.txt"');
    expect(header).toContain("filename*=UTF-8''a%27b.txt");
    expect(safeOriginalName("a\u2028b.txt")).toBe("ab.txt");
    expect(attachmentTitle("A\u2029B")).toBe("AB");
  });

  it("sniffs magic bytes and treats SVG/HTML as files", () => {
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "x")).toEqual({
      mime: "image/png",
      kind: "image",
    });
    expect(sniffMime(Buffer.from("%PDF-1.7"), "x.pdf")).toEqual({
      mime: "application/pdf",
      kind: "pdf",
    });
    expect(sniffMime(Buffer.from("RIFF0000WEBP"), "x.webp").kind).toBe("image");
    expect(sniffMime(Buffer.from("0000ftypisom"), "x.mp4").kind).toBe("video");
    expect(sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), "x.svg")).toEqual({
      mime: "image/svg+xml",
      kind: "file",
    });
    expect(sniffMime(Buffer.from("<!doctype html><html>"), "x.html").kind).toBe("file");
    expect(sniffMime(Buffer.from("a,b\n1,2\n"), "x.csv")).toEqual({
      mime: "text/csv",
      kind: "file",
    });
  });

  it("resolves host and runner-visible attachment roots", () => {
    expect(attachmentsHostRoot("/agents", "My Project", "My App")).toBe(
      "/agents/My-Project/My-App/attachments",
    );
    expect(
      attachmentVisibleRoot({
        agentsHome: "/agents",
        projectId: "My Project",
        appKey: "My App",
        pathMode: "host",
      }),
    ).toBe("/data/agents/My-Project/My-App/attachments");
    expect(
      attachmentVisibleRoot({
        agentsHome: "/agents",
        projectId: "p",
        appKey: "a",
        pathMode: "container",
      }),
    ).toBe("/agents/p/a/attachments");
  });
});

describe("attachment policy root", () => {
  it("adds the visible attachments root to trusted paths and carries a version", () => {
    const roots = resolvePermissionPaths({ attachmentsRoot: "/data/agents/p/a/attachments" });
    expect(roots).toContain("/data/agents/p/a/attachments");
    const policy = buildPermissionPolicy(roots);
    expect(policy.external_directory["/data/agents/p/a/attachments/*"]).toBe("allow");
    expect(ATTACHMENTS_POLICY_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("attachment quota and views", () => {
  it("computes the quota percentage", () => {
    expect(quotaView(0)).toEqual({ percent: 0 });
    expect(quotaView(2.5 * 1024 * 1024 * 1024)).toEqual({ percent: 50 });
    expect(quotaView(6 * 1024 * 1024 * 1024)).toEqual({ percent: 100 });
  });

  it("derives state precedence missing > in_flight > sent > draft", () => {
    const row = {
      id: "att_1",
      appId: "p:a",
      sessionId: "ses_1",
      originalName: "a.txt",
      storedName: "att_1-a.txt",
      relPath: "attachments/ses_1/att_1-a.txt",
      tempRelPath: null,
      mime: "text/plain",
      size: 3,
      declaredSize: null,
      kind: "file" as const,
      mode: "auto" as const,
      state: "available" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(deriveAttachmentState(row, [])).toBe("draft");
    expect(deriveAttachmentState(row, ["sent"])).toBe("sent");
    expect(deriveAttachmentState(row, ["sent", "sending"])).toBe("in_flight");
    expect(deriveAttachmentState({ ...row, state: "missing" }, ["sent"])).toBe("missing");
    expect(attachmentView(row, { appKey: "a", projectId: "p" })).toMatchObject({
      id: "att_1",
      name: "a.txt",
      mime: "text/plain",
      size: 3,
      kind: "file",
      mode: "auto",
      state: "draft",
      inline: false,
    });
  });
});

describe("attachment commit reconciliation", () => {
  it("promotes a final file with matching metadata and a complete commit-window temp", () => {
    const { db, appRoot } = fixture();
    const finalFile = path.join(appRoot, "attachments", "ses_1", "att_1-final.txt");
    writeFileSync(finalFile, "hello");
    insertRow(db, {
      id: "att_1",
      storedName: "att_1-final.txt",
      relPath: "attachments/ses_1/att_1-final.txt",
      mime: "text/plain",
      size: 5,
      kind: "file",
    });

    const tempFile = path.join(appRoot, "attachments", "ses_1", ".tmp", "att_2.part");
    writeFileSync(tempFile, "world");
    insertRow(db, {
      id: "att_2",
      storedName: "att_2-world.txt",
      relPath: "attachments/ses_1/att_2-world.txt",
      tempRelPath: "attachments/ses_1/.tmp/att_2.part",
      mime: "text/plain",
      size: 5,
      kind: "file",
    });

    const changed = reconcileUploading(db, (appId) => (appId === "p:a" ? appRoot : undefined), {
      now: Date.now(),
      activeIds: new Set(),
    });
    expect(changed).toBe(2);
    expect(statSync(finalFile).size).toBe(5);
    expect(statSync(path.join(appRoot, "attachments/ses_1/att_2-world.txt")).size).toBe(5);
    const rows = db
      .prepare("SELECT id, state, temp_rel_path AS temp FROM app_attachments ORDER BY id")
      .all() as Array<{ id: string; state: string; temp: string | null }>;
    expect(rows).toEqual([
      { id: "att_1", state: "available", temp: null },
      { id: "att_2", state: "available", temp: null },
    ]);
    void finalPathFor;
    void tempPathFor;
  });

  it("discards partial streams and temp-only rows, and skips active uploads", () => {
    const { db, appRoot } = fixture();
    const partial = path.join(appRoot, "attachments", "ses_1", ".tmp", "att_1.part");
    writeFileSync(partial, "partial");
    insertRow(db, {
      id: "att_1",
      tempRelPath: "attachments/ses_1/.tmp/att_1.part",
      declaredSize: 100,
    });
    const active = path.join(appRoot, "attachments", "ses_1", ".tmp", "att_2.part");
    writeFileSync(active, "active");
    insertRow(db, {
      id: "att_2",
      tempRelPath: "attachments/ses_1/.tmp/att_2.part",
      declaredSize: 100,
    });
    reconcileUploading(db, (appId) => (appId === "p:a" ? appRoot : undefined), {
      now: Date.now(),
      activeIds: new Set(["att_2"]),
    });
    expect(
      (db.prepare("SELECT id FROM app_attachments ORDER BY id").all() as { id: string }[]).map(
        (row) => row.id,
      ),
    ).toEqual(["att_2"]);
    expect(() => statSync(partial)).toThrow();
    expect(statSync(active).size).toBe(6);
  });

  it("cascades attachment rows and deliveries when the app row is deleted", () => {
    const { db } = fixture();
    insertRow(db, {
      id: "att_1",
      state: "available",
      storedName: "att_1-a.txt",
      relPath: "attachments/ses_1/att_1-a.txt",
      mime: "text/plain",
      size: 1,
      kind: "file",
    });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO attachment_deliveries
         (id, attachment_id, app_id, session_id, part_id, message_id, state, error_code, created_at, updated_at)
       VALUES ('del_1','att_1','p:a','ses_1',NULL,'msg_1','sent',NULL,?,?)`,
    ).run(now, now);
    db.prepare("DELETE FROM apps WHERE id = 'p:a'").run();
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM app_attachments").get() as { count: number })
        .count,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM attachment_deliveries").get() as { count: number })
        .count,
    ).toBe(0);
  });

  it("marks missing available files and removes old orphan files", () => {
    const { db, agentsHome, appRoot } = fixture();
    insertRow(db, {
      id: "att_1",
      state: "available",
      storedName: "att_1-gone.txt",
      relPath: "attachments/ses_1/att_1-gone.txt",
      mime: "text/plain",
      size: 5,
      kind: "file",
    });
    const orphan = path.join(appRoot, "attachments", "ses_1", "orphan.bin");
    writeFileSync(orphan, "orphan");
    const old = Date.now() / 1000 - 2 * 24 * 60 * 60;
    utimesSync(orphan, old, old);
    const roots = listAppAttachmentRoots(db, agentsHome);
    expect(markMissingFiles(db, roots)).toBe(1);
    expect(sweepOrphanFiles(db, roots)).toBe(1);
    expect(() => statSync(orphan)).toThrow();
    expect(renameSync).toBeDefined();
  });
});

describe("container safety and retry validation", () => {
  it("does not follow a symlinked attachments root during orphan sweeps", () => {
    const { db, appRoot } = fixture();
    const outside = mkdtempSync(path.join(tmpdir(), "hanse-attachments-outside-"));
    dirs.push(outside);
    const victim = path.join(outside, "victim.txt");
    writeFileSync(victim, "keep");
    utimesSync(victim, new Date(0), new Date(0));
    rmSync(path.join(appRoot, "attachments"), { recursive: true, force: true });
    symlinkSync(outside, path.join(appRoot, "attachments"), "dir");

    sweepOrphanFiles(db, [{ appId: "p:a", projectId: "p", appKey: "a", appRoot }], {
      now: Date.now(),
    });
    expect(statSync(victim).size).toBe(4);
  });

  it("rejects a symlinked final component on download", () => {
    const { db, appRoot } = fixture();
    const real = path.join(appRoot, "attachments", "ses_1", "real.txt");
    writeFileSync(real, "hello");
    const link = path.join(appRoot, "attachments", "ses_1", "att_1-x.txt");
    symlinkSync(real, link);
    insertRow(db, {
      id: "att_1",
      state: "available",
      relPath: "attachments/ses_1/att_1-x.txt",
      storedName: "att_1-x.txt",
      size: 5,
      kind: "file",
      mime: "text/plain",
    });
    const row = readAttachment(db, "p:a", "att_1");
    if (row === undefined) throw new Error("attachment row missing");
    expect(openAttachmentFile(appRoot, row)).toBeUndefined();
  });

  it("marks a missing file before a retry dispatch", () => {
    const { db, appRoot } = fixture();
    insertRow(db, {
      id: "att_2",
      state: "available",
      relPath: "attachments/ses_1/att_2-x.txt",
      storedName: "att_2-x.txt",
      size: 5,
      kind: "file",
      mime: "text/plain",
    });
    const rows = attachmentsForRefs(db, "p:a", "ses_1", [{ id: "att_2" }], appRoot);
    expect(rows).toEqual([]);
    expect(readAttachment(db, "p:a", "att_2")?.state).toBe("missing");
  });
});
