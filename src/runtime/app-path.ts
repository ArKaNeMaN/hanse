import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { ConfigError } from "../config/load.js";

export interface ResolveAppPathInput {
  /** Path exactly as written in the manifest or stored in the database. */
  appPath: string;
  /** Project root (`.hanse/project.yaml` directory). Relative paths resolve against it. */
  projectRoot: string;
  /** Workspace root that absolute app paths must stay inside. */
  workspaceRoot: string;
}

/**
 * Resolve `appPath` to a canonical absolute path and prove it cannot leave its allowed root.
 *
 * Policy:
 * - Relative paths resolve against `projectRoot` and must stay inside it.
 * - Absolute paths must stay inside `workspaceRoot`.
 * - Any `..` segment is rejected, even when the path would resolve back inside.
 * - Existing paths use `realpath`; a non-existent target resolves the nearest existing ancestor
 *   with `realpath` and appends the remaining components, so a symlinked ancestor cannot escape.
 * - Containment uses `path.relative` so a string prefix match cannot be fooled.
 *
 * Throws {@link ConfigError}; there is deliberately no silent fallback.
 */
export function resolveAppPath(input: ResolveAppPathInput): string {
  const { appPath, projectRoot, workspaceRoot } = input;
  if (appPath.length === 0) {
    throw new ConfigError("INVALID_APP_PATH", "application path must not be empty", {
      path: appPath,
    });
  }
  if (hasParentSegment(appPath)) {
    throw new ConfigError(
      "INVALID_APP_PATH",
      `application path must not contain "..": ${appPath}`,
      { path: appPath },
    );
  }

  const absolute = path.isAbsolute(appPath);
  const allowedRoot = realpathWithMissingSegments(absolute ? workspaceRoot : projectRoot, appPath);
  const candidate = realpathWithMissingSegments(
    absolute ? appPath : path.resolve(projectRoot, appPath),
    appPath,
  );

  if (!isInside(allowedRoot, candidate)) {
    const label = absolute ? "workspace root" : "project root";
    throw new ConfigError(
      "PATH_OUTSIDE_ROOT",
      `application path escapes the ${label}: ${appPath}`,
      { path: appPath, issues: [`${candidate} is outside ${allowedRoot}`] },
    );
  }
  return candidate;
}

/** True when `target` is `root` or lies underneath it (after both have been resolved). */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export interface ResolveWithinRootInput {
  /** Absolute path to resolve and contain. */
  target: string;
  /** Absolute root the target must stay strictly inside. */
  root: string;
  /** Human-readable label used in errors (for example "appDir"). */
  label: string;
}

/**
 * Resolve an absolute `target` and prove it stays strictly inside `root`.
 *
 * This is the same containment discipline as {@link resolveAppPath}: reject `..` segments, resolve
 * symlinked ancestors through `realpath` (including for not-yet-created targets), and compare with
 * `path.relative` rather than string prefixes. Equality with the root is rejected so a caller can
 * never expose the whole root.
 */
export function resolveWithinRoot(input: ResolveWithinRootInput): string {
  const { target, root, label } = input;
  if (!path.isAbsolute(target)) {
    throw new ConfigError("INVALID_APP_PATH", `${label} must be absolute: ${target}`, {
      path: target,
    });
  }
  if (hasParentSegment(target)) {
    throw new ConfigError("INVALID_APP_PATH", `${label} must not contain "..": ${target}`, {
      path: target,
    });
  }
  const rootReal = realpathWithMissingSegments(root, target);
  const candidate = realpathWithMissingSegments(target, target);
  if (path.relative(rootReal, candidate) === "" || !isInside(rootReal, candidate)) {
    throw new ConfigError("PATH_OUTSIDE_ROOT", `${label} escapes its allowed root: ${target}`, {
      path: target,
      issues: [`${candidate} is not strictly inside ${rootReal}`],
    });
  }
  return candidate;
}

function hasParentSegment(appPath: string): boolean {
  return appPath.split(/[\\/]+/).some((segment) => segment === "..");
}

/**
 * `realpath` the nearest existing ancestor of `target` and append the components that do not exist
 * yet. This keeps containment meaningful for a target that has not been created (for example a new
 * app directory) without letting a symlinked ancestor redirect the result.
 */
function realpathWithMissingSegments(target: string, original: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw configError(error, original);
      }
      if (isSymlink(current)) {
        throw configError(error, original);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw configError(error, original);
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function configError(error: unknown, appPath: string): ConfigError {
  return new ConfigError("PATH_OUTSIDE_ROOT", `cannot resolve application path: ${appPath}`, {
    path: appPath,
    issues: [error instanceof Error ? error.message : String(error)],
  });
}
