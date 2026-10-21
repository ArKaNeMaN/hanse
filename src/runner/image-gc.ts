import { statfs } from "node:fs/promises";
import {
  type DockerContainerSummary,
  DockerError,
  type DockerImageUsage,
  type DockerRuntime,
  type DockerSystemDf,
} from "./docker.js";
import { appContainerName } from "./names.js";

export const DISK_WARNING_PERCENT = 75;
export const DISK_CRITICAL_PERCENT = 85;

const MAX_PROTECTED_REFS = 512;
const MAX_REFERENCE_LENGTH = 255;
const MAX_GC_IMAGES = 200;
const MAX_REPORT_ENTRIES = 100;
const DEFAULT_GC_TIMEOUT_MS = 60_000;
const MANAGED_IMAGE_PREFIX = "hanse-app-";
const MANAGED_IMAGE_LABEL = "hanse.app.id";
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/;

export type DiskUsageLevel = "ok" | "warning" | "critical";

export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  level: DiskUsageLevel;
}

export interface DockerUsage {
  imageCount: number;
  imageBytes: number;
  buildCacheCount: number;
  buildCacheBytes: number;
  buildCacheInUseBytes: number;
  layersBytes: number;
}

export interface ImageUsageReport {
  level: DiskUsageLevel;
  disk: DiskUsage | null;
  docker: DockerUsage | null;
  errors: string[];
  generatedAt: string;
}

export interface ImageGcSkipped {
  ref: string;
  reason: "protected" | "shared_tag" | "limit" | "timeout";
}

export interface ImageGcReport {
  ok: true;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  protectedRefCount: number;
  removedImageCount: number;
  removedImageIds: string[];
  removedRefs: string[];
  estimatedReclaimedBytes: number;
  buildCachePruned: boolean;
  buildCacheReclaimedBytes: number;
  skipped: ImageGcSkipped[];
  truncated: boolean;
}

export class ImageGcError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "ImageGcError";
    this.status = status;
    this.code = code;
  }
}

export interface DiskStat {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
}

export interface ImageGcServiceOptions {
  docker: DockerRuntime;
  diskPath: string;
  statfs?: (path: string) => Promise<DiskStat>;
  timeoutMs?: number;
  now?: () => number;
}

export function usageLevel(usedPercent: number): DiskUsageLevel {
  if (usedPercent >= DISK_CRITICAL_PERCENT) return "critical";
  if (usedPercent >= DISK_WARNING_PERCENT) return "warning";
  return "ok";
}

export class ImageGcService {
  readonly #docker: DockerRuntime;
  readonly #diskPath: string;
  readonly #statfs: (path: string) => Promise<DiskStat>;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #running = false;

