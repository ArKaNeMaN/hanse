import type { SkillRow, SkillTarget } from "./types.js";

/**
 * Whether a stored row participates in the caller's resolution chain: global rows are visible
 * everywhere, project rows only in their own project, and app rows only in their own application.
 */
export function skillVisibleAt(row: SkillRow, target: SkillTarget): boolean {
  if (row.scope === "global") {
    return true;
  }
  const projectId = target.projectId ?? "";
  if (row.scope === "project") {
    return row.projectId === projectId;
  }
  return row.projectId === projectId && row.appKey === (target.appKey ?? "");
}

/** Whether a row is defined at exactly the caller's own application scope. */
export function isOwnAppSkillRow(row: SkillRow, target: SkillTarget): boolean {
  return (
    row.scope === "app" &&
    row.projectId === (target.projectId ?? "") &&
    row.appKey === (target.appKey ?? "")
  );
}

/** The scope target a stored row belongs to. */
export function skillRowTarget(row: SkillRow): SkillTarget {
  if (row.scope === "global") {
    return {};
  }
  if (row.scope === "project") {
    return { projectId: row.projectId };
  }
  return { projectId: row.projectId, appKey: row.appKey };
}

/** Whether a stored row is the project or application row at the exact target. */
export function isSameSkillTarget(
  row: SkillRow,
  scope: "project" | "app",
  target: SkillTarget,
): boolean {
  return (
    row.scope === scope &&
    row.projectId === (target.projectId ?? "") &&
    row.appKey === (scope === "app" ? (target.appKey ?? "") : "")
  );
}
