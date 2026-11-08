export type SkillScope = "global" | "project" | "app";

export interface SkillReference {
  /** Canonical stored path: references/<slug>.md. */
  path: string;
  /** Exact text written; CRLF/CR normalized to LF at input. */
  content: string;
}

/** One arbitrary local skill file. `content` is the exact materialized byte sequence. */
export interface SkillFile {
  path: string;
  content: Uint8Array;
  sha256: string;
  size: number;
  executable?: boolean;
}

/** API input for one local skill file: exactly one of `text` or `base64`. */
export interface SkillFileInput {
  path: string;
  text?: string;
  base64?: string;
  executable?: boolean;
}

/** API/detail projection of one local skill file. */
export interface SkillFileView {
  path: string;
  size: number;
  encoding: "utf8" | "binary";
  text?: string;
  base64?: string;
  executable?: boolean;
}

export type SkillMetadata = Record<string, string>;

export type SkillStoredIssue =
  | { code: "invalid_skill_name" }
  | { code: "invalid_skill_metadata"; detail: string }
  | { code: "invalid_skill_reference"; path: string; detail: string }
  | { code: "invalid_skill_file"; path: string; detail: string }
  | { code: "invalid_skill_bundle"; detail: string };

export interface SkillBundle {
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  references: SkillReference[];
  /** Arbitrary local files. Optional so pre-v24 fixtures/fakes remain valid. */
  files?: SkillFile[];
}

export type SkillRowOrigin = "local" | "forked";

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
  origin: SkillRowOrigin;
  forkedFromSourceId: string | null;
  forkedFromName: string | null;
  forkedFromRevision: string | null;
}

export type SkillBundleMode = "managed" | "external";

export interface ExternalOrigin {
  sourceId: string;
  sourceName: string;
  bucket: string;
  revision: string;
  snapshotId: string;
}

export interface EffectiveSkill {
  /** Managed row id; null for an external skill. */
  id: number | null;
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  /** Summary projection; contents are not loaded for the inventory. */
  references: SkillReferenceView[];
  /** Managed scope, or null for an external skill. */
  source: SkillScope | null;
  /** Wider managed scopes shadowed by this skill, wide to narrow. */
  shadows: SkillScope[];
  /** True when this managed winner hides a same-name external skill. */
  shadowedExternal: boolean;
  mode: SkillBundleMode;
  /** External provenance; null for managed skills. */
  origin: ExternalOrigin | null;
  /** Stable external identity `${sourceId}:${bucket}:${name}`; null for managed. */
  externalKey: string | null;
  /** Number of materialized files excluding the synthesized/verbatim SKILL.md. */
  fileCount: number;
  /** Timestamp of the winning stored row or snapshot publication. */
  updatedAt: string;
  updatedBy: string | null;
}

/** Internal bundle used by hash, probe, and apply. */
export interface EffectiveBundle extends Omit<EffectiveSkill, "references"> {
  references: SkillReference[];
  /** Authoritative for external bundles; managed bundles synthesize SKILL.md. */
  files?: SkillFile[];
}

/** One immutable external skill descriptor captured for a launch. */
export interface ExternalBundleDescriptor {
  sourceId: string;
  sourceName: string;
  bucket: string;
  revision: string;
  snapshotId: string;
  name: string;
  description: string;
  files: Array<{ path: string; sha256: string; size: number }>;
}

/** A frozen effective generation used for one application launch. */
export interface SkillCapture {
  hash: string | undefined;
  capturedAt: string;
  /** Full resolved view for the target: scope, winners, rows, tombstones, warnings. */
  resolved: ResolvedSkills;
  /** Managed winners with exact file bytes. */
  managed: EffectiveBundle[];
  /** External winners with snapshot ids and file digests. */
  external: ExternalBundleDescriptor[];
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
  /** Full replacement of the local file set; mutually exclusive with `references`. */
  files?: SkillFileInput[];
}

export interface SkillUpdate {
  description?: string;
  content?: string;
  enabled?: boolean;
  license?: string | null;
  compatibility?: string | null;
  /** Full replacement; `{}` clears. */
  metadata?: SkillMetadata;
  /** Partial replacement of the legacy reference projection; `[]` clears it. */
  references?: SkillReference[];
  /** Full replacement of the local file set; mutually exclusive with `references`. */
  files?: SkillFileInput[];
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
  origin: SkillRowOrigin;
  forkedFromSourceId: string | null;
  forkedFromName: string | null;
  forkedFromRevision: string | null;
}

export interface SkillDetail extends Omit<SkillSummary, "references"> {
  references: Array<SkillReferenceView & { content: string }>;
  files: SkillFileView[];
  /** Raw invalid metadata_json for repair, when present. */
  metadataRaw: string | null;
}

export type SkillWarningCode =
  | "skill_collision"
  | "skill_disabled_elsewhere"
  | "skill_source_conflict"
  | "skill_source_quarantined"
  | "skill_source_stale";

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
  /** Freeze the complete effective generation for one launch. */
  capture(target: SkillTarget): SkillCapture;
  resolve(target: SkillTarget, capture?: SkillCapture): ResolvedSkills;
  /** Read-only collision preview; never writes. */
  preview(target: SkillTarget, options: SkillApplyOptions, capture?: SkillCapture): SkillPreview;
  /** Effective enabled-set hash; `undefined` exactly when the effective set is empty. */
  hash(target: SkillTarget, capture?: SkillCapture): string | undefined;
  /** Validate and materialize into a private staging root; removes it before returning. */
  probe(
    target: SkillTarget,
    xdgConfigHome: string,
    options: SkillApplyOptions,
    capture?: SkillCapture,
  ): SkillMaterializeResult;
  /** Rebuild the live roots from the DB; call only after the old container is gone. */
  apply(
    target: SkillTarget,
    xdgConfigHome: string,
    options: SkillApplyOptions,
    capture?: SkillCapture,
  ): SkillMaterializeResult;
}
