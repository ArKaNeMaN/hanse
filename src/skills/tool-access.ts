import { isMasterApp, isMasterProject } from "../master/constants.js";
import type { SqliteDatabase } from "../store/database.js";
import { isOwnAppSkillRow, skillVisibleAt } from "./access.js";
import type { SkillService } from "./service.js";
import { SkillToolError, unknownSkillError } from "./tool-errors.js";
import type { SkillRow, SkillScope, SkillSummary, SkillTarget } from "./types.js";
import {
  SkillValidationError,
  validateSkillContent,
  validateSkillDescription,
} from "./validation.js";

interface TargetProjectRow {
  id: string;
  deleting: number;
}

interface TargetAppRow {
  deleting: number;
}

function projectRow(db: SqliteDatabase, projectId: string): TargetProjectRow | undefined {
  return db.prepare("SELECT id, deleting FROM projects WHERE id = ?").get(projectId) as
    | TargetProjectRow
    | undefined;
}

function appRow(db: SqliteDatabase, projectId: string, appKey: string): TargetAppRow | undefined {
  return db
    .prepare("SELECT deleting FROM apps WHERE project_id = ? AND app_key = ?")
    .get(projectId, appKey) as TargetAppRow | undefined;
}

/**
 * Validate a skill target before and inside a mutation transaction: project exists, is not the
 * reserved master project, and is not deleting; app scope additionally requires an existing,
 * non-master, non-deleting application.
 */
export function assertSkillTarget(
  db: SqliteDatabase,
  scope: SkillScope,
  target: SkillTarget,
): void {
  if (scope === "global") {
    return;
  }
  const project = projectRow(db, target.projectId ?? "");
  if (project === undefined) {
    throw new SkillToolError("unknown_project", "project not found");
  }
  if (isMasterProject(project.id)) {
    throw new SkillToolError("master_protected", "the master project cannot own agent skills");
  }
  if (project.deleting === 1) {
    throw new SkillToolError("deletion_pending", "the project is pending deletion");
  }
  if (scope !== "app") {
    return;
  }
  const app = appRow(db, project.id, target.appKey ?? "");
  if (app === undefined) {
    throw new SkillToolError("unknown_app", "application not found");
  }
  if (isMasterApp(project.id, target.appKey ?? "")) {
    throw new SkillToolError("master_protected", "the master application cannot own agent skills");
  }
  if (app.deleting === 1) {
    throw new SkillToolError("deletion_pending", "the application is pending deletion");
  }
}

/** Require a row defined at exactly the caller's application scope. */
export function assertOwnAppSkillRow(row: SkillRow, target: SkillTarget): void {
  if (isOwnAppSkillRow(row, target)) {
    return;
  }
  if (skillVisibleAt(row, target)) {
    throw new SkillToolError(
      "invalid_argument",
      "this skill is defined at a wider scope; override it into this application instead of changing it",
    );
  }
  throw unknownSkillError(row.id);
}

/** Require a row that is either the caller's own app row or effective in the caller's chain. */
export function assertSkillReadable(
  skills: SkillService,
  row: SkillRow,
  target: SkillTarget,
): void {
  if (isOwnAppSkillRow(row, target)) {
    return;
  }
  if (
    skillVisibleAt(row, target) &&
    skills.resolve(target).effective.some((entry) => entry.id === row.id)
  ) {
    return;
  }
  throw unknownSkillError(row.id);
}

/** Require a source row whose stored bundle still validates as an override source. */
export function assertOverridableSource(source: SkillRow): void {
  if (source.storedIssues.length > 0) {
    throw new SkillToolError(
      "invalid_skill",
      `source skill ${source.id} has stored issues; repair it before overriding`,
    );
  }
  try {
    validateSkillDescription(source.description);
    validateSkillContent(source.content);
  } catch (error) {
    if (error instanceof SkillValidationError) {
      throw new SkillToolError(
        "invalid_skill",
        error.field === undefined ? error.message : `${error.field}: ${error.message}`,
      );
    }
    throw error;
  }
}

/** Existing-row context for a same-scope create conflict. */
export function skillConflictError(
  skills: SkillService,
  scope: SkillScope,
  target: SkillTarget,
  name: string,
): SkillToolError {
  let existing: ReturnType<SkillService["resolve"]>["rows"][number] | undefined;
  try {
    existing = skills.resolve(target).rows.find((row) => row.scope === scope && row.name === name);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    return new SkillToolError(
      "skill_exists",
      `a skill named "${name}" already exists at ${scope} scope (id ${existing.id}, updated by ${existing.updatedBy ?? "unknown"} at ${existing.updatedAt}); choose a different name or ask the operator to edit it`,
    );
  }
  return new SkillToolError(
    "skill_exists",
    `a skill named "${name}" already exists at ${scope} scope; choose a different name or ask the operator to edit it`,
  );
}

/** Message for an override that would replace a same-name target row without confirmation. */
export function replacementConfirmationError(row: SkillSummary): SkillToolError {
  return new SkillToolError(
    "replacement_confirmation_required",
    `a skill named "${row.name}" already exists at the target (id ${row.id}, updated by ${row.updatedBy ?? "unknown"} at ${row.updatedAt}); pass confirm_replace: true to replace it`,
  );
}
