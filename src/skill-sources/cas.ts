import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { SkillSourceError } from "./types.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeAtomic(file: string, value: Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, value);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, file);
  try {
    const dirFd = openSync(path.dirname(file), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best-effort on platforms that do not allow it.
  }
}

export class SkillCas {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true, mode: 0o755 });
  }

  blobPath(sha256Value: string): string {
    return path.join(this.root, "blobs", "sha256", sha256Value.slice(0, 2), sha256Value);
  }

  snapshotDir(sourceId: string, snapshotId: string): string {
    return path.join(this.root, "snapshots", sourceId, snapshotId);
  }

  has(sha256Value: string): boolean {
    return existsSync(this.blobPath(sha256Value));
  }

  read(sha256Value: string, size: number): Uint8Array {
    const file = this.blobPath(sha256Value);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      throw new SkillSourceError("blob_missing", `missing blob ${sha256Value}`);
    }
    if (bytes.byteLength !== size || sha256(bytes) !== sha256Value) {
      throw new SkillSourceError("blob_corrupt", `corrupt blob ${sha256Value}`);
    }
    return bytes;
  }

  put(bytes: Uint8Array): { sha256: string; size: number } {
    const digest = sha256(bytes);
    const destination = this.blobPath(digest);
    if (existsSync(destination)) {
      try {
        const existing = readFileSync(destination);
        if (existing.byteLength === bytes.byteLength && sha256(existing) === digest) {
          return { sha256: digest, size: bytes.byteLength };
        }
      } catch {
        // Fall through to repair.
      }
      this.#trashBlob(digest);
    }
    writeAtomic(destination, bytes);
    return { sha256: digest, size: bytes.byteLength };
  }

  #trashBlob(digest: string): void {
    const source = this.blobPath(digest);
    if (!existsSync(source)) {
      return;
    }
    const trash = path.join(this.root, "trash", "blobs");
    mkdirSync(trash, { recursive: true, mode: 0o755 });
    renameSync(source, path.join(trash, `${digest}-${Date.now()}`));
  }

  writeSnapshotManifest(sourceId: string, snapshotId: string, value: unknown): void {
    const directory = this.snapshotDir(sourceId, snapshotId);
    writeAtomic(
      path.join(directory, "manifest.json"),
      Buffer.from(JSON.stringify(value, null, 2), "utf8"),
    );
  }

  gc(retained: readonly { sourceId: string; snapshotId: string }[]): void {
    const keep = new Set(retained.map((item) => `${item.sourceId}\0${item.snapshotId}`));
    const referenced = new Set<string>();
    const snapshotsRoot = path.join(this.root, "snapshots");
    for (const sourceId of safeReaddir(snapshotsRoot)) {
      const sourceDir = path.join(snapshotsRoot, sourceId);
      for (const snapshotId of safeReaddir(sourceDir)) {
        const key = `${sourceId}\0${snapshotId}`;
        const directory = path.join(sourceDir, snapshotId);
        if (!keep.has(key)) {
          rmSync(directory, { recursive: true, force: true });
          continue;
        }
        try {
          const manifest = JSON.parse(
            readFileSync(path.join(directory, "manifest.json"), "utf8"),
          ) as { skills?: Array<{ files?: Array<{ sha256?: string }> }> };
          for (const skill of manifest.skills ?? []) {
            for (const file of skill.files ?? []) {
              if (typeof file.sha256 === "string") {
                referenced.add(file.sha256);
              }
            }
          }
        } catch {
          // A missing/corrupt retained manifest is handled by the next sync.
        }
      }
    }
    const blobsRoot = path.join(this.root, "blobs", "sha256");
    for (const prefix of safeReaddir(blobsRoot)) {
      const prefixDir = path.join(blobsRoot, prefix);
      for (const name of safeReaddir(prefixDir)) {
        if (!referenced.has(name)) {
          rmSync(path.join(prefixDir, name), { force: true });
        }
      }
    }
  }
}

function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

export function isRegularFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}
