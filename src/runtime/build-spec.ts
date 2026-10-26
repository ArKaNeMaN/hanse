import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ConfigError } from "../config/load.js";
import { isInside } from "./app-path.js";
import type { BaseImageKind } from "./base-image.js";

/** Fallback image used when an app has no image build declaration. */
export const DEFAULT_AGENT_IMAGE_REFERENCE = "agent-default";

/** Current build-spec hash version. */
export const BUILD_SPEC_HASH_VERSION = 2;

export interface BuildSpecInput {
  /** Raw Dockerfile bytes; line endings and whitespace are part of the spec. */
  dockerfile: string | Uint8Array;
  /** Build arguments; order never affects the hash. */
  buildArgs?: Record<string, string>;
  /** Resolved base kind. The base reference/tag/digest is deliberately excluded. */
  baseKind: BaseImageKind;
}

export interface LegacyBuildSpecInput {
  /** Raw Dockerfile bytes. */
  dockerfile: string | Uint8Array;
  /** Historical default/base image reference (or `reference@digest`). */
  defaultImage: string;
  /** Build arguments; order never affects the hash. */
  buildArgs?: Record<string, string>;
}

/**
 * Stable SHA-256 (version 2) of the app image build spec.
 *
 * Only the Dockerfile bytes, the sorted build arguments, and the resolved base kind participate.
 * Base reference/tag/digest changes never alter this hash; base drift is compared separately by
 * manifest digest. Application source files are mounted at runtime and never change this hash.
 */
export function computeBuildSpecHash(input: BuildSpecInput): string {
  const hash = createHash("sha256");
  hash.update(`hanse-app-build-spec-v${BUILD_SPEC_HASH_VERSION}\n`);
  appendField(hash, "dockerfile", toBytes(input.dockerfile));
  appendField(hash, "base-kind", Buffer.from(input.baseKind, "utf8"));
  const args = Object.entries(input.buildArgs ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [key, value] of args) {
    appendField(hash, `build-arg:${key}`, Buffer.from(value, "utf8"));
  }
  return hash.digest("hex");
}

/**
 * Recompute a legacy version-1 hash for rows whose historical full reference is reconstructable.
 *
 * Never compare this value with a version-2 hash. Callers must resolve the legacy reference first
 * (see `legacyV1BaseReference`); a digest-only legacy value has no exact reconstruction.
 */
export function computeLegacyBuildSpecHashV1(input: LegacyBuildSpecInput): string {
  const hash = createHash("sha256");
  hash.update("hanse-app-build-spec-v1\n");
  appendField(hash, "dockerfile", toBytes(input.dockerfile));
  appendField(hash, "default-image", Buffer.from(input.defaultImage, "utf8"));
  const args = Object.entries(input.buildArgs ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [key, value] of args) {
    appendField(hash, `build-arg:${key}`, Buffer.from(value, "utf8"));
  }
  return hash.digest("hex");
}

/** Resolve the configured default agent image reference, including an optional digest. */
export function defaultImageReference(env: NodeJS.ProcessEnv = process.env): string {
  const reference = env.HANSE_AGENT_IMAGE?.trim() || DEFAULT_AGENT_IMAGE_REFERENCE;
  const digest = env.HANSE_AGENT_IMAGE_DIGEST?.trim();
  if (digest === undefined || digest.length === 0 || reference.includes("@")) {
    return reference;
  }
  return `${reference}@${digest}`;
}

export interface ResolveBuildDockerfileInput {
  /** Application directory; already contained by the workspace/app path checks. */
  appDir: string;
  /** Manifest `build.dockerfile` value, relative to {@link appDir}. */
  dockerfile: string;
}

export interface ResolvedBuildDockerfile {
  /** Canonical absolute path, proven to be a regular file inside the app directory. */
  path: string;
  content: Buffer;
}

/**
 * Resolve a manifest Dockerfile under its application directory and prove containment.
 *
 * Rejects empty/absolute paths, `..` segments, missing files, non-regular files, and symlinks whose
 * real target escapes the app directory. An internal symlink to a regular file inside the app is
 * allowed.
 */
export function resolveBuildDockerfile(
  input: ResolveBuildDockerfileInput,
): ResolvedBuildDockerfile {
  const { appDir, dockerfile } = input;
  if (dockerfile.length === 0 || dockerfile.includes("\0")) {
    throw new ConfigError("INVALID_APP_PATH", "build.dockerfile must be a non-empty path", {
      path: dockerfile,
    });
  }
  if (path.isAbsolute(dockerfile) || /^[A-Za-z]:[\\/]/.test(dockerfile)) {
    throw new ConfigError("INVALID_APP_PATH", "build.dockerfile must be relative to the app", {
      path: dockerfile,
    });
  }
  if (dockerfile.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new ConfigError(
      "INVALID_APP_PATH",
      `build.dockerfile must not contain "..": ${dockerfile}`,
      { path: dockerfile },
    );
  }

  const root = realpathOrThrow(appDir, "application directory");
  const candidate = path.resolve(root, dockerfile);
  const resolved = realpathOrThrow(candidate, `Dockerfile ${dockerfile}`);

  if (path.relative(root, resolved) === "" || !isInside(root, resolved)) {
    throw new ConfigError(
      "PATH_OUTSIDE_ROOT",
      `build.dockerfile escapes the application directory: ${dockerfile}`,
      { path: dockerfile, issues: [`${resolved} is outside ${root}`] },
    );
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch (error) {
    throw readError(error, `cannot inspect Dockerfile ${dockerfile}`);
  }
  if (!stat.isFile()) {
    throw new ConfigError(
      "VALIDATION_FAILED",
      `build.dockerfile is not a regular file: ${dockerfile}`,
      { path: dockerfile },
    );
  }

  try {
    return { path: resolved, content: readFileSync(resolved) };
  } catch (error) {
    throw readError(error, `cannot read Dockerfile ${dockerfile}`);
  }
}

/** Collapse an error into a single bounded line safe to persist and show in the UI. */
export function boundedErrorMessage(error: unknown, maxLength = 400): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = Array.from(raw, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const message = cleaned.length === 0 ? "unknown error" : cleaned;
  return message.length <= maxLength ? message : `${message.slice(0, maxLength - 3)}...`;
}

function appendField(hash: ReturnType<typeof createHash>, label: string, value: Buffer): void {
  const labelBytes = Buffer.from(label, "utf8");
  hash.update(`${labelBytes.length}:`);
  hash.update(labelBytes);
  hash.update(`${value.length}:`);
  hash.update(value);
}

function toBytes(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function realpathOrThrow(target: string, label: string): string {
  try {
    return realpathSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new ConfigError("NOT_FOUND", `${label} not found: ${target}`, { path: target });
    }
    throw readError(error, `cannot resolve ${label}: ${target}`);
  }
}

function readError(error: unknown, message: string): ConfigError {
  return new ConfigError("READ_FAILED", message, {
    issues: [error instanceof Error ? error.message : String(error)],
  });
}
