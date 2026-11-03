import { randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  readSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DEFAULT_AGENT_AGENTS_ROOT, DEFAULT_AGENT_WORKSPACE_ROOT } from "../agent/spec.js";
import { isInlineSafeMime, sniffMime } from "../attachments/mime.js";
import { safeOriginalName, storedNameFor } from "../attachments/names.js";
import { reservedAttachmentBytes } from "../attachments/quota.js";
import { fsyncDirectory, fsyncPath } from "../attachments/storage.js";
import type { AttachmentView } from "../attachments/types.js";
import { ATTACHMENT_QUOTA_BYTES } from "../attachments/types.js";
import { appQuotaLocks } from "../chat/locks.js";
import { sanitizeAppKey } from "../opencode/instance.js";
import { isInside, resolveWithinRoot } from "../runtime/app-path.js";
import type { SqliteDatabase } from "../store/index.js";
import { activeAgentMediaIds, agentMediaAdmission } from "./active.js";
import {
  agentMediaFinalPath,
  agentMediaRelPath,
  agentMediaRoot,
  agentMediaTempPath,
  ensureAgentMediaRoot,
  openAgentMediaSource,
  renameAgentMedia,
  revalidateAgentMediaRoot,
} from "./paths.js";
import {
  type AgentMediaAttachOutcome,
  attachAgentMedia,
  insertStagedAgentMedia,
  touchAgentMedia,
} from "./store.js";
import {
  type AgentMediaAttachResult,
  type AgentMediaErrorCode,
  type AgentMediaResult,
  type AgentMediaRow,
  type AgentMediaTarget,
  MAX_AGENT_IMAGE_BYTES,
  MAX_AGENT_IMAGE_CAPTION,
  MAX_AGENT_IMAGE_PATH,
} from "./types.js";

class AgentMediaError extends Error {
  readonly code: AgentMediaErrorCode;
  constructor(code: AgentMediaErrorCode, message: string) {
    super(message);
    this.name = "AgentMediaError";
    this.code = code;
  }
}

function sanitizeCaption(value: string | undefined): string | null {
  if (value === undefined) return null;
  const cleaned = value
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: caption sanitizing removes C0/DEL.
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0 || cleaned.length > MAX_AGENT_IMAGE_CAPTION) {
    throw new AgentMediaError("invalid_caption", "caption must be 1..200 characters");
  }
  return cleaned;
}

function agentMediaDownloadUrl(target: AgentMediaTarget, id: string): string {
  return `/api/apps/${encodeURIComponent(target.appKey)}/agent-media/${encodeURIComponent(id)}?project=${encodeURIComponent(target.projectId)}`;
}

export class AgentMediaService {
  readonly #db: SqliteDatabase;
  readonly #target: AgentMediaTarget;

  constructor(db: SqliteDatabase, target: AgentMediaTarget) {
    this.#db = db;
    this.#target = target;
  }

  view(row: AgentMediaRow): AttachmentView {
    return {
      id: row.id,
      name: row.originalName,
      mime: row.mime,
      size: row.size,
      kind: "image",
      mode: "inline",
      state: row.state === "missing" ? "missing" : "sent",
      downloadURL: agentMediaDownloadUrl(this.#target, row.id),
      inline: true,
      origin: "agent",
      ...(row.caption === null ? {} : { caption: row.caption }),
    };
  }

  attach(
    appId: string,
    id: string,
    sessionId: string,
    messageId: string,
    partId: string,
  ): AgentMediaAttachResult {
    const outcome = attachAgentMedia(
      this.#db,
      appId,
      id,
      sessionId,
      messageId,
      partId,
      new Date().toISOString(),
    );
    return this.#toResult(outcome);
  }

  #toResult(outcome: AgentMediaAttachOutcome): AgentMediaAttachResult {
    if (outcome.status === "attached") {
      return { status: "attached", view: this.view(outcome.row) };
    }
    if (outcome.status === "missing") {
      return { status: "missing", view: this.view(outcome.row) };
    }
    return outcome;
  }

