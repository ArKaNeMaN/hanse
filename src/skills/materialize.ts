import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { EffectiveBundle, SkillMetadata } from "./types.js";
import { isSkillName, isSkillReferencePath, validateSkillReferenceContent } from "./validation.js";

const MAX_ERROR_DETAIL = 500;

export interface RebuildOptions {
  /** Isolated application root that every written path must stay inside. */
  appRoot: string;
  /** Hanse-owned opencode root (`.../opencode` or the probe staging root). */
  opencodeRoot: string;
  effective: readonly EffectiveBundle[];
  /** Move pre-existing entries to `skills-replaced/` when the marker is absent. */
  preserveFirstDeploy: boolean;
}

export interface RebuildResult {
  written: string[];
  removed: string[];
  preserved: string[];
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * Assert that a path resolves inside `root` without creating anything. The
 * nearest existing ancestor is resolved through symlinks first, so a symlinked
 * intermediate directory cannot smuggle the target outside the root.
 */
export function assertInsideRoot(root: string, target: string): void {
  const rootReal = realpathSync(root);
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      const resolved = path.resolve(real, ...tail);
      if (!isInside(rootReal, resolved)) {
        throw new Error(`path escapes application root: ${target}`);
      }
      return;
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`cannot resolve path: ${target}`);
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Replace a symlink/non-directory at `dir` with a real directory inside the root. */
function ensureRealDirectory(rootReal: string, dir: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
  if (stat !== undefined && (!stat.isDirectory() || stat.isSymbolicLink())) {
    rmSync(dir, { recursive: true, force: true });
    stat = undefined;
  }
  if (stat === undefined) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  const real = realpathSync(dir);
  if (!isInside(rootReal, real)) {
    throw new Error(`refusing to use skills root outside the application root: ${dir}`);
  }
}

/**
 * Remove one path without following symlinks. A directory subtree is removed
 * recursively but the containing root is verified first; a symlink or file is
 * unlinked as that entry only.
 */
function removeEntry(appRootReal: string, target: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const real = realpathSync(target);
    if (!isInside(appRootReal, real)) {
      throw new Error(`refusing to remove path outside the application root: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
    return true;
  }
  unlinkSync(target);
  return true;
}

function relativePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function writeAtomic(file: string, content: string): void {
  const tmp = path.join(
    path.dirname(file),
    `.hanse-skill-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(
    tmp,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    writeSync(fd, content, null, "utf8");
    fchmodSync(fd, 0o644);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

const KNOWN_METADATA_KEYS = [
  "author",
  "version",
  "domain",
  "triggers",
  "role",
  "scope",
  "output-format",
  "related-skills",
] as const;

const SAFE_METADATA_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function metadataKey(key: string): string {
  return SAFE_METADATA_KEY.test(key) ? key : yamlScalar(key);
}

function orderedMetadataKeys(metadata: SkillMetadata): string[] {
  const known = new Set<string>(KNOWN_METADATA_KEYS);
  const keys = KNOWN_METADATA_KEYS.filter((key) => {
    const value = metadata[key];
    return value !== undefined && value.trim().length > 0;
  });
  const custom = Object.keys(metadata)
    .filter((key) => !known.has(key) && metadata[key]?.trim().length)
    .sort(compareStrings);
  return [...keys, ...custom];
}

/** Deterministic `SKILL.md` document for one effective skill. */
export function buildSkillDocument(skill: {
  name: string;
  description: string;
  content: string;
  license?: string | null;
  compatibility?: string | null;
  metadata?: SkillMetadata;
}): string {
  const lines = ["---", `name: ${skill.name}`, `description: ${yamlScalar(skill.description)}`];
  const license = skill.license?.trim() ?? "";
  if (license.length > 0) {
    lines.push(`license: ${yamlScalar(license)}`);
  }
  const compatibility = skill.compatibility?.trim() ?? "";
  if (compatibility.length > 0) {
    lines.push(`compatibility: ${yamlScalar(compatibility)}`);
  }
  const metadata = skill.metadata ?? {};
  const keys = orderedMetadataKeys(metadata);
  if (keys.length > 0) {
    lines.push("metadata:");
    for (const key of keys) {
      const value = metadata[key]?.trim() ?? "";
      lines.push(`  ${metadataKey(key)}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---", "", `${skill.content}\n`);
  return lines.join("\n");
}

/**
 * Rebuild both Hanse-owned skill roots from the effective set.
 *
 * `opencodeRoot` is the live `<XDG_CONFIG_HOME>/opencode` directory for `apply`
 * and the private staging root for `probe`, so both paths share this exact
 * algorithm. All entries not in the effective set are removed; on a first apply
 * they are moved to `skills-replaced/` instead.
 */
export function rebuildSkills(options: RebuildOptions): RebuildResult {
  const appRootReal = realpathSync(options.appRoot);
  ensureRealDirectory(appRootReal, options.opencodeRoot);
  const skillsRoot = path.join(options.opencodeRoot, "skills");
  const skillRoot = path.join(options.opencodeRoot, "skill");
  ensureRealDirectory(appRootReal, skillsRoot);
  ensureRealDirectory(appRootReal, skillRoot);

  for (const skill of options.effective) {
    if (!isSkillName(skill.name)) {
      throw new Error(
        `skills_materialize_failed: invalid skill name ${JSON.stringify(skill.name)}`,
      );
    }
    for (const reference of skill.references) {
      if (!isSkillReferencePath(reference.path)) {
        throw new Error(
          `skills_materialize_failed: invalid reference path ${JSON.stringify(reference.path)}`,
        );
      }
      try {
        validateSkillReferenceContent(reference.content);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`skills_materialize_failed: ${detail}`);
      }
    }
  }

  const effectiveNames = new Set(options.effective.map((skill) => skill.name));
  const marker = path.join(options.opencodeRoot, ".hanse-skills-initialized");
  const firstDeploy = options.preserveFirstDeploy && !existsAt(marker);

  const preserved = new Set<string>();
  const removed: string[] = [];
  const written: string[] = [];

  const handleUnexpected = (root: string, name: string): void => {
    const source = path.join(root, name);
    if (firstDeploy) {
      const replacedRoot = path.join(options.opencodeRoot, "skills-replaced");
      ensureRealDirectory(appRootReal, replacedRoot);
      const destination = path.join(replacedRoot, name);
      removeEntry(appRootReal, destination);
      renameSync(source, destination);
      preserved.add(name);
      return;
    }
    if (removeEntry(appRootReal, source)) {
      removed.push(relativePath(options.opencodeRoot, source));
    }
  };

  // The legacy `skill/` alias is always emptied.
  for (const name of listTopLevel(skillRoot)) {
    handleUnexpected(skillRoot, name);
  }
  for (const name of listTopLevel(skillsRoot)) {
    if (!effectiveNames.has(name)) {
      handleUnexpected(skillsRoot, name);
    }
  }

  if (firstDeploy) {
    writeAtomic(marker, "");
  }

  for (const skill of [...options.effective].sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const directory = path.join(skillsRoot, skill.name);
    removeEntry(appRootReal, directory);
    ensureRealDirectory(appRootReal, directory);
    const references = [...skill.references].sort((left, right) =>
      compareStrings(left.path, right.path),
    );
    if (references.length > 0) {
      ensureRealDirectory(appRootReal, path.join(directory, "references"));
    }
    for (const reference of references) {
      const segments = reference.path.split("/");
      const file = path.resolve(directory, ...segments);
      if (!isInside(directory, file)) {
        throw new Error(
          `skills_materialize_failed: reference path escapes the skill directory ${JSON.stringify(reference.path)}`,
        );
      }
      writeAtomic(file, reference.content ?? "");
      written.push(path.posix.join("skills", skill.name, reference.path));
    }
    // SKILL.md is written last so a crash mid-bundle is not discoverable.
    const file = path.join(directory, "SKILL.md");
    writeAtomic(file, buildSkillDocument(skill));
    written.push(path.posix.join("skills", skill.name, "SKILL.md"));
  }

  return {
    written: written.sort(compareStrings),
    removed: removed.sort(compareStrings),
    preserved: [...preserved].sort(compareStrings),
  };
}

function existsAt(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function listTopLevel(root: string): string[] {
  return readdirSync(root).sort(compareStrings);
}

/** Convert an I/O or safety failure into the bounded materialization error. */
export function materializeFailure(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith("skills_materialize_failed")) {
    return error instanceof Error ? error : new Error(raw);
  }
  const detail = raw.length > MAX_ERROR_DETAIL ? `${raw.slice(0, MAX_ERROR_DETAIL)}...` : raw;
  return new Error(`skills_materialize_failed: ${detail}`);
}
