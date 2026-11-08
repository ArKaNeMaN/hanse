import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashValue } from "../settings/hash.js";
import type { SqliteDatabase } from "../store/index.js";
import { skillVisibleAt } from "./access.js";
import { scanCollisions } from "./collisions.js";
import {
  assertInsideRoot,
  buildSkillDocument,
  materializeFailure,
  type RebuildResult,
  rebuildSkills,
} from "./materialize.js";
import type {
  EffectiveBundle,
  EffectiveSkill,
  ResolvedSkills,
  SkillApplyOptions,
  SkillCapture,
  SkillFile,
  SkillInput,
  SkillMaterializeResult,
  SkillMetadata,
  SkillPreview,
  SkillReference,
  SkillReferenceView,
  SkillRow,
  SkillScope,
  SkillSource,
  SkillStoredIssue,
  SkillSummary,
  SkillTarget,
  SkillUpdate,
  SkillWarning,
} from "./types.js";
import {
  assertNoFileConflicts,
  isLegacyReferenceFile,
  isSkillFilePath,
  isSkillName,
  isSkillReferencePath,
  legacyReferenceProjection,
  parseStoredMetadata,
  referencesToFiles,
  SKILL_FILE_LIMITS,
  SKILL_LIMITS,
  SkillValidationError,
  type StoredMetadataResult,
  sha256Bytes,
  validateSkillCompatibility,
  validateSkillContent,
  validateSkillDescription,
  validateSkillEnabled,
  validateSkillFiles,
  validateSkillLicense,
  validateSkillMetadata,
  validateSkillName,
  validateSkillReferenceContent,
  validateSkillReferences,
} from "./validation.js";

/** A `create` conflict that HTTP callers should map to 409. */
export class SkillConflictError extends Error {
  readonly code = "skill_exists";

  constructor(message = "a skill with this name already exists at this scope") {
    super(message);
    this.name = "SkillConflictError";
  }
}

export interface SkillServiceOptions {
  db: SqliteDatabase;
  now?: () => Date;
}

interface SkillDbRow {
  id: number;
  scope: SkillScope;
  project_id: string;
  app_key: string;
  name: string;
  description: string;
  content: string;
  enabled: number;
  license: string | null;
  compatibility: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  origin: "local" | "forked";
  forked_from_source_id: string | null;
  forked_from_name: string | null;
  forked_from_revision: string | null;
}

interface NormalizedTarget {
  projectId?: string;
  appKey?: string;
}

interface SkillLocation {
  scope: SkillScope;
  projectId: string;
  appKey: string;
}

interface StoredReference {
  path: string;
  size: number;
  length: number;
  content?: string;
  contentValid?: boolean;
}

interface FullStoredReference extends StoredReference {
  content: string;
}

interface StoredFile {
  path: string;
  sha256: string;
  size: number;
  encoding: "utf8" | "binary";
  executable: boolean;
  content?: Uint8Array;
}

const FORBIDDEN_CONTENT_CODES = [
  ...Array.from({ length: 9 }, (_, index) => index),
  ...Array.from({ length: 21 }, (_, index) => index + 11),
  ...Array.from({ length: 33 }, (_, index) => index + 127),
];

const CONTENT_VALID_SQL = [
  "instr(content, char(0)) = 0",
  ...FORBIDDEN_CONTENT_CODES.filter((code) => code !== 0).map(
    (code) => `instr(content, char(${code})) = 0`,
  ),
].join(" AND ");

interface LoadedRecord {
  summary: SkillSummary;
  metadataRaw: string | null;
  fullReferences: SkillReference[] | undefined;
  files: StoredFile[];
  fullFiles: SkillFile[] | undefined;
}

interface ComputedSkills {
  scope: SkillScope;
  effective: EffectiveSkill[];
  bundles: EffectiveBundle[];
  rows: SkillSummary[];
  disabled: ResolvedSkills["disabled"];
  warnings: SkillWarning[];
}

const SCOPE_RANK: Record<SkillScope, number> = { global: 0, project: 1, app: 2 };

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new SkillValidationError(`${name} must be a string`);
  }
  return value;
}

function normalizeTarget(target: SkillTarget): NormalizedTarget {
  const projectId = optionalId(target.projectId, "projectId");
  const appKey = optionalId(target.appKey, "appKey");
  if (appKey !== undefined && projectId === undefined) {
    throw new SkillValidationError("appKey requires projectId");
  }
  return { projectId, appKey };
}

