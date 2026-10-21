import {
  closeSync,
  type Dirent,
  constants as fsConstants,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { SkillApplyOptions, SkillWarning } from "./types.js";

const MAX_DEPTH = 4;
const MAX_ENTRIES = 2000;
const MAX_WARNINGS = 20;
const MAX_READ_BYTES = 16 * 1024;

export interface CollisionScanOptions {
  effectiveNames: readonly string[];
  disabledNames: readonly string[];
  /** The Hanse-owned config root, when known; its own skill roots are never scanned. */
  xdgConfigHome?: string;
  options: SkillApplyOptions;
}

export interface CollisionScanResult {
  warnings: SkillWarning[];
  truncated?: number;
}

interface FoundSkill {
  name: string;
  root: string;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function pluginSkillRoot(specifier: string): string | undefined {
  if (!specifier.startsWith("file://")) {
    return undefined;
  }
  try {
    return path.join(fileURLToPath(new URL(specifier)), "skills");
  } catch (error) {
    void error;
    return undefined;
  }
}

function collisionRoots(input: CollisionScanOptions): string[] {
  const hanseOwned = new Set<string>();
  if (input.xdgConfigHome !== undefined) {
    hanseOwned.add(path.resolve(path.join(input.xdgConfigHome, "opencode", "skill")));
    hanseOwned.add(path.resolve(path.join(input.xdgConfigHome, "opencode", "skills")));
  }
  const candidates = [
    path.join(input.options.appDir, ".opencode", "skill"),
    path.join(input.options.appDir, ".opencode", "skills"),
    path.join(input.options.home, ".claude", "skills"),
    path.join(input.options.home, ".agents", "skills"),
    path.join(input.options.xdgCacheHome, "opencode", "skills"),
    ...(input.options.baselinePlugins ?? [])
      .map(pluginSkillRoot)
      .filter((root): root is string => root !== undefined),
  ];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (hanseOwned.has(resolved) || seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

function readHead(file: string): string {
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const bytes = readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function frontmatterName(content: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (match === null) {
    return undefined;
  }
  try {
    const parsed = parseYaml(match[1] ?? "") as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const name = (parsed as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim().length > 0) {
      return name.trim();
    }
  } catch (error) {
    void error;
  }
  return undefined;
}

function skillNameAt(file: string, directory: string): string | undefined {
  try {
    const fromFile = frontmatterName(readHead(file));
    if (fromFile !== undefined) {
      return fromFile;
    }
  } catch (error) {
    if (!isEnoent(error)) {
      // An unreadable candidate is skipped; collision detection is best-effort.
      return undefined;
    }
  }
  const fallback = path.basename(directory);
  return fallback.length > 0 ? fallback : undefined;
}

function walk(
  directory: string,
  depth: number,
  budget: { entries: number },
  found: FoundSkill[],
  root: string,
): void {
  if (budget.entries >= MAX_ENTRIES) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    void error;
    return;
  }
  for (const entry of entries) {
    if (budget.entries >= MAX_ENTRIES) {
      return;
    }
    budget.entries += 1;
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) {
        walk(full, depth + 1, budget, found, root);
      }
      continue;
    }
    if (!entry.isFile() || entry.name !== "SKILL.md") {
      continue;
    }
    const name = skillNameAt(full, directory);
    if (name !== undefined) {
      found.push({ name, root });
    }
  }
}

function scanRoot(root: string, budget: { entries: number }, found: FoundSkill[]): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(root);
  } catch (error) {
    void error;
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return;
  }
  walk(root, 0, budget, found, root);
}

/**
 * Scan the non-managed skill roots for names that collide with Hanse names.
 * The search is bounded by depth and total entries, never follows symlinks, and
 * excludes the Hanse-owned config roots that `apply` rebuilds itself.
 */
export function scanCollisions(input: CollisionScanOptions): CollisionScanResult {
  const effective = new Set(input.effectiveNames);
  const disabled = new Set(input.disabledNames);
  const found: FoundSkill[] = [];
  const budget = { entries: 0 };
  for (const root of collisionRoots(input)) {
    if (budget.entries >= MAX_ENTRIES) {
      break;
    }
    scanRoot(root, budget, found);
  }

  const seen = new Set<string>();
  const warnings: SkillWarning[] = [];
  for (const item of found) {
    let code: "skill_collision" | "skill_disabled_elsewhere";
    if (effective.has(item.name)) {
      code = "skill_collision";
    } else if (disabled.has(item.name)) {
      code = "skill_disabled_elsewhere";
    } else {
      continue;
    }
    const key = `${code}\u0000${item.name}\u0000${item.root}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    warnings.push({ code, name: item.name, root: item.root });
  }
  warnings.sort(
    (left, right) =>
      compareStrings(left.name ?? "", right.name ?? "") ||
      compareStrings(left.root ?? "", right.root ?? "") ||
      compareStrings(left.code, right.code),
  );
  const truncated = warnings.length > MAX_WARNINGS ? warnings.length - MAX_WARNINGS : undefined;
  return {
    warnings: warnings.slice(0, MAX_WARNINGS),
    ...(truncated === undefined ? {} : { truncated }),
  };
}
