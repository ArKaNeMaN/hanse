/**
 * Client mirror of the skill-source API shapes.
 *
 * The source registry is global and human-only. These types intentionally carry no secret value:
 * `tokenSet` and `tokenUpdatedAt` are metadata, and the write-only token is only ever sent in a
 * mutation body. Keeping the mirror in `ui/` avoids importing server code into the Vite bundle.
 */

export type SkillSourceKind = string;
export type SkillSourceMode = "track" | "pinned";
export type SkillSourceState =
  | "never_synced"
  | "syncing"
  | "ready"
  | "degraded"
  | "error"
  | "disabled";

export interface SkillSourceConfig {
  readonly buckets: readonly string[];
  readonly allowInsecureHttp: boolean;
}

export interface SkillSourceView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: SkillSourceKind;
  readonly endpoint: string;
  readonly config: SkillSourceConfig;
  readonly priority: number;
  readonly enabled: boolean;
  readonly mode: SkillSourceMode;
  readonly syncIntervalSec: number;
  readonly staleAfterSec: number;
  readonly requestTimeoutMs: number;
  readonly activeSnapshotId: string | null;
  readonly pinnedSnapshotId: string | null;
  readonly disabledAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly etag: string | null;
  readonly revision: string | null;
  readonly state: SkillSourceState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  readonly tokenSet: boolean;
  readonly tokenUpdatedAt: string | null;
  readonly skillCount: number;
  readonly totalBytes: number;
  readonly stale: boolean;
}

export interface SkillSourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface SnapshotSkill {
  readonly bucket: string;
  readonly name: string;
  readonly description: string;
  readonly version: string | null;
  readonly contentHash: string | null;
  readonly skillMdSha256: string;
  readonly files: readonly SkillSourceFile[];
  readonly state: "ok" | "quarantined";
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface SkillSourceSkillsResponse {
  readonly source: SkillSourceView;
  readonly skills: readonly SnapshotSkill[];
}

export interface SyncResult {
  readonly changed: boolean;
  readonly snapshotId: string | null;
  readonly revision: string | null;
  readonly skillCount: number;
  readonly totalBytes: number;
  readonly state: SkillSourceState;
}

export interface CheckResult {
  readonly changed: boolean;
  readonly currentSnapshotId: string | null;
  readonly nextSnapshotId: string;
  readonly revision: string;
}

export interface SourceFilePreview {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly encoding: "text" | "binary";
  readonly text?: string;
}

export interface SkillSourcesResponse {
  readonly sources: readonly SkillSourceView[];
}

export interface SkillSourceDialogPayload {
  readonly name: string;
  readonly slug: string;
  readonly endpoint: string;
  readonly buckets: readonly string[];
  readonly allowInsecureHttp: boolean;
  readonly token: string | null;
  readonly priority: number;
  readonly syncIntervalSec: number;
  readonly staleAfterSec: number;
  readonly requestTimeoutMs: number;
}

export type SkillSourceAction =
  | "sync"
  | "check"
  | "pin"
  | "unpin"
  | "disable"
  | "enable"
  | "edit"
  | "delete"
  | "replace-token"
  | "clear-token";
