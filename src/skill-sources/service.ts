import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { open, seal } from "../secrets/crypto.js";
import type { SkillFile, SkillWarning } from "../skills/types.js";
import { SkillValidationError } from "../skills/validation.js";
import type { SqliteDatabase } from "../store/database.js";
import { SkillCas } from "./cas.js";
import { HanseHubProvider } from "./hub-client.js";
import {
  type CheckResult,
  type ExternalSkillRecord,
  type HubManifest,
  type SkillSourceConfig,
  SkillSourceError,
  type SkillSourceInput,
  type SkillSourceMode,
  type SkillSourceRow,
  type SkillSourceState,
  type SkillSourceView,
  type SnapshotSkill,
  type SyncResult,
} from "./types.js";
import {
  canonicalManifestHash,
  parseSkillDocument,
  snapshotIdFor,
  validateSkillFilesForSource,
  validateSourceInput,
} from "./validation.js";

interface SourceDbRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  endpoint: string;
  config_json: string;
  priority: number;
  enabled: number;
  mode: SkillSourceMode;
  sync_interval_sec: number;
  stale_after_sec: number;
  request_timeout_ms: number;
  active_snapshot_id: string | null;
  pinned_snapshot_id: string | null;
  disabled_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_checked_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  etag: string | null;
  revision: string | null;
  state: SkillSourceState;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

interface SnapshotSkillRow {
  snapshot_id: string;
  source_id: string;
  bucket: string;
  name: string;
  description: string;
  version: string | null;
  content_hash: string | null;
  skill_md_sha256: string;
  files_json: string;
  file_count: number;
  total_bytes: number;
  state: "ok" | "quarantined";
  error_code: string | null;
  error_message: string | null;
}

interface CredentialRow {
  cipher: string | null;
  nonce: string | null;
}

