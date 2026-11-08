import { parse as parseYaml } from "yaml";
import { hashValue } from "../settings/hash.js";
import type { SkillMetadata } from "../skills/types.js";
import {
  isSkillFilePath,
  isSkillName,
  SKILL_FILE_LIMITS,
  SkillValidationError,
} from "../skills/validation.js";
import {
  type HubManifest,
  type HubManifestBucket,
  type HubManifestFile,
  type HubManifestSkill,
  type SkillSourceConfig,
  SkillSourceError,
} from "./types.js";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BUCKETS = 32;

export function validateSourceSlug(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new SkillValidationError("slug must be 1-64 characters", "slug");
  }
  if (!SLUG_PATTERN.test(value)) {
    throw new SkillValidationError(
      "slug must be lowercase letters, digits, or single hyphens",
      "slug",
    );
  }
  return value;
}

export function validateSourceName(value: unknown): string {
  if (typeof value !== "string") {
    throw new SkillValidationError("name must be a string", "name");
  }
  const name = value.trim();
  if (name.length === 0 || name.length > 128) {
    throw new SkillValidationError("name must be 1-128 characters", "name");
  }
  return name;
}

export function validateEndpoint(value: unknown, config: SkillSourceConfig): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new SkillValidationError("endpoint must be 1-2048 characters", "endpoint");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SkillValidationError("endpoint must be an absolute URL", "endpoint");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SkillValidationError("endpoint must use http or https", "endpoint");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new SkillValidationError("endpoint must not contain userinfo", "endpoint");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new SkillValidationError("endpoint must not contain a query or fragment", "endpoint");
  }
  if (url.protocol === "http:" && !config.allowInsecureHttp) {
    throw new SkillValidationError("http endpoints require allowInsecureHttp", "allowInsecureHttp");
  }
  if (isLinkLocalHost(url.hostname)) {
    throw new SkillValidationError("endpoint must not target a link-local address", "endpoint");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function isLinkLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "169.254.169.254" || host === "metadata.google.internal" || host.startsWith("169.254.")
  );
}

export function validateSourceConfig(value: unknown): SkillSourceConfig {
  if (value === undefined || value === null) {
    return { buckets: [], allowInsecureHttp: false };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SkillValidationError("config must be an object", "config");
  }
  const record = value as Record<string, unknown>;
  const rawBuckets = record.buckets ?? [];
  if (!Array.isArray(rawBuckets)) {
    throw new SkillValidationError("config.buckets must be an array", "buckets");
  }
  if (rawBuckets.length > MAX_BUCKETS) {
    throw new SkillValidationError("config.buckets must have at most 32 entries", "buckets");
  }
  const buckets: string[] = [];
  for (const item of rawBuckets) {
    if (typeof item !== "string" || !SLUG_PATTERN.test(item) || item.length > 64) {
      throw new SkillValidationError("bucket slugs must be lowercase slug strings", "buckets");
    }
    if (!buckets.includes(item)) {
      buckets.push(item);
    }
  }
  if (record.allowInsecureHttp !== undefined && typeof record.allowInsecureHttp !== "boolean") {
    throw new SkillValidationError("config.allowInsecureHttp must be a boolean", "config");
  }
  return { buckets, allowInsecureHttp: record.allowInsecureHttp === true };
}

function integerInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new SkillValidationError(`${name} must be an integer between ${min} and ${max}`, name);
  }
  return value;
}

export interface NormalizedSourceInput {
  slug?: string;
  name?: string;
  endpoint?: string;
  config?: SkillSourceConfig;
  priority?: number;
  enabled?: boolean;
  mode?: "track" | "pinned";
  syncIntervalSec?: number;
  staleAfterSec?: number;
  requestTimeoutMs?: number;
  token?: string | null;
}