  constructor(options: ImageGcServiceOptions) {
    this.#docker = options.docker;
    this.#diskPath = options.diskPath;
    this.#statfs = options.statfs ?? ((path) => statfs(path));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_GC_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  async usage(): Promise<ImageUsageReport> {
    const errors: string[] = [];
    let disk: DiskUsage | null = null;
    try {
      disk = diskUsage(await this.#statfs(this.#diskPath));
    } catch (error) {
      errors.push(`workspace filesystem usage unavailable: ${safeErrorMessage(error)}`);
    }

    let docker: DockerUsage | null = null;
    if (this.#docker.systemDf === undefined) {
      errors.push("docker system df is not supported");
    } else {
      try {
        docker = dockerUsage(await this.#docker.systemDf());
      } catch (error) {
        errors.push(`docker usage unavailable: ${safeErrorMessage(error)}`);
      }
    }

    return {
      level: disk?.level ?? "ok",
      disk,
      docker,
      errors,
      generatedAt: new Date().toISOString(),
    };
  }

  async gc(raw: unknown): Promise<ImageGcReport> {
    if (this.#running) {
      throw new ImageGcError(409, "image gc is already running", "gc_in_progress");
    }
    this.#running = true;
    try {
      return await this.#runGc(raw);
    } finally {
      this.#running = false;
    }
  }

  async #runGc(raw: unknown): Promise<ImageGcReport> {
    const protectedRefs = parseProtectedRefs(raw);
    const systemDf = this.#docker.systemDf?.bind(this.#docker);
    const removeImage = this.#docker.removeImage?.bind(this.#docker);
    if (systemDf === undefined || removeImage === undefined) {
      throw new ImageGcError(501, "docker image gc is not supported", "gc_unavailable");
    }

    const startedMs = this.#now();
    const deadline = startedMs + this.#timeoutMs;
    const startedAt = new Date(startedMs).toISOString();
    let df: DockerSystemDf;
    try {
      df = await systemDf();
    } catch (error) {
      throw new ImageGcError(
        502,
        `docker image inventory failed: ${safeErrorMessage(error)}`,
        "docker_error",
      );
    }

    const protectedSet = new Set(protectedRefs);
    const protectedIds = new Set<string>();
    let containers: DockerContainerSummary[];
    try {
      containers = await this.#docker.listContainers();
    } catch (error) {
      throw new ImageGcError(
        502,
        `docker container inventory failed: ${safeErrorMessage(error)}`,
        "docker_error",
      );
    }
    for (const container of containers) {
      if (typeof container.Image === "string" && container.Image.length > 0) {
        protectedSet.add(container.Image);
      }
      if (typeof container.ImageID === "string" && container.ImageID.length > 0) {
        protectedIds.add(container.ImageID);
      }
    }

    const candidates = (df.Images ?? [])
      .filter(isManagedImage)
      .sort(
        (left, right) =>
          (left.Created ?? 0) - (right.Created ?? 0) || left.Id.localeCompare(right.Id),
      );

    const report: ImageGcReport = {
      ok: true,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      protectedRefCount: protectedRefs.length,
      removedImageCount: 0,
      removedImageIds: [],
      removedRefs: [],
      estimatedReclaimedBytes: 0,
      buildCachePruned: false,
      buildCacheReclaimedBytes: 0,
      skipped: [],
      truncated: false,
    };

    let attempted = 0;
    for (const image of candidates) {
      const tags = imageTags(image);
      const label = imageLabel(image, tags);
      const reference = tags[0] ?? image.Id;
      if (attempted >= MAX_GC_IMAGES || this.#now() >= deadline) {
        report.truncated = true;
        addSkipped(report, reference, attempted >= MAX_GC_IMAGES ? "limit" : "timeout");
        break;
      }
      if (
        protectedIds.has(image.Id) ||
        protectedSet.has(image.Id) ||
        tags.some((tag) => protectedSet.has(tag))
      ) {
        addSkipped(report, reference, "protected");
        continue;
      }
      if (tags.some((tag) => !tag.startsWith(MANAGED_IMAGE_PREFIX))) {
        addSkipped(report, reference, "shared_tag");
        continue;
      }
      if (tags.length === 0 && label === undefined) {
        continue;
      }

      attempted += 1;
      const removeTargets = tags.length === 0 ? [image.Id] : tags;
      try {
        for (const target of removeTargets) {
          await removeImage(target);
        }
      } catch (error) {
        throw new ImageGcError(
          502,
          `docker image removal failed for ${reference}: ${safeErrorMessage(error)}`,
          "docker_error",
        );
      }
      report.removedImageCount += 1;
      report.removedImageIds.push(image.Id);
      report.removedRefs.push(...(tags.length === 0 ? [image.Id] : tags));
      report.estimatedReclaimedBytes += image.Size ?? 0;
    }

    const pruneBuildCache = this.#docker.pruneBuildCache?.bind(this.#docker);
    if (pruneBuildCache !== undefined && this.#now() < deadline) {
      try {
        const pruned = await pruneBuildCache({ all: false });
        report.buildCachePruned = true;
        report.buildCacheReclaimedBytes = pruned.SpaceReclaimed ?? 0;
      } catch (error) {
        throw new ImageGcError(
          502,
          `docker build cache prune failed: ${safeErrorMessage(error)}`,
          "docker_error",
        );
      }
    } else if (pruneBuildCache !== undefined) {
      report.truncated = true;
    }

    const finishedMs = this.#now();
    report.finishedAt = new Date(finishedMs).toISOString();
    report.durationMs = Math.max(0, finishedMs - startedMs);
    boundReport(report);
    return report;
  }

  async purgeApp(appId: string): Promise<ImageGcReport> {
    if (this.#running) {
      throw new ImageGcError(409, "image gc is already running", "gc_in_progress");
    }
    this.#running = true;
    try {
      return await this.#runPurge(appId);
    } finally {
      this.#running = false;
    }
  }

  async #runPurge(appId: string): Promise<ImageGcReport> {
    const systemDf = this.#docker.systemDf?.bind(this.#docker);
    const removeImage = this.#docker.removeImage?.bind(this.#docker);
    if (systemDf === undefined || removeImage === undefined) {
      throw new ImageGcError(501, "docker image gc is not supported", "gc_unavailable");
    }

    const startedMs = this.#now();
    const deadline = startedMs + this.#timeoutMs;
    const startedAt = new Date(startedMs).toISOString();
    let df: DockerSystemDf;
    try {
      df = await systemDf();
    } catch (error) {
      throw new ImageGcError(
        502,
        `docker image inventory failed: ${safeErrorMessage(error)}`,
        "docker_error",
      );
    }

    let containers: DockerContainerSummary[];
    try {
      containers = await this.#docker.listContainers();
    } catch (error) {
      throw new ImageGcError(
        502,
        `docker container inventory failed: ${safeErrorMessage(error)}`,
        "docker_error",
      );
    }

    const protectedTags = new Set<string>();
    const protectedIds = new Set<string>();
    for (const container of containers) {
      if (typeof container.Image === "string" && container.Image.length > 0) {
        protectedTags.add(container.Image);
      }
      if (typeof container.ImageID === "string" && container.ImageID.length > 0) {
        protectedIds.add(container.ImageID);
      }
    }

    const tagPrefix = `${appContainerName(appId)}:`;
    const candidates = (df.Images ?? [])
      .filter((image) => image.Labels?.[MANAGED_IMAGE_LABEL] === appId)
      .sort(
        (left, right) =>
          (left.Created ?? 0) - (right.Created ?? 0) || left.Id.localeCompare(right.Id),
      );

    const report: ImageGcReport = {
      ok: true,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      protectedRefCount: protectedTags.size + protectedIds.size,
      removedImageCount: 0,
      removedImageIds: [],
      removedRefs: [],
      estimatedReclaimedBytes: 0,
      buildCachePruned: false,
      buildCacheReclaimedBytes: 0,
      skipped: [],
      truncated: false,
    };

    let attempted = 0;
    for (const image of candidates) {
      const tags = imageTags(image);
      const reference = tags[0] ?? image.Id;
      if (attempted >= MAX_GC_IMAGES || this.#now() >= deadline) {
        report.truncated = true;
        addSkipped(report, reference, attempted >= MAX_GC_IMAGES ? "limit" : "timeout");
        break;
      }
      if (
        protectedIds.has(image.Id) ||
        protectedTags.has(image.Id) ||
        tags.some((tag) => protectedTags.has(tag))
      ) {
        addSkipped(report, reference, "protected");
        continue;
      }
      if (tags.some((tag) => !tag.startsWith(tagPrefix))) {
        addSkipped(report, reference, "shared_tag");
        continue;
      }

      attempted += 1;
      const removeTargets = tags.length === 0 ? [image.Id] : tags;
      try {
        for (const target of removeTargets) {
          await removeImage(target);
        }
      } catch (error) {
        if (error instanceof DockerError && error.status === 409) {
          addSkipped(report, reference, "protected");
          continue;
        }
        throw new ImageGcError(
          502,
          `docker image removal failed for ${reference}: ${safeErrorMessage(error)}`,
          "docker_error",
        );
      }
      report.removedImageCount += 1;
      report.removedImageIds.push(image.Id);
      report.removedRefs.push(...(tags.length === 0 ? [image.Id] : tags));
      report.estimatedReclaimedBytes += image.Size ?? 0;
    }

    const finishedMs = this.#now();
    report.finishedAt = new Date(finishedMs).toISOString();
    report.durationMs = Math.max(0, finishedMs - startedMs);
    boundReport(report);
    return report;
  }
}

