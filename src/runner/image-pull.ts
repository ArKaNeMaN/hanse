import {
  DockerError,
  type DockerImageInspect,
  type DockerPullOptions,
  type DockerPullResult,
} from "./docker.js";
import type { ImageUsageReport } from "./image-gc.js";
import type { ImageMutationMutex } from "./image-mutation.js";
import {
  ImageGate,
  ImageMutationConflictError,
  type ImageMutationLease,
} from "./image-mutation.js";
import { resolveImageDigest } from "./images.js";
import type { RunnerConfig } from "./validate.js";

const MAX_REFERENCE_LENGTH = 255;
const MAX_ERROR_CHARS = 300;
const DEFAULT_DISK_POLL_MS = 30_000;
const APP_IMAGE_PREFIX = "hanse-app-";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const REGISTRY_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REGISTRY_PORT = /^[0-9]{1,5}$/;
const REPOSITORY_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Typed pull failure; the route maps it directly and never echoes the Docker stream. */
export class ImagePullError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "ImagePullError";
    this.status = status;
    this.code = code;
  }
}

export interface ImagePullRuntime {
  inspectImage?(reference: string): Promise<DockerImageInspect | undefined>;
  pullImage?(reference: string, options?: DockerPullOptions): Promise<DockerPullResult>;
  removeImage?(reference: string): Promise<void>;
}

export interface ImagePullServiceOptions {
  config: RunnerConfig;
  docker: ImagePullRuntime;
  imageGc: { usage(): Promise<ImageUsageReport> };
  mutex: ImageMutationMutex;
  gate?: ImageGate;
  diskPollMs?: number;
}

export interface ImagePullResult {
  reference: string;
  previousImageId: string | null;
  imageId: string;
  changed: boolean;
  digest: string | null;
}

function invalid(message: string): ImagePullError {
  return new ImagePullError(400, message, "invalid_reference");
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isRegistryHost(value: string): boolean {
  return value === "localhost" || value.includes(".") || value.includes(":");
}

function validateRegistry(value: string): void {
  const colon = value.lastIndexOf(":");
  const host = colon >= 0 ? value.slice(0, colon) : value;
  const port = colon >= 0 ? value.slice(colon + 1) : undefined;
  if (host.length === 0) throw invalid("reference registry is empty");
  if (port !== undefined && !REGISTRY_PORT.test(port)) {
    throw invalid("reference registry port is malformed");
  }
  for (const label of host.split(".")) {
    if (!REGISTRY_LABEL.test(label)) throw invalid("reference registry is malformed");
  }
}

/** Validate the Docker reference grammar; the allowlist check is separate. */
export function validatePullReferenceSyntax(value: string): string {
  if (value.length === 0 || value.length > MAX_REFERENCE_LENGTH) {
    throw invalid("reference is empty or too long");
  }
  if (/\s/.test(value) || hasControlCharacters(value)) {
    throw invalid("reference contains whitespace or control characters");
  }
  const partsWithDigest = value.split("@");
  if (partsWithDigest.length > 2) {
    throw invalid("reference contains more than one digest separator");
  }
  let name = value;
  if (partsWithDigest.length === 2) {
    name = partsWithDigest[0] ?? "";
    const digest = partsWithDigest[1] ?? "";
    if (!DIGEST.test(digest)) {
      throw invalid("reference digest must be sha256:<64 lowercase hex>");
    }
  }
  if (name.length === 0) throw invalid("reference repository is empty");
  const parts = name.split("/");
  if (parts.some((part) => part.length === 0)) {
    throw invalid("reference contains an empty path component");
  }
  if (parts.length > 1) {
    const registry = parts[0] ?? "";
    if (isRegistryHost(registry)) {
      validateRegistry(registry);
      parts.shift();
    }
  }
  const last = parts[parts.length - 1] ?? "";
  const colon = last.lastIndexOf(":");
  let repositoryLast = last;
  if (colon >= 0) {
    const tag = last.slice(colon + 1);
    repositoryLast = last.slice(0, colon);
    if (tag.length === 0) throw invalid("reference has an empty tag");
    if (!TAG.test(tag)) throw invalid("reference tag is malformed");
    if (repositoryLast.length === 0) throw invalid("reference repository is empty");
  }
  parts[parts.length - 1] = repositoryLast;
  for (const part of parts) {
    if (!REPOSITORY_COMPONENT.test(part)) throw invalid("reference repository is malformed");
  }
  return value;
}

function isAllowedReference(reference: string, config: RunnerConfig): boolean {
  return (
    config.allowedImages.has(reference) ||
    reference === config.defaultImage ||
    reference === config.baseImage
  );
}

function isAppBuiltReference(reference: string): boolean {
  const name = reference.split("@")[0] ?? reference;
  const colon = name.lastIndexOf(":");
  const slash = name.lastIndexOf("/");
  const repository = colon > slash ? name.slice(0, colon) : name;
  return repository.startsWith(APP_IMAGE_PREFIX);
}

/** Read, validate, and allowlist one pull request body. */
export function validatePullReference(raw: unknown, config: RunnerConfig): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid('body must be {"reference": <string>}');
  }
  const reference = (raw as Record<string, unknown>).reference;
  if (typeof reference !== "string") throw invalid("reference must be a string");
  const normalized = validatePullReferenceSyntax(reference);
  if (!isAllowedReference(normalized, config)) {
    throw new ImagePullError(403, "image reference is not allowed", "image_disallowed");
  }
  if (isAppBuiltReference(normalized)) {
    throw new ImagePullError(403, "app-built images cannot be pulled", "image_disallowed");
  }
  return normalized;
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }
  return result;
}