export interface SkillSourceServiceOptions {
  db: SqliteDatabase;
  secretKey: Buffer;
  stateRoot: string;
  now?: () => Date;
  logger?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

const SELECT_COLUMNS =
  "id, slug, name, kind, endpoint, config_json, priority, enabled, mode, sync_interval_sec, stale_after_sec, request_timeout_ms, active_snapshot_id, pinned_snapshot_id, disabled_at, last_attempt_at, last_success_at, last_checked_at, last_error_code, last_error_message, etag, revision, state, created_at, updated_at, updated_by";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseConfig(raw: string): SkillSourceConfig {
  try {
    const parsed = JSON.parse(raw) as Partial<SkillSourceConfig>;
    return {
      buckets: Array.isArray(parsed.buckets)
        ? parsed.buckets.filter((item): item is string => typeof item === "string")
        : [],
      allowInsecureHttp: parsed.allowInsecureHttp === true,
    };
  } catch {
    return { buckets: [], allowInsecureHttp: false };
  }
}

function mapRow(row: SourceDbRow): SkillSourceRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    endpoint: row.endpoint,
    config: parseConfig(row.config_json),
    priority: row.priority,
    enabled: row.enabled === 1,
    mode: row.mode,
    syncIntervalSec: row.sync_interval_sec,
    staleAfterSec: row.stale_after_sec,
    requestTimeoutMs: row.request_timeout_ms,
    activeSnapshotId: row.active_snapshot_id,
    pinnedSnapshotId: row.pinned_snapshot_id,
    disabledAt: row.disabled_at,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastCheckedAt: row.last_checked_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    etag: row.etag,
    revision: row.revision,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function mapSkillRow(row: SnapshotSkillRow): SnapshotSkill {
  let files: SnapshotSkill["files"] = [];
  try {
    const parsed = JSON.parse(row.files_json) as Array<{
      path?: unknown;
      sha256?: unknown;
      size?: unknown;
    }>;
    files = parsed
      .filter(
        (file): file is { path: string; sha256: string; size: number } =>
          typeof file.path === "string" &&
          typeof file.sha256 === "string" &&
          typeof file.size === "number",
      )
      .map((file) => ({ path: file.path, sha256: file.sha256, size: file.size }));
  } catch {
    files = [];
  }
  return {
    bucket: row.bucket,
    name: row.name,
    description: row.description,
    version: row.version,
    contentHash: row.content_hash,
    skillMdSha256: row.skill_md_sha256,
    files,
    state: row.state,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export class SkillSourceService {
  readonly #db: SqliteDatabase;
  readonly #secretKey: Buffer;
  readonly #cas: SkillCas;
  readonly #now: () => Date;
  readonly #logger: (message: string) => void;
  readonly #fetch: typeof fetch;
  #timer: NodeJS.Timeout | undefined;
  #inFlight = new Map<string, Promise<SyncResult>>();

  constructor(options: SkillSourceServiceOptions) {
    this.#db = options.db;
    this.#secretKey = options.secretKey;
    this.#cas = new SkillCas(join(options.stateRoot, "skill-sources"));
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? (() => undefined);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  list(): SkillSourceView[] {
    const rows = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM skill_sources ORDER BY priority, slug`)
      .all() as SourceDbRow[];
    return rows.map((row) => this.#view(mapRow(row)));
  }

  get(id: string): SkillSourceView | undefined {
    const row = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM skill_sources WHERE id = ?`)
      .get(id) as SourceDbRow | undefined;
    return row === undefined ? undefined : this.#view(mapRow(row));
  }

  #requireRow(id: string): SkillSourceRow {
    const row = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM skill_sources WHERE id = ?`)
      .get(id) as SourceDbRow | undefined;
    if (row === undefined) {
      throw new SkillSourceError("not_found", `skill source ${id} not found`);
    }
    return mapRow(row);
  }

  create(input: SkillSourceInput, actor: string): SkillSourceView {
    const normalized = validateSourceInput(input, { partial: false });
    if (
      normalized.slug === undefined ||
      normalized.name === undefined ||
      normalized.endpoint === undefined ||
      normalized.config === undefined
    ) {
      throw new SkillValidationError("slug, name, endpoint, and config are required");
    }
    const id = randomUUID();
    const timestamp = this.#timestamp();
    this.#db
      .prepare(
        `INSERT INTO skill_sources
           (id, slug, name, kind, endpoint, config_json, priority, enabled, mode,
            sync_interval_sec, stale_after_sec, request_timeout_ms, state,
            created_at, updated_at, updated_by)
         VALUES (?, ?, ?, 'skills-hub', ?, ?, ?, ?, ?, ?, ?, ?, 'never_synced', ?, ?, ?)`,
      )
      .run(
        id,
        normalized.slug,
        normalized.name,
        normalized.endpoint,
        JSON.stringify(normalized.config),
        normalized.priority ?? 100,
        normalized.enabled === false ? 0 : 1,
        normalized.mode ?? "track",
        normalized.syncIntervalSec ?? 900,
        normalized.staleAfterSec ?? 86400,
        normalized.requestTimeoutMs ?? 15000,
        timestamp,
        timestamp,
        actor,
      );
    if (normalized.token !== undefined) {
      this.setSecret(id, normalized.token, actor);
    }
    return this.#view(this.#requireRow(id));
  }

  update(id: string, input: SkillSourceInput, actor: string): SkillSourceView {
    const existing = this.#requireRow(id);
    const normalized = validateSourceInput(input, { partial: true });
    const updates: string[] = [];
    const params: Record<string, unknown> = {
      id,
      updated_at: this.#timestamp(),
      updated_by: actor,
    };
    const set = (column: string, key: string, value: unknown) => {
      updates.push(`${column} = @${key}`);
      params[key] = value;
    };
    if (normalized.slug !== undefined) set("slug", "slug", normalized.slug);
    if (normalized.name !== undefined) set("name", "name", normalized.name);
    if (normalized.endpoint !== undefined) {
      set("endpoint", "endpoint", normalized.endpoint);
      set("etag", "etag", null);
    }
    if (normalized.config !== undefined) {
      set("config_json", "config_json", JSON.stringify(normalized.config));
      set("etag", "etag", null);
    }
    if (normalized.priority !== undefined) set("priority", "priority", normalized.priority);
    if (normalized.enabled !== undefined) set("enabled", "enabled", normalized.enabled ? 1 : 0);
    if (normalized.mode !== undefined) set("mode", "mode", normalized.mode);
    if (normalized.syncIntervalSec !== undefined) {
      set("sync_interval_sec", "sync_interval_sec", normalized.syncIntervalSec);
    }
    if (normalized.staleAfterSec !== undefined) {
      set("stale_after_sec", "stale_after_sec", normalized.staleAfterSec);
    }
    if (normalized.requestTimeoutMs !== undefined) {
      set("request_timeout_ms", "request_timeout_ms", normalized.requestTimeoutMs);
    }
    if (normalized.enabled === false && existing.enabled) {
      set("active_snapshot_id", "active_snapshot_id", null);
      set("pinned_snapshot_id", "pinned_snapshot_id", null);
      set("disabled_at", "disabled_at", this.#timestamp());
      set("state", "state", "disabled");
    }
    if (normalized.enabled === true && !existing.enabled) {
      set("disabled_at", "disabled_at", null);
      set("state", "state", existing.activeSnapshotId === null ? "never_synced" : "ready");
    }
    if (updates.length > 0) {
      updates.push("updated_at = @updated_at", "updated_by = @updated_by");
      this.#db.prepare(`UPDATE skill_sources SET ${updates.join(", ")} WHERE id = @id`).run(params);
    }
    if (normalized.token !== undefined) {
      this.setSecret(id, normalized.token, actor);
    }
    if (normalized.enabled === true && !existing.enabled) {
      void this.sync(id).catch((error) => this.#logger(`skill source ${id}: ${String(error)}`));
    }
    return this.#view(this.#requireRow(id));
  }

  setSecret(id: string, token: string | null, actor: string): void {
    this.#requireRow(id);
    if (token === null || token.trim().length === 0) {
      this.clearSecret(id, actor);
      return;
    }
    const value = token.trim();
    const sealed = seal(this.#secretKey, JSON.stringify({ token: value }));
    const timestamp = this.#timestamp();
    this.#db
      .prepare(
        `INSERT INTO skill_source_credentials
           (source_id, cipher, nonce, meta_json, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, '{}', ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           cipher = excluded.cipher,
           nonce = excluded.nonce,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(id, sealed.cipher, sealed.nonce, timestamp, timestamp, actor);
    this.#db
      .prepare("UPDATE skill_sources SET etag = NULL, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(timestamp, actor, id);
  }

  clearSecret(id: string, actor: string): void {
    this.#requireRow(id);
    const timestamp = this.#timestamp();
    this.#db
      .prepare(
        `INSERT INTO skill_source_credentials
           (source_id, cipher, nonce, meta_json, created_at, updated_at, updated_by)
         VALUES (?, NULL, NULL, '{}', ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           cipher = NULL,
           nonce = NULL,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(id, timestamp, timestamp, actor);
    this.#db
      .prepare("UPDATE skill_sources SET etag = NULL, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(timestamp, actor, id);
  }

  #token(id: string): string | null {
    const row = this.#db
      .prepare("SELECT cipher, nonce FROM skill_source_credentials WHERE source_id = ?")
      .get(id) as CredentialRow | undefined;
    if (row === undefined || row.cipher === null || row.nonce === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(
        open(this.#secretKey, { cipher: row.cipher, nonce: row.nonce }),
      ) as { token?: unknown };
      return typeof parsed.token === "string" ? parsed.token : null;
    } catch {
      throw new SkillSourceError("credential_error", "source token could not be decrypted");
    }
  }

  remove(id: string, options: { hard: boolean }, actor: string): void {
    this.#requireRow(id);
    const timestamp = this.#timestamp();
    if (options.hard) {
      this.#db
        .prepare("UPDATE skill_source_snapshots SET state = 'superseded' WHERE source_id = ?")
        .run(id);
      this.#db.prepare("DELETE FROM skill_sources WHERE id = ?").run(id);
      return;
    }
    this.#db
      .prepare(
        `UPDATE skill_sources SET enabled = 0, active_snapshot_id = NULL,
           pinned_snapshot_id = NULL, disabled_at = ?, state = 'disabled',
           updated_at = ?, updated_by = ? WHERE id = ?`,
      )
      .run(timestamp, timestamp, actor, id);
  }

  enable(id: string, actor: string): SkillSourceView {
    const row = this.#requireRow(id);
    const timestamp = this.#timestamp();
    this.#db
      .prepare(
        `UPDATE skill_sources SET enabled = 1, disabled_at = NULL,
           state = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      )
      .run(row.activeSnapshotId === null ? "never_synced" : "ready", timestamp, actor, id);
    void this.sync(id).catch((error) => this.#logger(`skill source ${id}: ${String(error)}`));
    return this.#view(this.#requireRow(id));
  }

  pin(id: string, actor: string): SkillSourceView {
    const row = this.#requireRow(id);
    if (row.activeSnapshotId === null) {
      throw new SkillSourceError("no_snapshot", "source has no active snapshot to pin");
    }
    this.#db
      .prepare(
        "UPDATE skill_sources SET mode = 'pinned', pinned_snapshot_id = active_snapshot_id, updated_at = ?, updated_by = ? WHERE id = ?",
      )
      .run(this.#timestamp(), actor, id);
    return this.#view(this.#requireRow(id));
  }

  unpin(id: string, actor: string): SkillSourceView {
    this.#requireRow(id);
    this.#db
      .prepare(
        "UPDATE skill_sources SET mode = 'track', pinned_snapshot_id = NULL, updated_at = ?, updated_by = ? WHERE id = ?",
      )
      .run(this.#timestamp(), actor, id);
    void this.sync(id).catch((error) => this.#logger(`skill source ${id}: ${String(error)}`));
    return this.#view(this.#requireRow(id));
  }

  async check(id: string): Promise<CheckResult> {
    const source = this.#requireRow(id);
    const token = this.#token(id);
    const provider = new HanseHubProvider({
      endpoint: source.endpoint,
      buckets: source.config.buckets,
      token,
      timeoutMs: source.requestTimeoutMs,
      fetchImpl: this.#fetch,
    });
    const fetched = await provider.fetchManifest({ etag: source.etag });
    if (fetched.notModified) {
      this.#touchChecked(id);
      return {
        changed: false,
        currentSnapshotId: source.activeSnapshotId,
        nextSnapshotId: source.activeSnapshotId ?? "",
        revision: source.revision ?? "",
      };
    }
    if (fetched.manifest === undefined) {
      throw new SkillSourceError("invalid_manifest", "hub manifest is missing");
    }
    const manifestSha = canonicalManifestHash(fetched.manifest);
    const next = snapshotIdFor(source.id, manifestSha);
    this.#touchChecked(id);
    return {
      changed: next !== source.activeSnapshotId,
      currentSnapshotId: source.activeSnapshotId,
      nextSnapshotId: next,
      revision: fetched.manifest.buckets[0]?.revision ?? "",
    };
  }

  sync(id: string, options: { force?: boolean } = {}): Promise<SyncResult> {
    const existing = this.#inFlight.get(id);
    if (existing !== undefined) {
      return options.force === true ? existing.then(() => this.#sync(id, true)) : existing;
    }
    const run = this.#sync(id, options.force === true).finally(() => {
      this.#inFlight.delete(id);
    });
    this.#inFlight.set(id, run);
    return run;
  }

  async #sync(id: string, force: boolean): Promise<SyncResult> {
    const source = this.#requireRow(id);
    if (!source.enabled) {
      throw new SkillSourceError("disabled", "source is disabled");
    }
    const token = this.#token(id);
    const provider = new HanseHubProvider({
      endpoint: source.endpoint,
      buckets: source.config.buckets,
      token,
      timeoutMs: source.requestTimeoutMs,
      fetchImpl: this.#fetch,
    });
    const attemptAt = this.#timestamp();
    this.#db
      .prepare("UPDATE skill_sources SET state = 'syncing', last_attempt_at = ? WHERE id = ?")
      .run(attemptAt, id);
    try {
      const fetched = await provider.fetchManifest({ etag: force ? null : source.etag });
      if (fetched.notModified) {
        this.#markSuccess(id, source.revision, source.etag);
        return {
          changed: false,
          snapshotId: source.activeSnapshotId,
          revision: source.revision,
          skillCount: this.#activeSkillCount(id),
          totalBytes: this.#activeTotalBytes(id),
          state: "ready",
        };
      }
      if (fetched.manifest === undefined) {
        throw new SkillSourceError("invalid_manifest", "hub manifest is missing");
      }
      const manifest = fetched.manifest;
      this.#assertBuckets(manifest, source.config.buckets);
      const manifestSha = canonicalManifestHash(manifest);
      const snapshotId = snapshotIdFor(id, manifestSha);
      const revision = manifest.buckets[0]?.revision ?? source.revision ?? "";
      if (snapshotId === source.activeSnapshotId && !force) {
        this.#markSuccess(id, revision, fetched.etag);
        return {
          changed: false,
          snapshotId,
          revision,
          skillCount: this.#activeSkillCount(id),
          totalBytes: this.#activeTotalBytes(id),
          state: "ready",
        };
      }
      if (source.mode === "pinned" && !force) {
        this.#markSuccess(id, source.revision, fetched.etag);
        return {
          changed: snapshotId !== source.activeSnapshotId,
          snapshotId: source.activeSnapshotId,
          revision: source.revision,
          skillCount: this.#activeSkillCount(id),
          totalBytes: this.#activeTotalBytes(id),
          state: "ready",
        };
      }
      const built = await this.#buildSnapshot(id, source, provider, manifest);
      this.#assertDeletionGuard(id, source, built.skills, force);
      this.#cas.writeSnapshotManifest(id, snapshotId, {
        sourceId: id,
        snapshotId,
        revision,
        etag: fetched.etag,
        manifestSha256: manifestSha,
        bucketSet: source.config.buckets,
        skills: built.skills,
        totalBytes: built.totalBytes,
      });
      this.#publish(id, snapshotId, built, revision, fetched.etag, manifestSha);
      this.#gc();
      const degraded = built.skills.some((skill) => skill.state === "quarantined");
      return {
        changed: true,
        snapshotId,
        revision,
        skillCount: built.skills.length,
        totalBytes: built.totalBytes,
        state: degraded ? "degraded" : "ready",
      };
    } catch (error) {
      const code = error instanceof SkillSourceError ? error.code : "sync_failed";
      const message = error instanceof Error ? error.message : String(error);
      this.#db
        .prepare(
          `UPDATE skill_sources SET state = 'error', last_error_code = ?,
             last_error_message = ?, last_attempt_at = ? WHERE id = ?`,
        )
        .run(code, message.slice(0, 500), this.#timestamp(), id);
      throw error;
    }
  }

  #assertBuckets(manifest: HubManifest, requested: readonly string[]): void {
    const available = new Set(manifest.buckets.map((bucket) => bucket.slug));
    for (const bucket of requested) {
      if (!available.has(bucket)) {
        throw new SkillSourceError("bucket_mismatch", `hub did not return bucket ${bucket}`);
      }
    }
  }

  async #buildSnapshot(
    _id: string,
    _source: SkillSourceRow,
    provider: HanseHubProvider,
    manifest: HubManifest,
  ): Promise<{ skills: SnapshotSkill[]; totalBytes: number }> {
    const skills: SnapshotSkill[] = [];
    let totalBytes = 0;
    for (const bucket of manifest.buckets) {
      for (const skill of bucket.skills) {
        try {
          const validated = validateSkillFilesForSource(skill.name, skill.files);
          const skillMdBytes = await provider.fetchFile({
            bucket: bucket.slug,
            name: skill.name,
            path: "SKILL.md",
          });
          const skillMdDigest = validated.skillMd.sha256;
          if (
            skillMdBytes.byteLength !== validated.skillMd.size ||
            sha256Hex(skillMdBytes) !== skillMdDigest
          ) {
            throw new SkillSourceError(
              "file_hash_mismatch",
              `SKILL.md hash mismatch for ${skill.name}`,
            );
          }
          this.#cas.put(skillMdBytes);
          const parsed = parseSkillDocument(skillMdBytes);
          if (parsed.name !== skill.name) {
            throw new SkillSourceError(
              "invalid_skill_md",
              `SKILL.md name ${parsed.name} does not match ${skill.name}`,
            );
          }
          for (const file of validated.files) {
            if (file.path === "SKILL.md") {
              continue;
            }
            const bytes = await provider.fetchFile({
              bucket: bucket.slug,
              name: skill.name,
              path: file.path,
            });
            if (bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) {
              throw new SkillSourceError(
                "file_hash_mismatch",
                `hash mismatch for ${skill.name}/${file.path}`,
              );
            }
            this.#cas.put(bytes);
          }
          totalBytes += validated.totalBytes;
          skills.push({
            bucket: bucket.slug,
            name: skill.name,
            description: parsed.description,
            version: skill.version,
            contentHash: skill.contentHash,
            skillMdSha256: skillMdDigest,
            files: validated.files,
            state: "ok",
            errorCode: null,
            errorMessage: null,
          });
        } catch (error) {
          if (isFatalSyncError(error)) {
            throw error;
          }
          const code = error instanceof SkillSourceError ? error.code : "invalid_skill";
          const message = error instanceof Error ? error.message : String(error);
          skills.push({
            bucket: bucket.slug,
            name: skill.name,
            description: skill.description,
            version: skill.version,
            contentHash: skill.contentHash,
            skillMdSha256: "",
            files: skill.files,
            state: "quarantined",
            errorCode: code,
            errorMessage: message.slice(0, 300),
          });
        }
      }
    }
    return { skills, totalBytes };
  }

  #assertDeletionGuard(
    _id: string,
    source: SkillSourceRow,
    next: readonly SnapshotSkill[],
    force: boolean,
  ): void {
    if (force || source.activeSnapshotId === null) {
      return;
    }
    const previous = this.#snapshotSkills(source.activeSnapshotId);
    if (previous.length === 0) {
      return;
    }
    const nextNames = new Set(
      next.filter((skill) => skill.state === "ok").map((skill) => skill.name),
    );
    const removed = previous.filter((skill) => !nextNames.has(skill.name)).length;
    const threshold = Math.max(3, Math.ceil(previous.length * 0.2));
    if (nextNames.size === 0 || removed > threshold) {
      throw new SkillSourceError(
        "deletion_guard",
        `sync would remove ${removed} of ${previous.length} skills`,
      );
    }
  }

  #publish(
    id: string,
    snapshotId: string,
    built: { skills: SnapshotSkill[]; totalBytes: number },
    revision: string,
    etag: string | null,
    manifestSha: string,
  ): void {
    const timestamp = this.#timestamp();
    const degraded = built.skills.some((skill) => skill.state === "quarantined");
    const state: SkillSourceState = degraded ? "degraded" : "ready";
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO skill_source_snapshots
             (id, source_id, revision, etag, manifest_sha256, bucket_set_json,
              skill_count, total_bytes, state, fetched_at, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             revision = excluded.revision,
             etag = excluded.etag,
             manifest_sha256 = excluded.manifest_sha256,
             bucket_set_json = excluded.bucket_set_json,
             skill_count = excluded.skill_count,
             total_bytes = excluded.total_bytes,
             state = 'active',
             published_at = excluded.published_at`,
        )
        .run(
          snapshotId,
          id,
          revision,
          etag,
          manifestSha,
          JSON.stringify(this.#requireRow(id).config.buckets),
          built.skills.length,
          built.totalBytes,
          timestamp,
          timestamp,
        );
      this.#db.prepare("DELETE FROM skill_source_skills WHERE snapshot_id = ?").run(snapshotId);
      const insert = this.#db.prepare(
        `INSERT INTO skill_source_skills
           (snapshot_id, source_id, bucket, name, description, version, content_hash,
            skill_md_sha256, files_json, file_count, total_bytes, state, error_code, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const skill of built.skills) {
        insert.run(
          snapshotId,
          id,
          skill.bucket,
          skill.name,
          skill.description,
          skill.version,
          skill.contentHash,
          skill.skillMdSha256,
          JSON.stringify(skill.files),
          skill.files.length,
          skill.files.reduce((sum, file) => sum + file.size, 0),
          skill.state,
          skill.errorCode,
          skill.errorMessage,
        );
      }
      this.#db
        .prepare(
          "UPDATE skill_source_snapshots SET state = 'superseded' WHERE source_id = ? AND id <> ? AND state = 'active'",
        )
        .run(id, snapshotId);
      this.#db
        .prepare(
          `UPDATE skill_sources SET active_snapshot_id = ?, revision = ?, etag = ?,
             last_checked_at = ?, last_success_at = ?, last_attempt_at = ?,
             last_error_code = NULL, last_error_message = NULL, state = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(snapshotId, revision, etag, timestamp, timestamp, timestamp, state, timestamp, id);
    })();
  }

  #gc(): void {
    const sources = this.#db
      .prepare(
        `SELECT id, active_snapshot_id, pinned_snapshot_id FROM skill_sources
         WHERE active_snapshot_id IS NOT NULL OR pinned_snapshot_id IS NOT NULL`,
      )
      .all() as Array<{
      id: string;
      active_snapshot_id: string | null;
      pinned_snapshot_id: string | null;
    }>;
    const retained: Array<{ sourceId: string; snapshotId: string }> = [];
    for (const source of sources) {
      if (source.active_snapshot_id !== null) {
        retained.push({ sourceId: source.id, snapshotId: source.active_snapshot_id });
      }
      if (source.pinned_snapshot_id !== null) {
        retained.push({ sourceId: source.id, snapshotId: source.pinned_snapshot_id });
      }
    }
    const floor = this.#now().getTime() - 24 * 60 * 60 * 1000;
    const recent = this.#db
      .prepare("SELECT source_id, id, published_at FROM skill_source_snapshots")
      .all() as Array<{ source_id: string; id: string; published_at: string | null }>;
    for (const row of recent) {
      if (row.published_at !== null && Date.parse(row.published_at) >= floor) {
        retained.push({ sourceId: row.source_id, snapshotId: row.id });
      }
    }
    this.#cas.gc(retained);
  }

  skills(id: string): SnapshotSkill[] {
    const source = this.#requireRow(id);
    if (source.activeSnapshotId === null) {
      return [];
    }
    const rows = this.#db
      .prepare("SELECT * FROM skill_source_skills WHERE snapshot_id = ? ORDER BY bucket, name")
      .all(source.activeSnapshotId) as SnapshotSkillRow[];
    return rows.map(mapSkillRow);
  }

  activeRecords(): ExternalSkillRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT s.id AS sourceId, s.slug AS sourceSlug, s.name AS sourceName, s.priority,
                s.config_json, s.active_snapshot_id AS snapshotId, s.revision,
                k.bucket, k.name, k.description, k.version, k.content_hash,
                k.skill_md_sha256, k.files_json
         FROM skill_sources s
         JOIN skill_source_skills k ON k.snapshot_id = s.active_snapshot_id
         WHERE s.enabled = 1 AND k.state = 'ok'
         ORDER BY s.priority, s.slug, k.name`,
      )
      .all() as Array<{
      sourceId: string;
      sourceSlug: string;
      sourceName: string;
      priority: number;
      config_json: string;
      snapshotId: string;
      revision: string | null;
      bucket: string;
      name: string;
      description: string;
      version: string | null;
      content_hash: string | null;
      skill_md_sha256: string;
      files_json: string;
    }>;
    const order = new Map<string, number>();
    for (const row of rows) {
      const config = parseConfig(row.config_json);
      config.buckets.forEach((bucket, index) => {
        order.set(`${row.sourceId}\0${bucket}`, index);
      });
    }
    return rows
      .map((row) => {
        const files = JSON.parse(row.files_json) as Array<{
          path: string;
          sha256: string;
          size: number;
        }>;
        return {
          sourceId: row.sourceId,
          sourceSlug: row.sourceSlug,
          sourceName: row.sourceName,
          priority: row.priority,
          bucket: row.bucket,
          snapshotId: row.snapshotId,
          revision: row.revision ?? "",
          name: row.name,
          description: row.description,
          version: row.version,
          contentHash: row.content_hash,
          skillMdSha256: row.skill_md_sha256,
          files,
        };
      })
      .sort((left, right) => {
        if (left.priority !== right.priority) return left.priority - right.priority;
        if (left.sourceSlug !== right.sourceSlug)
          return compareStrings(left.sourceSlug, right.sourceSlug);
        const leftOrder = order.get(`${left.sourceId}\0${left.bucket}`) ?? 0;
        const rightOrder = order.get(`${right.sourceId}\0${right.bucket}`) ?? 0;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return compareStrings(left.name, right.name);
      });
  }

  readSkillFiles(record: ExternalSkillRecord): SkillFile[] {
    return this.readFiles(record.files);
  }

  readFiles(files: readonly { path: string; sha256: string; size: number }[]): SkillFile[] {
    return files.map((file) => ({
      path: file.path,
      content: this.#cas.read(file.sha256, file.size),
      sha256: file.sha256,
      size: file.size,
      executable: false,
    }));
  }

  warnings(): SkillWarning[] {
    const warnings: SkillWarning[] = [];
    const stale = this.#db
      .prepare(
        `SELECT name, last_success_at, stale_after_sec FROM skill_sources
         WHERE enabled = 1 AND last_success_at IS NOT NULL`,
      )
      .all() as Array<{ name: string; last_success_at: string; stale_after_sec: number }>;
    const now = this.#now().getTime();
    for (const row of stale) {
      if (now - Date.parse(row.last_success_at) > row.stale_after_sec * 1000) {
        warnings.push({ code: "skill_source_stale", name: row.name });
      }
    }
    const quarantined = this.#db
      .prepare(
        `SELECT s.id AS sourceId, k.name FROM skill_sources s
         JOIN skill_source_skills k ON k.snapshot_id = s.active_snapshot_id
         WHERE s.enabled = 1 AND k.state = 'quarantined'`,
      )
      .all() as Array<{ sourceId: string; name: string }>;
    for (const row of quarantined) {
      warnings.push({ code: "skill_source_quarantined", name: row.name, root: row.sourceId });
    }
    return warnings;
  }

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.#tick();
    }, 60_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #tick(): Promise<void> {
    const sources = this.list().filter((source) => source.enabled);
    for (const source of sources) {
      const last = source.lastAttemptAt === null ? 0 : Date.parse(source.lastAttemptAt);
      if (this.#now().getTime() - last < source.syncIntervalSec * 1000) {
        continue;
      }
      await this.sync(source.id).catch((error) => {
        this.#logger(
          `skill source ${source.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  #view(row: SkillSourceRow): SkillSourceView {
    const stats = this.#db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total_bytes), 0) AS bytes
         FROM skill_source_skills WHERE snapshot_id = ? AND state = 'ok'`,
      )
      .get(row.activeSnapshotId ?? "") as { count: number; bytes: number };
    const token = this.#db
      .prepare("SELECT 1 FROM skill_source_credentials WHERE source_id = ? AND cipher IS NOT NULL")
      .get(row.id);
    return {
      ...row,
      tokenSet: token !== undefined,
      skillCount: stats.count,
      totalBytes: stats.bytes,
      stale:
        row.lastSuccessAt !== null &&
        this.#now().getTime() - Date.parse(row.lastSuccessAt) > row.staleAfterSec * 1000,
    };
  }

  #activeSkillCount(id: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS count FROM skill_source_skills
         WHERE snapshot_id = (SELECT active_snapshot_id FROM skill_sources WHERE id = ?)
           AND state = 'ok'`,
      )
      .get(id) as { count: number };
    return row.count;
  }

  #activeTotalBytes(id: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(total_bytes), 0) AS bytes FROM skill_source_skills
         WHERE snapshot_id = (SELECT active_snapshot_id FROM skill_sources WHERE id = ?)
           AND state = 'ok'`,
      )
      .get(id) as { bytes: number };
    return row.bytes;
  }

