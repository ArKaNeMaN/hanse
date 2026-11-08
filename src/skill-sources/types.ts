export type SkillSourceMode = "track" | "pinned";

export type SkillSourceState =
  | "never_synced"
  | "syncing"
  | "ready"
  | "degraded"
  | "error"
  | "disabled";

export interface SkillSourceConfig {
  buckets: string[];
  allowInsecureHttp: boolean;
}

export interface SkillSourceRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  endpoint: string;
  config: SkillSourceConfig;
  priority: number;
  enabled: boolean;
  mode: SkillSourceMode;
  syncIntervalSec: number;
  staleAfterSec: number;
  requestTimeoutMs: number;
  activeSnapshotId: string | null;
  pinnedSnapshotId: string | null;
  disabledAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  etag: string | null;
  revision: string | null;
  state: SkillSourceState;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SkillSourceView extends SkillSourceRow {
  tokenSet: boolean;
  skillCount: number;
  totalBytes: number;
  stale: boolean;
}

export interface SkillSourceInput {
  slug?: string;
  name?: string;
  endpoint?: string;
  config?: Partial<SkillSourceConfig>;
  priority?: number;
  enabled?: boolean;
  mode?: SkillSourceMode;
  syncIntervalSec?: number;
  staleAfterSec?: number;
  requestTimeoutMs?: number;
  token?: string | null;
}

export interface HubManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface HubManifestSkill {
  name: string;
  description: string;
  version: string | null;
  contentHash: string | null;
  files: HubManifestFile[];
}

export interface HubManifestBucket {
  slug: string;
  name: string;
  revision: string;
  skills: HubManifestSkill[];
}

export interface HubManifest {
  schemaVersion: 1;
  generatedAt: string;
  buckets: HubManifestBucket[];
}

export interface SnapshotSkill {
  bucket: string;
  name: string;
  description: string;
  version: string | null;
  contentHash: string | null;
  skillMdSha256: string;
  files: HubManifestFile[];
  state: "ok" | "quarantined";
  errorCode: string | null;
  errorMessage: string | null;
}

export interface SkillSnapshot {
  sourceId: string;
  snapshotId: string;
  revision: string;
  etag: string | null;
  manifestSha256: string;
  bucketSet: string[];
  skills: SnapshotSkill[];
  totalBytes: number;
}

export interface ExternalSkillRecord {
  sourceId: string;
  sourceSlug: string;
  sourceName: string;
  priority: number;
  bucket: string;
  snapshotId: string;
  revision: string;
  name: string;
  description: string;
  version: string | null;
  contentHash: string | null;
  skillMdSha256: string;
  files: HubManifestFile[];
}

export interface SkillSourceProvider {
  fetchManifest(input: { etag?: string | null }): Promise<ManifestFetchResult>;
  fetchFile(input: { bucket: string; name: string; path: string }): Promise<Uint8Array>;
}

export interface ManifestFetchResult {
  notModified: boolean;
  etag: string | null;
  manifest?: HubManifest;
}

export interface SyncResult {
  changed: boolean;
  snapshotId: string | null;
  revision: string | null;
  skillCount: number;
  totalBytes: number;
  state: SkillSourceState;
}

export interface CheckResult {
  changed: boolean;
  currentSnapshotId: string | null;
  nextSnapshotId: string;
  revision: string;
}

export class SkillSourceError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "SkillSourceError";
    this.code = code;
  }
}
