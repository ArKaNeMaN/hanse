import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashValue } from "../settings/hash.js";
import type { SqliteDatabase } from "../store/index.js";
import { scanCollisions } from "./collisions.js";
import {
  assertInsideRoot,
  materializeFailure,
  type RebuildResult,
  rebuildSkills,
} from "./materialize.js";
import type {
  EffectiveSkill,
  ResolvedSkills,
  SkillApplyOptions,
  SkillInput,
  SkillMaterializeResult,
  SkillPreview,
  SkillRow,
  SkillScope,
  SkillSource,
  SkillTarget,
  SkillUpdate,
  SkillWarning,
} from "./types.js";
import {
  isSkillName,
  SkillValidationError,
  validateSkillContent,
  validateSkillDescription,
  validateSkillEnabled,
  validateSkillName,
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
  created_at: string;
  updated_at: string;
  updated_by: string | null;
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

function mapRow(row: SkillDbRow): SkillRow {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    appKey: row.app_key,
    name: row.name,
    description: row.description,
    content: row.content,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
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

function effectiveHash(effective: readonly EffectiveSkill[]): string | undefined {
  if (effective.length === 0) {
    return undefined;
  }
  const values = effective
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
    }))
    .sort((left, right) => compareStrings(left.name, right.name));
  return hashValue(values);
}

function sourceVisibleAt(source: SkillRow, location: SkillLocation): boolean {
  if (source.scope === "global") {
    return true;
  }
  if (source.scope === "project") {
    return source.projectId === location.projectId;
  }
  return source.projectId === location.projectId && source.appKey === location.appKey;
}