  #snapshotSkills(snapshotId: string): SnapshotSkill[] {
    const rows = this.#db
      .prepare("SELECT * FROM skill_source_skills WHERE snapshot_id = ? AND state = 'ok'")
      .all(snapshotId) as SnapshotSkillRow[];
    return rows.map(mapSkillRow);
  }

  #touchChecked(id: string): void {
    this.#db
      .prepare("UPDATE skill_sources SET last_checked_at = ?, last_success_at = ? WHERE id = ?")
      .run(this.#timestamp(), this.#timestamp(), id);
  }

  #markSuccess(id: string, revision: string | null, etag: string | null): void {
    const timestamp = this.#timestamp();
    this.#db
      .prepare(
        `UPDATE skill_sources SET state = 'ready', last_checked_at = ?, last_success_at = ?,
           last_attempt_at = ?, last_error_code = NULL, last_error_message = NULL,
           revision = ?, etag = ? WHERE id = ?`,
      )
      .run(timestamp, timestamp, timestamp, revision, etag, id);
  }
}

function isFatalSyncError(error: unknown): boolean {
  return (
    error instanceof SkillSourceError &&
    [
      "hub_unreachable",
      "unauthorized",
      "file_http_error",
      "response_too_large",
      "file_hash_mismatch",
      "blob_missing",
      "blob_corrupt",
    ].includes(error.code)
  );
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