function diskUsage(stats: DiskStat): DiskUsage {
  const blockSize = Number.isFinite(stats.bsize) && stats.bsize > 0 ? stats.bsize : 0;
  const totalBlocks = Number.isFinite(stats.blocks) && stats.blocks > 0 ? stats.blocks : 0;
  const freeBlocks = Number.isFinite(stats.bavail) && stats.bavail > 0 ? stats.bavail : 0;
  const totalBytes = totalBlocks * blockSize;
  const freeBytes = Math.min(freeBlocks, totalBlocks) * blockSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const rawPercent = totalBytes === 0 ? 0 : (usedBytes / totalBytes) * 100;
  const usedPercent = Math.min(100, Math.max(0, Math.round(rawPercent * 10) / 10));
  return { totalBytes, usedBytes, freeBytes, usedPercent, level: usageLevel(usedPercent) };
}

function dockerUsage(df: DockerSystemDf): DockerUsage {
  const images = df.Images ?? [];
  const cache = df.BuildCache ?? [];
  let imageBytes = 0;
  for (const image of images) imageBytes += image.Size ?? 0;
  let buildCacheBytes = 0;
  let buildCacheInUseBytes = 0;
  for (const entry of cache) {
    const size = entry.Size ?? 0;
    buildCacheBytes += size;
    if (entry.InUse === true) buildCacheInUseBytes += size;
  }
  return {
    imageCount: images.length,
    imageBytes,
    buildCacheCount: cache.length,
    buildCacheBytes,
    buildCacheInUseBytes,
    layersBytes: df.LayersSize ?? 0,
  };
}