const SELECT_COLUMNS =
  "id, scope, project_id, app_key, name, description, content, enabled, created_at, updated_at, updated_by";

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

  get(id: number): SkillRow | undefined {
    const row = this.#db.prepare(`SELECT ${SELECT_COLUMNS} FROM skills WHERE id = ?`).get(id) as
      | SkillDbRow
      | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  create(scope: SkillScope, target: SkillTarget, input: SkillInput, actor: string): SkillRow {
    const location = scopeLocation(scope, target);
    const name = validateSkillName(input.name);
    const description = validateSkillDescription(input.description);
    const content = validateSkillContent(input.content);
    const enabled = input.enabled === undefined ? true : validateSkillEnabled(input.enabled);
    const timestamp = this.#timestamp();
    try {
      const result = this.#db
        .prepare(
          `INSERT INTO skills
             (scope, project_id, app_key, name, description, content, enabled,
              created_at, updated_at, updated_by)
           VALUES
             (@scope, @project_id, @app_key, @name, @description, @content, @enabled,
              @created_at, @updated_at, @updated_by)`,
        )
        .run({
          scope: location.scope,
          project_id: location.projectId,
          app_key: location.appKey,
          name,
          description,
          content,
          enabled: enabled ? 1 : 0,
          created_at: timestamp,
          updated_at: timestamp,
          updated_by: actor,
        });
      return this.#requireRow(Number(result.lastInsertRowid));
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
    updates.push("updated_at = @updated_at", "updated_by = @updated_by");
    this.#db.prepare(`UPDATE skills SET ${updates.join(", ")} WHERE id = @id`).run(params);
    return this.#requireRow(id);
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
      !sourceVisibleAt(source, location)
    ) {
      throw new SkillValidationError("invalid_override_source");
    }
    const timestamp = this.#timestamp();
    this.#db
      .prepare(
        `INSERT INTO skills
           (scope, project_id, app_key, name, description, content, enabled,
            created_at, updated_at, updated_by)
         VALUES
           (@scope, @project_id, @app_key, @name, @description, @content, @enabled,
            @created_at, @updated_at, @updated_by)
         ON CONFLICT(scope, project_id, app_key, name) DO UPDATE SET
           description = excluded.description,
           content = excluded.content,
           enabled = excluded.enabled,
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
        created_at: timestamp,
        updated_at: timestamp,
        updated_by: actor,
      });
    return this.#requireRowByName(location, source.name);
  }

  delete(id: number): boolean {
    const result = this.#db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    return result.changes > 0;
  }

  resolve(target: SkillTarget): ResolvedSkills {
    const normalized = normalizeTarget(target);
    const pageScope = scopeForTarget(normalized);
    const { rows, warnings } = this.#readRows(normalized);

    const byName = new Map<string, SkillRow[]>();
    for (const row of rows) {
      const group = byName.get(row.name);
      if (group === undefined) {
        byName.set(row.name, [row]);
      } else {
        group.push(row);
      }
    }

    const effective: EffectiveSkill[] = [];
    const disabled: ResolvedSkills["disabled"] = [];
    for (const name of [...byName.keys()].sort(compareStrings)) {
      const group = byName.get(name);
      if (group === undefined) {
        continue;
      }
      group.sort((left, right) => SCOPE_RANK[left.scope] - SCOPE_RANK[right.scope]);
      const winner = group[group.length - 1];
      if (winner === undefined) {
        continue;
      }
      if (winner.enabled) {
        effective.push({
          id: winner.id,
          name,
          description: winner.description,
          content: winner.content,
          source: winner.scope,
          shadows: group.slice(0, -1).map((row) => row.scope),
        });
      } else {
        const widerSource = [...group.slice(0, -1)].reverse().find((row) => row.enabled);
        disabled.push({
          id: winner.id,
          name,
          source: widerSource?.scope ?? null,
          disabledBy: winner.scope,
        });
      }
    }

    const scopedRows = rows
      .filter((row) => row.scope === pageScope)
      .sort((left, right) => compareStrings(left.name, right.name));

    return {
      scope: pageScope,
      effective,
      rows: scopedRows,
      disabled,
      warnings,
    };
  }

  hash(target: SkillTarget): string | undefined {
    return effectiveHash(this.resolve(target).effective);
  }

  preview(target: SkillTarget, options: SkillApplyOptions): SkillPreview {
    const resolved = this.resolve(target);
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
  ): SkillMaterializeResult {
    const resolved = this.resolve(target);
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
        effective: resolved.effective,
        preserveFirstDeploy: false,
      });
      return this.#materializeResult(resolved, rebuilt, collisions);
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
  ): SkillMaterializeResult {
    const resolved = this.resolve(target);
    const collisions = this.#collisions(resolved, options, xdgConfigHome);
    try {
      assertInsideRoot(options.appRoot, xdgConfigHome);
      mkdirSync(xdgConfigHome, { recursive: true, mode: 0o755 });
      const rebuilt = rebuildSkills({
        appRoot: options.appRoot,
        opencodeRoot: path.join(xdgConfigHome, "opencode"),
        effective: resolved.effective,
        preserveFirstDeploy: true,
      });
      return this.#materializeResult(resolved, rebuilt, collisions);
    } catch (error) {
      throw materializeFailure(error);
    }
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
    rebuilt: RebuildResult,
    collisions: { warnings: SkillWarning[]; truncated?: number },
  ): SkillMaterializeResult {
    return {
      hash: effectiveHash(resolved.effective),
      written: rebuilt.written,
      removed: rebuilt.removed,
      preserved: rebuilt.preserved,
      warnings: [...resolved.warnings, ...collisions.warnings],
      ...(collisions.truncated === undefined ? {} : { truncated: collisions.truncated }),
    };
  }

  #readRows(target: NormalizedTarget): { rows: SkillRow[]; warnings: SkillWarning[] } {
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

    const rows: SkillRow[] = [];
    const warnings: SkillWarning[] = [];
    for (const row of raw) {
      if (!isSkillName(row.name)) {
        warnings.push({ code: "invalid_skill_name", id: row.id });
        continue;
      }
      rows.push(mapRow(row));
    }
    warnings.sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
    return { rows, warnings };
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
    return mapRow(row);
  }
}
