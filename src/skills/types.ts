export type SkillScope = "global" | "project" | "app";

export interface SkillReference {
  /** Canonical stored path: references/<slug>.md. */
  path: string;
  /** Exact text written; CRLF/CR normalized to LF at input. */
  content: string;
}

export type SkillMetadata = Record<string, string>;

export type SkillStoredIssue =
  | { code: "invalid_skill_name" }
  | { code: "invalid_skill_metadata"; detail: string }
  | { code: "invalid_skill_reference"; path: string; detail: string }
  | { code: "invalid_skill_bundle"; detail: string };

export interface SkillBundle {
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  references: SkillReference[];
}

export interface SkillRow extends SkillBundle {
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
  storedIssues: SkillStoredIssue[];
  /** Raw invalid metadata_json, when parsing failed; null otherwise. */
  metadataRaw: string | null;
}

export interface EffectiveSkill {
  id: number;
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  /** Summary projection; contents are not loaded for the inventory. */
  references: SkillReferenceView[];
  source: SkillScope;
  /** Wider scopes shadowed by this skill, wide to narrow. */
  shadows: SkillScope[];
  /** Timestamp of the winning stored row. */
  updatedAt: string;
  updatedBy: string | null;
}

/** Internal bundle used by hash, probe, and apply. */
export interface EffectiveBundle extends Omit<EffectiveSkill, "references"> {
  references: SkillReference[];
}

export interface SkillInput {
  name?: string;
  description: string;
  content: string;
  enabled?: boolean;
  license?: string | null;
  compatibility?: string | null;
  metadata?: SkillMetadata;
  references?: SkillReference[];
}

export interface SkillUpdate {
  description?: string;
  content?: string;
  enabled?: boolean;
  license?: string | null;
  compatibility?: string | null;
  /** Full replacement; `{}` clears. */
  metadata?: SkillMetadata;
  /** Full replacement; `[]` clears. */
  references?: SkillReference[];
}

export interface SkillReferenceView {
  path: string;
  /** UTF-8 byte size of the stored content. */
  size: number;
}

export interface SkillSummary {
  id: number;
  scope: SkillScope;
  projectId: string;
  appKey: string;
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  references: SkillReferenceView[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  storedIssues: SkillStoredIssue[];
}

export interface SkillDetail extends Omit<SkillSummary, "references"> {
  references: Array<SkillReferenceView & { content: string }>;
  /** Raw invalid metadata_json for repair, when present. */
  metadataRaw: string | null;
}

export type SkillWarningCode = "skill_collision" | "skill_disabled_elsewhere";

export interface SkillWarning {
  code: SkillWarningCode;
  name?: string;
  root?: string;
}

export interface ResolvedSkills {
  scope: SkillScope;
  effective: EffectiveSkill[];
  rows: SkillSummary[];
  /** Names hidden by a tombstone at this scope; `id` is the tombstone row. */
  disabled: Array<{ id: number; name: string; source: SkillScope | null; disabledBy: SkillScope }>;
  warnings: SkillWarning[];
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