function scopeForTarget(target: NormalizedTarget): SkillScope {
  if (target.projectId === undefined) {
    return "global";
  }
  if (target.appKey === undefined) {
    return "project";
  }
  return "app";
}

function scopeLocation(scope: SkillScope, target: SkillTarget): SkillLocation {
  const normalized = normalizeTarget(target);
  switch (scope) {
    case "global":
      if (normalized.projectId !== undefined || normalized.appKey !== undefined) {
        throw new SkillValidationError("global scope does not accept projectId or appKey");
      }
      return { scope, projectId: "", appKey: "" };
    case "project":
      if (normalized.projectId === undefined) {
        throw new SkillValidationError("project scope requires projectId");
      }
      if (normalized.appKey !== undefined) {
        throw new SkillValidationError("project scope does not accept appKey");
      }
      return { scope, projectId: normalized.projectId, appKey: "" };
    case "app":
      if (normalized.projectId === undefined || normalized.appKey === undefined) {
        throw new SkillValidationError("app scope requires projectId and appKey");
      }
      return { scope, projectId: normalized.projectId, appKey: normalized.appKey };
    default:
      throw new SkillValidationError(`unknown skills scope: ${String(scope)}`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    error.message.includes("UNIQUE constraint failed: skills.")
  );
}

function metadataForHash(metadata: SkillMetadata): SkillMetadata {
  const normalized: SkillMetadata = {};
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key.length > 0 && value.length > 0) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function isUtf8Bytes(value: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
    return true;
  } catch {
    return false;
  }
}