function parseProtectedRefs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ImageGcError(400, 'body must be {"protectedRefs": [...]}', "invalid_input");
  }
  const value = (raw as Record<string, unknown>).protectedRefs;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ImageGcError(400, "protectedRefs must be an array", "invalid_input");
  }
  if (value.length > MAX_PROTECTED_REFS) {
    throw new ImageGcError(
      400,
      `protectedRefs must contain at most ${MAX_PROTECTED_REFS} references`,
      "invalid_input",
    );
  }
  const refs: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isSafeReference(entry)) {
      throw new ImageGcError(
        400,
        "protectedRefs contains an invalid image reference",
        "invalid_input",
      );
    }
    if (!refs.includes(entry)) refs.push(entry);
  }
  return refs;
}

function isSafeReference(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REFERENCE_LENGTH && IMAGE_REFERENCE.test(value);
}

function isManagedImage(image: DockerImageUsage): boolean {
  const tags = imageTags(image);
  if (tags.some((tag) => tag.startsWith(MANAGED_IMAGE_PREFIX))) return true;
  return imageLabel(image, tags) !== undefined;
}

function imageTags(image: DockerImageUsage): string[] {
  return (image.RepoTags ?? []).filter(
    (tag): tag is string => typeof tag === "string" && tag.length > 0 && tag !== "<none>:<none>",
  );
}

function imageLabel(image: DockerImageUsage, tags: string[]): string | undefined {
  const value = image.Labels?.[MANAGED_IMAGE_LABEL];
  if (typeof value === "string" && value.length > 0) return value;
  const prefixed = tags.find((tag) => tag.startsWith(MANAGED_IMAGE_PREFIX));
  return prefixed === undefined ? undefined : prefixed.slice(MANAGED_IMAGE_PREFIX.length);
}

function addSkipped(report: ImageGcReport, ref: string, reason: ImageGcSkipped["reason"]): void {
  if (report.skipped.length >= MAX_REPORT_ENTRIES) {
    report.truncated = true;
    return;
  }
  report.skipped.push({ ref, reason });
}

function boundReport(report: ImageGcReport): void {
  if (report.removedImageIds.length > MAX_REPORT_ENTRIES) {
    report.removedImageIds = report.removedImageIds.slice(0, MAX_REPORT_ENTRIES);
    report.truncated = true;
  }
  if (report.removedRefs.length > MAX_REPORT_ENTRIES) {
    report.removedRefs = report.removedRefs.slice(0, MAX_REPORT_ENTRIES);
    report.truncated = true;
  }
  if (report.skipped.length > MAX_REPORT_ENTRIES) {
    report.skipped = report.skipped.slice(0, MAX_REPORT_ENTRIES);
    report.truncated = true;
  }
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = Array.from(raw, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\t") return " ";
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "" : character;
  }).join("");
  return cleaned.trim().slice(0, 300) || "unknown error";
}