function sanitizePullError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const stripped = stripControlCharacters(raw).trim();
  const bounded =
    stripped.length > MAX_ERROR_CHARS ? `${stripped.slice(0, MAX_ERROR_CHARS)}...` : stripped;
  return bounded.length === 0 ? "image pull failed" : bounded;
}

/** Serialized, fail-closed streaming pull of one exact-allowlisted reference. */
export class ImagePullService {
  readonly #config: RunnerConfig;
  readonly #docker: ImagePullRuntime;
  readonly #imageGc: { usage(): Promise<ImageUsageReport> };
  readonly #mutex: ImageMutationMutex;
  readonly #gate: ImageGate;
  readonly #diskPollMs: number;

  constructor(options: ImagePullServiceOptions) {
    this.#config = options.config;
    this.#docker = options.docker;
    this.#imageGc = options.imageGc;
    this.#mutex = options.mutex;
    this.#gate = options.gate ?? new ImageGate();
    this.#diskPollMs = options.diskPollMs ?? DEFAULT_DISK_POLL_MS;
  }

  async pull(raw: unknown, options: { signal?: AbortSignal } = {}): Promise<ImagePullResult> {
    const reference = validatePullReference(raw, this.#config);

    let gateLease: ImageMutationLease;
    try {
      gateLease = this.#gate.tryShared("pull");
    } catch (error) {
      if (error instanceof ImageMutationConflictError) {
        throw new ImagePullError(error.status, error.message, error.code);
      }
      throw error;
    }
    let lease: ImageMutationLease;
    try {
      lease = this.#mutex.tryAcquire("pull");
    } catch (error) {
      gateLease.release();
      if (error instanceof ImageMutationConflictError) {
        throw new ImagePullError(error.status, error.message, error.code);
      }
      throw error;
    }
    try {
      const precheck = await this.#diskGuard(false);
      if (precheck !== null) throw precheck;

      const pullImage = this.#docker.pullImage?.bind(this.#docker);
      if (pullImage === undefined) {
        throw new ImagePullError(501, "image pulls are not supported", "pull_unavailable");
      }
      const inspectImage = this.#docker.inspectImage?.bind(this.#docker);
      const previousImageId =
        inspectImage === undefined
          ? null
          : ((await inspectImage(reference).catch(() => undefined))?.Id ?? null);

      const guardController = new AbortController();
      const signal =
        options.signal === undefined
          ? guardController.signal
          : AbortSignal.any([options.signal, guardController.signal]);
      let guardFailure: ImagePullError | null = null;
      let checking = false;
      const timer = setInterval(() => {
        if (checking || signal.aborted) return;
        checking = true;
        void this.#diskGuard(true)
          .then((failure) => {
            if (failure !== null) {
              guardFailure = failure;
              guardController.abort();
            }
          })
          .catch(() => {
            guardFailure = new ImagePullError(
              507,
              "image disk guard is unavailable",
              "disk_guard_unavailable",
            );
            guardController.abort();
          })
          .finally(() => {
            checking = false;
          });
      }, this.#diskPollMs);
      timer.unref();

      let pulled: DockerPullResult;
      try {
        pulled = await pullImage(reference, {
          signal,
          ...(this.#config.pullMaxBytes === undefined
            ? {}
            : { maxBytes: this.#config.pullMaxBytes }),
        });
      } catch (error) {
        if (guardFailure !== null) throw guardFailure;
        if (error instanceof DockerError && error.status === 507) {
          await this.#removeAfterPull(reference);
          throw new ImagePullError(
            507,
            "image pull exceeded the configured pull budget",
            "pull_over_budget",
          );
        }
        if (options.signal?.aborted === true) {
          throw new ImagePullError(502, "image pull was aborted", "pull_failed");
        }
        throw new ImagePullError(502, sanitizePullError(error), "pull_failed");
      } finally {
        clearInterval(timer);
      }

      let imageId = pulled.imageId;
      let digest = pulled.digest;
      const needsInspect =
        imageId === null || digest === null || this.#config.pullMaxBytes !== undefined;
      const inspected =
        !needsInspect || inspectImage === undefined
          ? undefined
          : await inspectImage(reference).catch(() => undefined);
      if (imageId === null) {
        imageId =
          typeof inspected?.Id === "string" && inspected.Id.length > 0 ? inspected.Id : null;
      }
      if (digest === null) digest = resolveImageDigest(reference, inspected?.RepoDigests);
      if (imageId === null) {
        throw new ImagePullError(502, "image pull completed without an image id", "pull_failed");
      }

      const pullMaxBytes = this.#config.pullMaxBytes;
      if (pullMaxBytes !== undefined) {
        const size = inspected?.Size;
        if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
          await this.#removeAfterPull(reference);
          throw new ImagePullError(507, "pulled image size is unavailable", "pull_size_unknown");
        }
        if (size > pullMaxBytes) {
          await this.#removeAfterPull(reference);
          throw new ImagePullError(
            507,
            "pulled image exceeds the runner pull budget",
            "pull_over_budget",
          );
        }
      }

      const diskFailure = await this.#diskGuard(true);
      if (diskFailure !== null) {
        if (diskFailure.code === "disk_critical") {
          await this.#removeAfterPull(reference);
        }
        throw diskFailure;
      }
      return {
        reference,
        previousImageId,
        imageId,
        changed: previousImageId !== imageId,
        digest,
      };
    } finally {
      lease.release();
      gateLease.release();
    }
  }

  async #removeAfterPull(reference: string): Promise<void> {
    const removeImage = this.#docker.removeImage?.bind(this.#docker);
    if (removeImage === undefined) return;
    try {
      await removeImage(reference);
    } catch {
      // Best effort: the pull still fails with the typed 507 and never echoes the Docker body.
    }
  }

  async #diskGuard(duringPull: boolean): Promise<ImagePullError | null> {
    let usage: ImageUsageReport;
    try {
      usage = await this.#imageGc.usage();
    } catch {
      return new ImagePullError(507, "image disk guard is unavailable", "disk_guard_unavailable");
    }
    if (usage.disk === null) {
      return new ImagePullError(507, "image disk guard is unavailable", "disk_guard_unavailable");
    }
    if (duringPull) {
      return usage.level === "critical"
        ? new ImagePullError(507, "image disk is critically full", "disk_critical")
        : null;
    }
    if (usage.level === "warning" || usage.level === "critical") {
      return new ImagePullError(507, "image disk is above the pull threshold", "disk_critical");
    }
    return null;
  }
}