function legacyEffectiveHash(effective: readonly EffectiveBundle[]): string | undefined {
  if (effective.length === 0) {
    return undefined;
  }
  const values = effective
    .map((skill) => {
      const license = skill.license?.trim() ?? "";
      const compatibility = skill.compatibility?.trim() ?? "";
      const metadata = metadataForHash(skill.metadata);
      const references = [...skill.references]
        .sort((left, right) => compareStrings(left.path, right.path))
        .map((reference) => ({ path: reference.path, content: reference.content }));
      return {
        name: skill.name,
        description: skill.description,
        content: skill.content,
        ...(license.length > 0 ? { license } : {}),
        ...(compatibility.length > 0 ? { compatibility } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(references.length > 0 ? { references } : {}),
      };
    })
    .sort((left, right) => compareStrings(left.name, right.name));
  return hashValue(values);
}

function effectiveHash(effective: readonly EffectiveBundle[]): string | undefined {
  if (effective.length === 0) {
    return undefined;
  }
  const hasExternal = effective.some((skill) => skill.mode === "external");
  const hasNonLegacy = effective.some(
    (skill) =>
      skill.mode === "managed" && (skill.files ?? []).some((file) => !isLegacyReferenceFile(file)),
  );
  if (!hasExternal && !hasNonLegacy) {
    return legacyEffectiveHash(effective);
  }
  const values = effective
    .map((skill) => {
      const files = [...(skill.files ?? [])]
        .sort((left, right) => compareStrings(left.path, right.path))
        .map((file) => ({
          path: file.path,
          sha256: file.sha256,
          size: file.size,
          ...(skill.mode === "managed" && file.executable === true ? { executable: true } : {}),
        }));
      if (skill.mode === "managed") {
        const bytes = Buffer.from(buildSkillDocument(skill), "utf8");
        files.push({ path: "SKILL.md", sha256: sha256Bytes(bytes), size: bytes.byteLength });
        files.sort((left, right) => compareStrings(left.path, right.path));
      }
      return { name: skill.name, files };
    })
    .sort((left, right) => compareStrings(left.name, right.name));
  return hashValue({ version: 2, skills: values });
}

export function effectiveSkillHash(effective: readonly EffectiveBundle[]): string | undefined {
  return effectiveHash(effective);
}

const SELECT_COLUMNS =
  "id, scope, project_id, app_key, name, description, content, enabled, license, compatibility, metadata_json, created_at, updated_at, updated_by, origin, forked_from_source_id, forked_from_name, forked_from_revision";

/** Hierarchical skill registry with deterministic per-instance materialization. */
export class SkillService implements SkillSource {
  readonly #db: SqliteDatabase;
  readonly #now: (() => Date) | undefined;

  constructor(options: SkillServiceOptions) {
    this.#db = options.db;
    this.#now = options.now;
  }

  #timestamp(): string {
    return (this.#now === undefined ? new Date() : this.#now()).toISOString();
  }

  #transaction<T>(action: () => T): T {
    return this.#db.transaction(action)();
  }

  get(id: number): SkillRow | undefined {
    const row = this.#db.prepare(`SELECT ${SELECT_COLUMNS} FROM skills WHERE id = ?`).get(id) as
      | SkillDbRow
      | undefined;
    return row === undefined ? undefined : this.#mapFullRow(row);
  }

  create(scope: SkillScope, target: SkillTarget, input: SkillInput, actor: string): SkillRow {
    const location = scopeLocation(scope, target);
    const name = validateSkillName(input.name);
    const description = validateSkillDescription(input.description);
    const content = validateSkillContent(input.content);
    const enabled = input.enabled === undefined ? true : validateSkillEnabled(input.enabled);
    const license = validateSkillLicense(input.license);
    const compatibility = validateSkillCompatibility(input.compatibility);
    const metadata = input.metadata === undefined ? {} : validateSkillMetadata(input.metadata);
    if (input.files !== undefined && input.references !== undefined) {
      throw new SkillValidationError("files and references are mutually exclusive", "files");
    }
    const files =
      input.files !== undefined
        ? validateSkillFiles(input.files)
        : referencesToFiles(
            input.references === undefined ? [] : validateSkillReferences(input.references),
          );
    const references = legacyReferenceProjection(files);
    const timestamp = this.#timestamp();
    try {
      return this.#transaction(() => {
        const result = this.#db
          .prepare(
            `INSERT INTO skills
               (scope, project_id, app_key, name, description, content, enabled,
                license, compatibility, metadata_json, created_at, updated_at, updated_by)
             VALUES
               (@scope, @project_id, @app_key, @name, @description, @content, @enabled,
                @license, @compatibility, @metadata_json, @created_at, @updated_at, @updated_by)`,
          )
          .run({
            scope: location.scope,
            project_id: location.projectId,
            app_key: location.appKey,
            name,
            description,
            content,
            enabled: enabled ? 1 : 0,
            license,
            compatibility,
            metadata_json: JSON.stringify(metadata),
            created_at: timestamp,
            updated_at: timestamp,
            updated_by: actor,
          });
        const id = Number(result.lastInsertRowid);
        this.#replaceFiles(id, files);
        this.#replaceReferences(id, references);
        return this.#requireRow(id);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SkillConflictError();
      }
      throw error;
    }
  }

  update(id: number, patch: SkillUpdate, actor: string): SkillRow {
    this.#requireRow(id);
    const updates: string[] = [];
    const params: Record<string, unknown> = {
      id,
      updated_at: this.#timestamp(),
      updated_by: actor,
    };
    if (patch.description !== undefined) {
      updates.push("description = @description");
      params.description = validateSkillDescription(patch.description);
    }
    if (patch.content !== undefined) {
      updates.push("content = @content");
      params.content = validateSkillContent(patch.content);
    }
    if (patch.enabled !== undefined) {
      updates.push("enabled = @enabled");
      params.enabled = validateSkillEnabled(patch.enabled) ? 1 : 0;
    }
    if (patch.license !== undefined) {
      updates.push("license = @license");
      params.license = validateSkillLicense(patch.license);
    }
    if (patch.compatibility !== undefined) {
      updates.push("compatibility = @compatibility");
      params.compatibility = validateSkillCompatibility(patch.compatibility);
    }
    if (patch.metadata !== undefined) {
      updates.push("metadata_json = @metadata_json");
      params.metadata_json = JSON.stringify(validateSkillMetadata(patch.metadata));
    }
    if (patch.files !== undefined && patch.references !== undefined) {
      throw new SkillValidationError("files and references are mutually exclusive", "files");
    }
    const files = patch.files === undefined ? undefined : validateSkillFiles(patch.files);
    const references =
      patch.references === undefined ? undefined : validateSkillReferences(patch.references);
    updates.push("updated_at = @updated_at", "updated_by = @updated_by");
    return this.#transaction(() => {
      this.#db.prepare(`UPDATE skills SET ${updates.join(", ")} WHERE id = @id`).run(params);
      if (files !== undefined) {
        this.#replaceFiles(id, files);
        this.#replaceReferences(id, legacyReferenceProjection(files));
      } else if (references !== undefined) {
        this.#applyReferencesPatch(id, references);
      }
      return this.#requireRow(id);
    });
  }

  override(
    fromId: number,
    scope: SkillScope,
    target: SkillTarget,
    enabled: boolean | undefined,
    actor: string,
  ): SkillRow {
    const location = scopeLocation(scope, target);
    const safeEnabled = enabled === undefined ? true : validateSkillEnabled(enabled);
    const source = this.get(fromId);
    if (
      source === undefined ||
      !source.enabled ||
      !isSkillName(source.name) ||
      !skillVisibleAt(source, { projectId: location.projectId, appKey: location.appKey })
    ) {
      throw new SkillValidationError("invalid_override_source");
    }
    const license = validateSkillLicense(source.license);
    const compatibility = validateSkillCompatibility(source.compatibility);
    const metadata = validateSkillMetadata(source.metadata);
    const files =
      source.files !== undefined && source.files.length > 0
        ? source.files
        : referencesToFiles(source.references);
    assertNoFileConflicts(files);
    const references = legacyReferenceProjection(files);
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO skills
             (scope, project_id, app_key, name, description, content, enabled,
              license, compatibility, metadata_json, origin, forked_from_source_id,
              forked_from_name, forked_from_revision, created_at, updated_at, updated_by)
           VALUES
             (@scope, @project_id, @app_key, @name, @description, @content, @enabled,
              @license, @compatibility, @metadata_json, @origin, @forked_from_source_id,
              @forked_from_name, @forked_from_revision, @created_at, @updated_at, @updated_by)
           ON CONFLICT(scope, project_id, app_key, name) DO UPDATE SET
             description = excluded.description,
             content = excluded.content,
             enabled = excluded.enabled,
             license = excluded.license,
             compatibility = excluded.compatibility,
             metadata_json = excluded.metadata_json,
             origin = excluded.origin,
             forked_from_source_id = excluded.forked_from_source_id,
             forked_from_name = excluded.forked_from_name,
             forked_from_revision = excluded.forked_from_revision,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`,
        )
        .run({
          scope: location.scope,
          project_id: location.projectId,
          app_key: location.appKey,
          name: source.name,
          description: source.description,
          content: source.content,
          enabled: safeEnabled ? 1 : 0,
          license,
          compatibility,
          metadata_json: JSON.stringify(metadata),
          origin: source.origin,
          forked_from_source_id: source.forkedFromSourceId,
          forked_from_name: source.forkedFromName,
          forked_from_revision: source.forkedFromRevision,
          created_at: timestamp,
          updated_at: timestamp,
          updated_by: actor,
        });
      const row = this.#requireRowByName(location, source.name);
      this.#replaceFiles(row.id, files);
      this.#replaceReferences(row.id, references);
      return this.#requireRow(row.id);
    });
  }

  delete(id: number): boolean {
    const result = this.#db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    return result.changes > 0;
  }

  capture(target: SkillTarget): SkillCapture {
    const computed = this.#compute(target, true);
    const resolved = this.#toResolved(computed);
    return {
      hash: effectiveHash(computed.bundles),
      capturedAt: this.#timestamp(),
      resolved,
      managed: computed.bundles,
      external: [],
    };
  }

  resolve(target: SkillTarget, capture?: SkillCapture): ResolvedSkills {
    if (capture !== undefined) {
      return capture.resolved;
    }
    const computed = this.#compute(target, false);
    return this.#toResolved(computed);
  }

  hash(target: SkillTarget, capture?: SkillCapture): string | undefined {
    if (capture !== undefined) {
      return capture.hash;
    }
    return effectiveHash(this.#compute(target, true).bundles);
  }

  preview(target: SkillTarget, options: SkillApplyOptions, capture?: SkillCapture): SkillPreview {
    const resolved = capture?.resolved ?? this.resolve(target);
    const collisions = this.#collisions(resolved, options, undefined);
    return {
      resolved,
      warnings: [...resolved.warnings, ...collisions.warnings],
      ...(collisions.truncated === undefined ? {} : { truncated: collisions.truncated }),
    };
  }

  probe(
    target: SkillTarget,
    xdgConfigHome: string,
    options: SkillApplyOptions,
    capture?: SkillCapture,
  ): SkillMaterializeResult {
    const captured = capture ?? this.capture(target);
    const bundles = captured.managed;
    const resolved = captured.resolved;
    const hash = captured.hash;
    const collisions = this.#collisions(resolved, options, xdgConfigHome);
    assertInsideRoot(options.appRoot, xdgConfigHome);
    // Probe into a coordinator-private directory outside the agent-writable
    // application tree. The running agent can write its config root, so staging
    // there would allow it to race materialization with a symlink swap. The live
    // roots are rebuilt only after the container is gone (manager.apply).
    const staging = mkdtempSync(path.join(os.tmpdir(), "hanse-skills-probe-"));
    try {
      const rebuilt = rebuildSkills({
        appRoot: staging,
        opencodeRoot: staging,
        effective: bundles,
        preserveFirstDeploy: false,
      });
      return this.#materializeResult(resolved, hash, rebuilt, collisions);
    } catch (error) {
      throw materializeFailure(error);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  apply(
    target: SkillTarget,
    xdgConfigHome: string,
    options: SkillApplyOptions,
    capture?: SkillCapture,
  ): SkillMaterializeResult {
    const captured = capture ?? this.capture(target);
    const bundles = captured.managed;
    const resolved = captured.resolved;
    const hash = captured.hash;
    const collisions = this.#collisions(resolved, options, xdgConfigHome);
    try {
      assertInsideRoot(options.appRoot, xdgConfigHome);
      mkdirSync(xdgConfigHome, { recursive: true, mode: 0o755 });
      const rebuilt = rebuildSkills({
        appRoot: options.appRoot,
        opencodeRoot: path.join(xdgConfigHome, "opencode"),
        effective: bundles,
        preserveFirstDeploy: true,
      });
      return this.#materializeResult(resolved, hash, rebuilt, collisions);
    } catch (error) {
      throw materializeFailure(error);
    }
  }

  #compute(target: SkillTarget, withContents: boolean): ComputedSkills {
    const normalized = normalizeTarget(target);
    const pageScope = scopeForTarget(normalized);
    const records = this.#loadRecords(normalized, withContents);

    const byName = new Map<string, LoadedRecord[]>();
    for (const record of records) {
      if (!isSkillName(record.summary.name)) {
        continue;
      }
      const group = byName.get(record.summary.name);
      if (group === undefined) {
        byName.set(record.summary.name, [record]);
      } else {
        group.push(record);
      }
    }

    const effective: EffectiveSkill[] = [];
    const bundles: EffectiveBundle[] = [];
    const disabled: ResolvedSkills["disabled"] = [];
    for (const name of [...byName.keys()].sort(compareStrings)) {
      const group = byName.get(name);
      if (group === undefined) {
        continue;
      }
      group.sort((left, right) => SCOPE_RANK[left.summary.scope] - SCOPE_RANK[right.summary.scope]);
      let winnerIndex = -1;
      let tombstone = false;
      for (let index = group.length - 1; index >= 0; index -= 1) {
        const candidate = group[index];
        if (candidate === undefined) {
          continue;
        }
        if (!candidate.summary.enabled) {
          const widerSource = [...group.slice(0, index)]
            .reverse()
            .find((row) => row.summary.enabled);
          disabled.push({
            id: candidate.summary.id,
            name,
            source: widerSource?.summary.scope ?? null,
            disabledBy: candidate.summary.scope,
          });
          tombstone = true;
          break;
        }
        if (candidate.summary.storedIssues.length > 0) {
          continue;
        }
        winnerIndex = index;
        break;
      }
      if (tombstone || winnerIndex < 0) {
        continue;
      }
      const winner = group[winnerIndex];
      if (winner === undefined) {
        continue;
      }
      const shadows = group.slice(0, winnerIndex).map((row) => row.summary.scope);
      const base = {
        id: winner.summary.id,
        name,
        description: winner.summary.description,
        content: winner.summary.content,
        license: winner.summary.license,
        compatibility: winner.summary.compatibility,
        metadata: winner.summary.metadata,
        source: winner.summary.scope,
        shadows,
        shadowedExternal: false,
        mode: "managed" as const,
        origin: null,
        externalKey: null,
        fileCount: winner.files.length,
        updatedAt: winner.summary.updatedAt,
        updatedBy: winner.summary.updatedBy,
      };
      effective.push({ ...base, references: winner.summary.references });
      if (withContents) {
        bundles.push({
          ...base,
          references: winner.fullReferences ?? [],
          files: winner.fullFiles ?? [],
        });
      }
    }

    const scopedRows = records
      .filter((record) => record.summary.scope === pageScope)
      .map((record) => record.summary)
      .sort((left, right) => compareStrings(left.name, right.name));

    return {
      scope: pageScope,
      effective,
      bundles,
      rows: scopedRows,
      disabled,
      warnings: [],
    };
  }

  #toResolved(computed: ComputedSkills): ResolvedSkills {
    return {
      scope: computed.scope,
      effective: computed.effective,
      rows: computed.rows,
      disabled: computed.disabled,
      warnings: computed.warnings,
    };
  }

  #collisions(
    resolved: ResolvedSkills,
    options: SkillApplyOptions,
    xdgConfigHome: string | undefined,
  ): { warnings: SkillWarning[]; truncated?: number } {
    return scanCollisions({
      effectiveNames: resolved.effective.map((skill) => skill.name),
      disabledNames: resolved.disabled.map((entry) => entry.name),
      xdgConfigHome,
      options,
    });
  }

  #materializeResult(
    resolved: ResolvedSkills,
    hash: string | undefined,
    rebuilt: RebuildResult,
    collisions: { warnings: SkillWarning[]; truncated?: number },
  ): SkillMaterializeResult {
    return {
      hash,
      written: rebuilt.written,
      removed: rebuilt.removed,
      preserved: rebuilt.preserved,
      warnings: [...resolved.warnings, ...collisions.warnings],
      ...(collisions.truncated === undefined ? {} : { truncated: collisions.truncated }),
    };
  }

  #loadRecords(target: NormalizedTarget, withContents: boolean): LoadedRecord[] {
    const conditions = ["scope = 'global'"];
    const params: Record<string, string> = {};
    if (target.projectId !== undefined) {
      conditions.push("(scope = 'project' AND project_id = @projectId)");
      params.projectId = target.projectId;
      if (target.appKey !== undefined) {
        conditions.push("(scope = 'app' AND project_id = @projectId AND app_key = @appKey)");
        params.appKey = target.appKey;
      }
    }
    const raw = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM skills WHERE ${conditions.join(" OR ")}`)
      .all(params) as SkillDbRow[];

    return raw.map((row) => {
      const files = this.#summaryFiles(row.id);
      if (withContents) {
        const fullFiles = this.#fullFiles(row.id);
        const stored = this.#fullReferences(row.id);
        const references: FullStoredReference[] =
          stored.length > 0
            ? stored
            : legacyReferenceProjection(fullFiles).map((reference) => ({
                path: reference.path,
                content: reference.content,
                size: Buffer.byteLength(reference.content, "utf8"),
                length: reference.content.length,
              }));
        return this.#buildRecord(row, references, references, files, fullFiles);
      }
      return this.#buildRecord(row, this.#summaryReferences(row.id), undefined, files, undefined);
    });
  }

  #summaryFiles(skillId: number): StoredFile[] {
    const rows = this.#db
      .prepare(
        `SELECT path, sha256, size, encoding, executable
         FROM skill_files WHERE skill_id = ? ORDER BY path`,
      )
      .all(skillId) as Array<{
      path: string;
      sha256: string | null;
      size: number | null;
      encoding: "utf8" | "binary";
      executable: number;
    }>;
    if (rows.length > 0) {
      return rows.map((row) => ({
        path: row.path,
        sha256: row.sha256 ?? "",
        size: row.size ?? 0,
        encoding: row.encoding,
        executable: row.executable === 1,
      }));
    }
    return this.#summaryReferences(skillId).map((reference) => ({
      path: reference.path,
      sha256: "",
      size: reference.size,
      encoding: "utf8",
      executable: false,
    }));
  }

  #fullFiles(skillId: number): SkillFile[] {
    const rows = this.#db
      .prepare(
        `SELECT path, content, sha256, size, encoding, executable
         FROM skill_files WHERE skill_id = ? ORDER BY path`,
      )
      .all(skillId) as Array<{
      path: string;
      content: Buffer;
      sha256: string | null;
      size: number | null;
      encoding: "utf8" | "binary";
      executable: number;
    }>;
    if (rows.length === 0) {
      return referencesToFiles(
        this.#fullReferences(skillId).map((reference) => ({
          path: reference.path,
          content: reference.content,
        })),
      );
    }
    return rows.map((row) => {
      const content = Buffer.from(row.content);
      return {
        path: row.path,
        content,
        sha256: row.sha256 ?? sha256Bytes(content),
        size: row.size ?? content.byteLength,
        executable: row.executable === 1,
      };
    });
  }

  #summaryReferences(skillId: number): StoredReference[] {
    const rows = this.#db
      .prepare(
        `SELECT path, length(content) AS chars, length(CAST(content AS BLOB)) AS size,
                (${CONTENT_VALID_SQL}) AS content_valid
         FROM skill_references WHERE skill_id = ? ORDER BY path`,
      )
      .all(skillId) as Array<{
      path: string;
      chars: number;
      size: number;
      content_valid: number;
    }>;
    return rows.map((reference) => ({
      path: reference.path,
      size: reference.size,
      length: reference.chars,
      contentValid: reference.content_valid === 1,
    }));
  }

  #fullReferences(skillId: number): FullStoredReference[] {
    const rows = this.#db
      .prepare(
        `SELECT path, content, length(content) AS chars, length(CAST(content AS BLOB)) AS size
         FROM skill_references WHERE skill_id = ? ORDER BY path`,
      )
      .all(skillId) as Array<{ path: string; content: string; chars: number; size: number }>;
    return rows.map((reference) => ({
      path: reference.path,
      size: reference.size,
      length: reference.chars,
      content: reference.content,
    }));
  }

  #buildRecord(
    row: SkillDbRow,
    references: StoredReference[],
    contentReferences: FullStoredReference[] | undefined,
    files: StoredFile[],
    fullFiles: SkillFile[] | undefined,
  ): LoadedRecord {
    const metadata = parseStoredMetadata(row.metadata_json);
    const issues = this.#storedIssues(row, metadata, references, files);
    const summary: SkillSummary = {
      id: row.id,
      scope: row.scope,
      projectId: row.project_id,
      appKey: row.app_key,
      name: row.name,
      description: row.description,
      content: row.content,
      license: row.license,
      compatibility: row.compatibility,
      metadata: metadata.metadata,
      references: references.map(
        (reference): SkillReferenceView => ({ path: reference.path, size: reference.size }),
      ),
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      storedIssues: issues,
      origin: row.origin,
      forkedFromSourceId: row.forked_from_source_id,
      forkedFromName: row.forked_from_name,
      forkedFromRevision: row.forked_from_revision,
    };
    const fullReferences =
      contentReferences === undefined
        ? undefined
        : contentReferences.map(
            (reference): SkillReference => ({
              path: reference.path,
              content: reference.content,
            }),
          );
    return {
      summary,
      metadataRaw: metadata.metadataRaw,
      fullReferences,
      files,
      fullFiles,
    };
  }

  #mapFullRow(row: SkillDbRow): SkillRow {
    const files = this.#fullFiles(row.id);
    const stored = this.#fullReferences(row.id);
    const references =
      stored.length > 0
        ? stored.map((reference) => ({
            path: reference.path,
            content: reference.content,
          }))
        : legacyReferenceProjection(files);
    const metadata = parseStoredMetadata(row.metadata_json);
    const issues = this.#storedIssues(
      row,
      metadata,
      references.map((reference) => ({
        path: reference.path,
        size: Buffer.byteLength(reference.content, "utf8"),
        length: reference.content.length,
        content: reference.content,
      })),
      files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        encoding: "utf8",
        executable: file.executable === true,
      })),
    );
    return {
      id: row.id,
      scope: row.scope,
      projectId: row.project_id,
      appKey: row.app_key,
      name: row.name,
      description: row.description,
      content: row.content,
      enabled: row.enabled === 1,
      license: row.license,
      compatibility: row.compatibility,
      metadata: metadata.metadata,
      references,
      files,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      storedIssues: issues,
      metadataRaw: metadata.metadataRaw,
      origin: row.origin,
      forkedFromSourceId: row.forked_from_source_id,
      forkedFromName: row.forked_from_name,
      forkedFromRevision: row.forked_from_revision,
    };
  }

  #storedIssues(
    row: SkillDbRow,
    metadata: StoredMetadataResult,
    references: readonly StoredReference[],
    files: readonly StoredFile[],
  ): SkillStoredIssue[] {
    if (!isSkillName(row.name)) {
      return [{ code: "invalid_skill_name" }];
    }
    const issues: SkillStoredIssue[] = [];
    if (metadata.issue !== null) {
      issues.push(metadata.issue);
    }
    if (files.length > SKILL_FILE_LIMITS.files) {
      issues.push({
        code: "invalid_skill_bundle",
        detail: "a skill may have at most 100 files",
      });
    }
    let fileBytes = 0;
    for (const file of files) {
      fileBytes += file.size;
      if (!isSkillFilePath(file.path)) {
        issues.push({
          code: "invalid_skill_file",
          path: file.path,
          detail: "invalid file path",
        });
      }
      if (file.size > SKILL_FILE_LIMITS.fileBytes) {
        issues.push({
          code: "invalid_skill_file",
          path: file.path,
          detail: "a skill file must be at most 1 MiB",
        });
      }
    }
    if (fileBytes > SKILL_FILE_LIMITS.bundleBytes) {
      issues.push({
        code: "invalid_skill_bundle",
        detail: "a skill bundle must be at most 8 MiB",
      });
    }
    try {
      assertNoFileConflicts(files);
    } catch (error) {
      issues.push({
        code: "invalid_skill_bundle",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (row.license !== null) {
      try {
        validateSkillLicense(row.license);
      } catch (error) {
        issues.push({
          code: "invalid_skill_bundle",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (row.compatibility !== null) {
      try {
        validateSkillCompatibility(row.compatibility);
      } catch (error) {
        issues.push({
          code: "invalid_skill_bundle",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (references.length > SKILL_LIMITS.references) {
      issues.push({
        code: "invalid_skill_bundle",
        detail: "a skill may have at most 20 references",
      });
    }
    let aggregate = 0;
    for (const reference of references) {
      aggregate += reference.length;
      if (!isSkillReferencePath(reference.path)) {
        issues.push({
          code: "invalid_skill_reference",
          path: reference.path,
          detail: "invalid reference path",
        });
        continue;
      }
      if (reference.content !== undefined) {
        try {
          validateSkillReferenceContent(reference.content);
        } catch (error) {
          issues.push({
            code: "invalid_skill_reference",
            path: reference.path,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (reference.contentValid === false) {
        issues.push({
          code: "invalid_skill_reference",
          path: reference.path,
          detail: "invalid reference content",
        });
      }
    }
    if (aggregate > SKILL_LIMITS.referenceAggregate) {
      issues.push({
        code: "invalid_skill_bundle",
        detail: "references must total at most 192000 characters",
      });
    }
    return issues.filter(
      (issue) =>
        issue.code !== "invalid_skill_file" ||
        !issues.some(
          (other) => other.code === "invalid_skill_reference" && other.path === issue.path,
        ),
    );
  }

  #replaceReferences(skillId: number, references: readonly SkillReference[]): void {
    this.#db.prepare("DELETE FROM skill_references WHERE skill_id = ?").run(skillId);
    const insert = this.#db.prepare(
      "INSERT INTO skill_references (skill_id, path, content) VALUES (?, ?, ?)",
    );
    for (const reference of references) {
      insert.run(skillId, reference.path, reference.content);
    }
  }

  #replaceFiles(skillId: number, files: readonly SkillFile[]): void {
    this.#db.prepare("DELETE FROM skill_files WHERE skill_id = ?").run(skillId);
    const insert = this.#db.prepare(
      `INSERT INTO skill_files
         (skill_id, path, content, encoding, executable, sha256, size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const timestamp = this.#timestamp();
    for (const file of files) {
      insert.run(
        skillId,
        file.path,
        Buffer.from(file.content),
        isUtf8Bytes(file.content) ? "utf8" : "binary",
        file.executable === true ? 1 : 0,
        file.sha256,
        file.size,
        timestamp,
      );
    }
  }

  #applyReferencesPatch(skillId: number, references: readonly SkillReference[]): void {
    const oldPaths = new Set(
      (
        this.#db
          .prepare("SELECT path FROM skill_references WHERE skill_id = ?")
          .all(skillId) as Array<{ path: string }>
      ).map((row) => row.path),
    );
    const exists = this.#db.prepare(
      "SELECT 1 FROM skill_files WHERE skill_id = ? AND path = ? LIMIT 1",
    );
    for (const reference of references) {
      if (oldPaths.has(reference.path)) {
        continue;
      }
      if (exists.get(skillId, reference.path) !== undefined) {
        throw new SkillValidationError(
          `file path ${reference.path} already exists outside the legacy reference set`,
          "references",
        );
      }
    }
    const remove = this.#db.prepare("DELETE FROM skill_files WHERE skill_id = ? AND path = ?");
    for (const path of oldPaths) {
      remove.run(skillId, path);
    }
    this.#replaceReferences(skillId, references);
    const timestamp = this.#timestamp();
    const insert = this.#db.prepare(
      `INSERT INTO skill_files
         (skill_id, path, content, encoding, executable, sha256, size, updated_at)
       VALUES (?, ?, ?, 'utf8', 0, ?, ?, ?)`,
    );
    for (const reference of references) {
      const bytes = Buffer.from(reference.content, "utf8");
      insert.run(skillId, reference.path, bytes, sha256Bytes(bytes), bytes.byteLength, timestamp);
    }
  }

  #requireRow(id: number): SkillRow {
    const row = this.get(id);
    if (row === undefined) {
      throw new SkillValidationError(`skill ${id} not found`);
    }
    return row;
  }

  #requireRowByName(location: SkillLocation, name: string): SkillRow {
    const row = this.#db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM skills
         WHERE scope = ? AND project_id = ? AND app_key = ? AND name = ?`,
      )
      .get(location.scope, location.projectId, location.appKey, name) as SkillDbRow | undefined;
    if (row === undefined) {
      throw new Error(`skill ${name} was not persisted`);
    }
    return this.#mapFullRow(row);
  }
}