export function validateSourceInput(
  value: unknown,
  options: { partial: boolean },
): NormalizedSourceInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillValidationError("source body must be an object");
  }
  const record = value as Record<string, unknown>;
  const result: NormalizedSourceInput = {};
  const assign = <K extends keyof NormalizedSourceInput>(
    key: K,
    next: NormalizedSourceInput[K],
  ) => {
    if (next !== undefined) {
      result[key] = next;
    }
  };
  if (record.slug !== undefined || !options.partial) {
    assign("slug", validateSourceSlug(record.slug));
  }
  if (record.name !== undefined || !options.partial) {
    assign("name", validateSourceName(record.name));
  }
  const config =
    record.config === undefined && options.partial
      ? undefined
      : validateSourceConfig(record.config);
  if (record.endpoint !== undefined || !options.partial) {
    if (config === undefined) {
      throw new SkillValidationError("config is required with endpoint", "config");
    }
    assign("endpoint", validateEndpoint(record.endpoint, config));
  }
  assign("config", config);
  if (record.priority !== undefined) {
    assign("priority", integerInRange(record.priority, "priority", 0, 100000));
  }
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "boolean") {
      throw new SkillValidationError("enabled must be a boolean", "enabled");
    }
    assign("enabled", record.enabled);
  }
  if (record.mode !== undefined) {
    if (record.mode !== "track" && record.mode !== "pinned") {
      throw new SkillValidationError("mode must be track or pinned", "mode");
    }
    assign("mode", record.mode);
  }
  if (record.syncIntervalSec !== undefined) {
    assign(
      "syncIntervalSec",
      integerInRange(record.syncIntervalSec, "syncIntervalSec", 60, 604800),
    );
  }
  if (record.staleAfterSec !== undefined) {
    assign("staleAfterSec", integerInRange(record.staleAfterSec, "staleAfterSec", 60, 2592000));
  }
  if (record.requestTimeoutMs !== undefined) {
    assign(
      "requestTimeoutMs",
      integerInRange(record.requestTimeoutMs, "requestTimeoutMs", 1000, 120000),
    );
  }
  if (record.token !== undefined) {
    if (record.token !== null && typeof record.token !== "string") {
      throw new SkillValidationError("token must be a string or null", "token");
    }
    assign("token", record.token as string | null);
  }
  return result;
}

function manifestFile(value: unknown): HubManifestFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillSourceError("invalid_manifest", "manifest file must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string") {
    throw new SkillSourceError("invalid_manifest", "manifest file path must be a string");
  }
  if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) {
    throw new SkillSourceError("invalid_manifest", "manifest file sha256 is invalid");
  }
  if (
    typeof record.size !== "number" ||
    !Number.isInteger(record.size) ||
    record.size < 0 ||
    record.size > SKILL_FILE_LIMITS.fileBytes
  ) {
    throw new SkillSourceError("invalid_manifest", "manifest file size is invalid");
  }
  return { path: record.path, sha256: record.sha256, size: record.size };
}

function manifestSkill(value: unknown): HubManifestSkill {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillSourceError("invalid_manifest", "manifest skill must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.description !== "string") {
    throw new SkillSourceError("invalid_manifest", "manifest skill name/description is invalid");
  }
  if (!Array.isArray(record.files)) {
    throw new SkillSourceError("invalid_manifest", "manifest skill files must be an array");
  }
  if (
    record.version !== undefined &&
    record.version !== null &&
    typeof record.version !== "string"
  ) {
    throw new SkillSourceError("invalid_manifest", "manifest skill version is invalid");
  }
  if (
    record.contentHash !== undefined &&
    record.contentHash !== null &&
    typeof record.contentHash !== "string"
  ) {
    throw new SkillSourceError("invalid_manifest", "manifest skill contentHash is invalid");
  }
  return {
    name: record.name,
    description: record.description,
    version: (record.version as string | null | undefined) ?? null,
    contentHash: (record.contentHash as string | null | undefined) ?? null,
    files: record.files.map(manifestFile),
  };
}

function manifestBucket(value: unknown): HubManifestBucket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillSourceError("invalid_manifest", "manifest bucket must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.slug !== "string" ||
    typeof record.name !== "string" ||
    typeof record.revision !== "string" ||
    !Array.isArray(record.skills)
  ) {
    throw new SkillSourceError("invalid_manifest", "manifest bucket fields are invalid");
  }
  const skills = record.skills.map(manifestSkill);
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new SkillSourceError(
        "invalid_manifest",
        `manifest bucket ${record.slug} has duplicate skill ${skill.name}`,
      );
    }
    seen.add(skill.name);
  }
  return { slug: record.slug, name: record.name, revision: record.revision, skills };
}

