import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./database.js";

interface FileRow {
  skill_id: number;
  path: string;
  content: Buffer;
  sha256: string | null;
  size: number | null;
  updated_at: string;
}

interface ReferenceRow {
  skill_id: number;
  path: string;
  content: string;
}

interface SkillTimestampRow {
  updated_at: string;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Keep `skill_files` and the legacy `skill_references` projection consistent.
 *
 * `skill_files` is canonical. A reference row is merged only when it is missing or when the
 * skill row was updated after the file row (a rolled-back image writes only `skill_references`).
 * Arbitrary files are never deleted.
 */
export function reconcileSkillFiles(db: SqliteDatabase): void {
  const now = new Date().toISOString();
  const fileRows = db
    .prepare("SELECT skill_id, path, content, sha256, size, updated_at FROM skill_files")
    .all() as FileRow[];
  const updateDigest = db.prepare(
    "UPDATE skill_files SET sha256 = ?, size = ?, updated_at = ? WHERE skill_id = ? AND path = ?",
  );
  const files = new Map<string, FileRow>();
  for (const row of fileRows) {
    const content = Buffer.from(row.content);
    const digest = sha256Bytes(content);
    files.set(`${row.skill_id}\0${row.path}`, row);
    if (row.sha256 !== digest || row.size !== content.byteLength) {
      updateDigest.run(digest, content.byteLength, now, row.skill_id, row.path);
      row.sha256 = digest;
      row.size = content.byteLength;
      row.updated_at = now;
    }
  }

  const references = db
    .prepare("SELECT skill_id, path, content FROM skill_references")
    .all() as ReferenceRow[];
  const skillTimestamp = db.prepare("SELECT updated_at FROM skills WHERE id = ?");
  const upsert = db.prepare(
    `INSERT INTO skill_files
       (skill_id, path, content, encoding, executable, sha256, size, updated_at)
     VALUES (?, ?, ?, 'utf8', 0, ?, ?, ?)
     ON CONFLICT(skill_id, path) DO UPDATE SET
       content = excluded.content,
       encoding = 'utf8',
       executable = 0,
       sha256 = excluded.sha256,
       size = excluded.size,
       updated_at = excluded.updated_at`,
  );

  for (const reference of references) {
    const content = Buffer.from(reference.content, "utf8");
    const digest = sha256Bytes(content);
    const key = `${reference.skill_id}\0${reference.path}`;
    const existing = files.get(key);
    if (existing !== undefined) {
      if (existing.sha256 === digest) {
        continue;
      }
      const skill = skillTimestamp.get(reference.skill_id) as SkillTimestampRow | undefined;
      if (skill !== undefined && skill.updated_at <= existing.updated_at) {
        continue;
      }
    }
    upsert.run(reference.skill_id, reference.path, content, digest, content.byteLength, now);
  }
}
