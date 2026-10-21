export type SkillScope = "global" | "project" | "app";

export interface SkillRow {
  id: number;
  scope: SkillScope;
  /** `''` for wider scopes, matching the DB scope key. */
  projectId: string;
  /** `''` unless scope = "app". */
  appKey: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface EffectiveSkill {
  /** id of the winning enabled row (used by override/disable actions). */
  id: number;
  name: string;
  description: string;
  content: string;
  /** Scope of the winning row. */
  source: SkillScope;
  /** Wider scopes shadowed by this skill, wide to narrow. */
  shadows: SkillScope[];
}

export type SkillWarningCode =
  | "skill_collision"
  | "skill_disabled_elsewhere"
  | "invalid_skill_name";

export interface SkillWarning {
  code: SkillWarningCode;
  name?: string;
  root?: string;
  id?: number;
}

export interface ResolvedSkills {
  scope: SkillScope;
  effective: EffectiveSkill[];
  /** Rows owned by the page's scope, including disabled tombstones. */
  rows: SkillRow[];
  /** Names hidden by a tombstone at this scope; `id` is the tombstone row. */
  disabled: Array<{ id: number; name: string; source: SkillScope | null; disabledBy: SkillScope }>;
  warnings: SkillWarning[];
}

export interface SkillInput {
  name?: string;
  description: string;
  content: string;
  enabled?: boolean;
}

/** Partial patch for `POST /api/skills/:id`; only supplied fields are validated and written. */
export interface SkillUpdate {
  description?: string;
  content?: string;
  enabled?: boolean;
}

export interface SkillTarget {
  projectId?: string;
  appKey?: string;
}

export interface SkillApplyOptions {
  /** Isolated application root; the skills root must stay inside it. */
  appRoot: string;
  /** Isolated HOME, for `.claude`/`.agents` collision detection. */
  home: string;
  /** Isolated cache root, for downloaded-skill collision detection. */
  xdgCacheHome: string;
  /** Resolved application directory for repository-skill collision detection. */
  appDir: string;
  /** Baseline plugin specs, used exactly as the permission policy resolves `file://` skill roots. */
  baselinePlugins?: string[];
}

export interface SkillPreview {
  resolved: ResolvedSkills;
  /** Repository/plugin/external collisions, including disabled-tombstone collisions. */
  warnings: SkillWarning[];
  /** Number of warnings omitted by the 20-entry bound, when truncated. */
  truncated?: number;
}

export interface SkillMaterializeResult {
  hash: string | undefined;
  written: string[];
  removed: string[];
  preserved: string[];
  warnings: SkillWarning[];
  truncated?: number;
}

export interface SkillSource {
  resolve(target: SkillTarget): ResolvedSkills;
  /** Read-only collision preview; never writes. */
  preview(target: SkillTarget, options: SkillApplyOptions): SkillPreview;
  /** Effective enabled-set hash; `undefined` exactly when the effective set is empty. */
  hash(target: SkillTarget): string | undefined;
  /** Validate and materialize into a private staging root; removes it before returning. */
  probe(
    target: SkillTarget,
    xdgConfigHome: string,
    options: SkillApplyOptions,
  ): SkillMaterializeResult;
  /** Rebuild the live roots from the DB; call only after the old container is gone. */
  apply(
    target: SkillTarget,
    xdgConfigHome: string,
    options: SkillApplyOptions,
  ): SkillMaterializeResult;
}