  async showImage(input: { path: string; caption?: string }): Promise<AgentMediaResult> {
    let source:
      | { fd: number; size: number; mime: string; sourcePath: string; displayName: string }
      | undefined;
    let id: string | undefined;
    let inserted = false;
    let reserved = false;
    let tempPath: string | undefined;
    let finalPath: string | undefined;
    try {
      if (input.path.length === 0 || input.path.length > MAX_AGENT_IMAGE_PATH) {
        throw new AgentMediaError("invalid_path", "path must be 1..2048 characters");
      }
      const caption = sanitizeCaption(input.caption);
      const resolved = this.#resolveSource(input.path);
      source = resolved;
      const size = resolved.size;
      id = `amed_${randomBytes(16).toString("base64url")}`;
      const storedName = storedNameFor(id, resolved.displayName);
      const relPath = agentMediaRelPath(storedName);
      tempPath = agentMediaTempPath(this.#target.appRoot, id);
      finalPath = agentMediaFinalPath(this.#target.appRoot, storedName);
      ensureAgentMediaRoot(this.#target.appRoot);
      if (!agentMediaAdmission.reserve(this.#target.appId, size)) {
        throw new AgentMediaError("image_busy", "too many images are being copied");
      }
      reserved = true;
      await appQuotaLocks.run(this.#target.appId, () => {
        if (reservedAttachmentBytes(this.#db, this.#target.appId) + size > ATTACHMENT_QUOTA_BYTES) {
          throw new AgentMediaError("image_quota_exceeded", "attachment quota is full");
        }
        insertStagedAgentMedia(this.#db, {
          id: id as string,
          appId: this.#target.appId,
          originalName: resolved.displayName,
          storedName,
          relPath,
          mime: resolved.mime,
          size,
          caption,
          now: new Date().toISOString(),
        });
        inserted = true;
      });
      activeAgentMediaIds.add(id);
      await this.#copy(
        resolved.fd,
        size,
        tempPath as string,
        this.#target.appRoot,
        finalPath as string,
      );
      const finalStat = lstatSync(finalPath as string, { throwIfNoEntry: false });
      if (
        finalStat === undefined ||
        finalStat.isSymbolicLink() ||
        !finalStat.isFile() ||
        finalStat.size !== size
      ) {
        throw new AgentMediaError("image_size_mismatch", "copied image size changed");
      }
      touchAgentMedia(this.#db, id, new Date().toISOString());
      return { ok: true, id, name: resolved.displayName, mime: resolved.mime, size };
    } catch (error) {
      if (inserted && id !== undefined) {
        this.#db
          .prepare("DELETE FROM agent_media WHERE app_id = ? AND id = ?")
          .run(this.#target.appId, id);
      }
      if (tempPath !== undefined) removeQuiet(tempPath);
      if (finalPath !== undefined) removeQuiet(finalPath);
      if (error instanceof AgentMediaError) {
        return { ok: false, code: error.code, message: error.message };
      }
      return {
        ok: false,
        code: "image_storage_error",
        message: "image storage failed",
      };
    } finally {
      if (reserved) agentMediaAdmission.release(this.#target.appId, source?.size ?? 0);
      if (id !== undefined) activeAgentMediaIds.delete(id);
      if (source !== undefined) closeSync(source.fd);
    }
  }

  #resolveSource(inputPath: string): {
    fd: number;
    size: number;
    mime: string;
    sourcePath: string;
    displayName: string;
  } {
    const appRoot = this.#target.appRoot;
    const appDir = this.#target.appDir;
    const tmpRoot = path.join(appRoot, "tmp");
    const attachmentsRoot = path.join(appRoot, "attachments");
    let mapped: string;
    let root: string;
    if (inputPath.startsWith("$TMPDIR/")) {
      mapped = path.join(tmpRoot, inputPath.slice("$TMPDIR/".length));
      root = tmpRoot;
    } else if (path.isAbsolute(inputPath)) {
      const workspacePrefix = `${DEFAULT_AGENT_WORKSPACE_ROOT}/`;
      const agentsPrefix = `${DEFAULT_AGENT_AGENTS_ROOT}/${sanitizeAppKey(this.#target.projectId)}/${sanitizeAppKey(this.#target.appKey)}/`;
      if (inputPath.startsWith(workspacePrefix)) {
        mapped = path.join(this.#target.workspaceRoot, inputPath.slice(workspacePrefix.length));
        root = appDir;
      } else if (inputPath.startsWith(agentsPrefix)) {
        const rest = inputPath.slice(agentsPrefix.length);
        mapped = path.join(appRoot, rest);
        if (rest.startsWith("tmp/")) root = tmpRoot;
        else if (rest.startsWith("attachments/")) root = attachmentsRoot;
        else throw new AgentMediaError("path_outside_app", "path is outside the allowed roots");
      } else if (this.#target.pathMode === "supervisor") {
        const candidates = [appDir, tmpRoot, attachmentsRoot];
        const found = candidates.find((candidate) => isInside(candidate, inputPath));
        if (found === undefined) {
          throw new AgentMediaError("path_outside_app", "path is outside the allowed roots");
        }
        mapped = inputPath;
        root = found;
      } else {
        throw new AgentMediaError("path_outside_app", "path is outside the allowed roots");
      }
    } else {
      mapped = path.resolve(appDir, inputPath);
      root = appDir;
    }
    let resolved: string;
    try {
      resolved = resolveWithinRoot({ target: mapped, root, label: "agent image source" });
    } catch {
      throw new AgentMediaError("path_outside_app", "path is outside the allowed roots");
    }
    const opened = openAgentMediaSource(resolved);
    if (opened === undefined) {
      throw new AgentMediaError("image_unreadable", "image is not a readable regular file");
    }
    if (opened.size === 0) {
      closeSync(opened.fd);
      throw new AgentMediaError("image_empty_file", "image is empty");
    }
    if (opened.size > MAX_AGENT_IMAGE_BYTES) {
      closeSync(opened.fd);
      throw new AgentMediaError("image_too_large", "image exceeds 20 MiB");
    }
    const head = Buffer.alloc(512);
    let read = 0;
    try {
      read = readSync(opened.fd, head, 0, 512, 0);
    } catch {
      closeSync(opened.fd);
      throw new AgentMediaError("image_unreadable", "image could not be read");
    }
    const sniffed = sniffMime(head.subarray(0, read), path.basename(resolved));
    if (sniffed.kind !== "image" || !isInlineSafeMime(sniffed.mime)) {
      closeSync(opened.fd);
      throw new AgentMediaError("image_unsupported", "only PNG, JPEG, GIF, and WebP are supported");
    }
    const displayName = safeOriginalName(path.basename(resolved));
    if (displayName.length === 0) {
      closeSync(opened.fd);
      throw new AgentMediaError("invalid_path", "image file name is not usable");
    }
    return {
      fd: opened.fd,
      size: opened.size,
      mime: sniffed.mime,
      sourcePath: resolved,
      displayName,
    };
  }

  async #copy(
    fd: number,
    size: number,
    tempPath: string,
    appRoot: string,
    finalPath: string,
  ): Promise<void> {
    try {
      await pipeline(
        createReadStream("", { fd, start: 0, end: size - 1, autoClose: false }),
        createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
      );
      fsyncPath(tempPath);
      revalidateAgentMediaRoot(appRoot);
      renameAgentMedia(tempPath, finalPath);
      fsyncDirectory(agentMediaRoot(appRoot));
    } catch (error) {
      throw error instanceof AgentMediaError
        ? error
        : new AgentMediaError("image_storage_error", "image copy failed");
    }
  }
}

function removeQuiet(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // The daily orphan pass repairs leftovers.
  }
}