export function parseHubManifest(value: unknown): HubManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillSourceError("invalid_manifest", "manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new SkillSourceError("unsupported_schema", "manifest schemaVersion must be 1");
  }
  if (typeof record.generatedAt !== "string") {
    throw new SkillSourceError("invalid_manifest", "manifest generatedAt is invalid");
  }
  if (!Array.isArray(record.buckets)) {
    throw new SkillSourceError("invalid_manifest", "manifest buckets must be an array");
  }
  const buckets = record.buckets.map(manifestBucket);
  const seen = new Set<string>();
  for (const bucket of buckets) {
    if (seen.has(bucket.slug)) {
      throw new SkillSourceError("invalid_manifest", `duplicate bucket ${bucket.slug}`);
    }
    seen.add(bucket.slug);
  }
  return { schemaVersion: 1, generatedAt: record.generatedAt, buckets };
}

export function canonicalManifestHash(manifest: HubManifest): string {
  const buckets = [...manifest.buckets]
    .sort((left, right) => (left.slug < right.slug ? -1 : 1))
    .map((bucket) => ({
      slug: bucket.slug,
      name: bucket.name,
      skills: [...bucket.skills]
        .sort((left, right) => (left.name < right.name ? -1 : 1))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          version: skill.version,
          files: [...skill.files]
            .sort((left, right) => (left.path < right.path ? -1 : 1))
            .map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
        })),
    }));
  return hashValue({ buckets });
}

export function snapshotIdFor(sourceId: string, manifestSha256: string): string {
  return hashValue({ sourceId, manifestSha256 });
}

export function validateSkillFilesForSource(
  name: string,
  files: readonly HubManifestFile[],
): { files: HubManifestFile[]; totalBytes: number; skillMd: HubManifestFile } {
  const seen = new Map<string, string>();
  let totalBytes = 0;
  let skillMd: HubManifestFile | undefined;
  for (const file of files) {
    if (!isSkillName(name)) {
      throw new SkillSourceError("invalid_skill_name", `invalid skill name ${name}`);
    }
    if (!isSkillFilePath(file.path, { allowSkillMd: true })) {
      throw new SkillSourceError("invalid_skill_file", `invalid file path ${file.path}`);
    }
    const key = file.path.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new SkillSourceError("invalid_skill_file", `duplicate file path ${file.path}`);
    }
    seen.set(key, file.path);
    if (file.path === "SKILL.md") {
      skillMd = file;
    }
    totalBytes += file.size;
  }
  if (skillMd === undefined) {
    throw new SkillSourceError("missing_skill_md", `skill ${name} is missing SKILL.md`);
  }
  if (totalBytes > SKILL_FILE_LIMITS.bundleBytes) {
    throw new SkillSourceError("invalid_skill_bundle", `skill ${name} exceeds 8 MiB`);
  }
  return { files: [...files], totalBytes, skillMd };
}

export interface ParsedSkillDocument {
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
}

export function parseSkillDocument(bytes: Uint8Array): ParsedSkillDocument {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new SkillSourceError("invalid_skill_md", "SKILL.md must start with frontmatter");
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1] ?? "");
  } catch {
    throw new SkillSourceError("invalid_skill_md", "SKILL.md frontmatter is invalid YAML");
  }
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new SkillSourceError("invalid_skill_md", "SKILL.md frontmatter must be an object");
  }
  const record = frontmatter as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (name.length === 0 || description.length === 0) {
    throw new SkillSourceError("invalid_skill_md", "SKILL.md name and description are required");
  }
  const metadata: SkillMetadata = {};
  if (record.metadata !== undefined) {
    if (
      typeof record.metadata !== "object" ||
      record.metadata === null ||
      Array.isArray(record.metadata)
    ) {
      throw new SkillSourceError("invalid_skill_md", "SKILL.md metadata must be an object");
    }
    for (const [key, value] of Object.entries(record.metadata as Record<string, unknown>)) {
      if (typeof value === "string") {
        metadata[key] = value;
      } else if (typeof value === "number" || typeof value === "boolean") {
        metadata[key] = String(value);
      }
    }
  }
  const body = match[2] ?? "";
  return {
    name,
    description,
    content: body.trim(),
    license: typeof record.license === "string" ? record.license : null,
    compatibility: typeof record.compatibility === "string" ? record.compatibility : null,
    metadata,
  };
}
