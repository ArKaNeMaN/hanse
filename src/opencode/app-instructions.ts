import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveAppPath, resolveWithinRoot } from "../runtime/app-path.js";
import { safeParseProject } from "../schema/index.js";

export interface AppInstructionsInput {
  appDir: string;
  projectRoot: string;
  workspaceRoot: string;
  /** Contract path relative to the application directory. */
  contract: string;
}

export interface AppInstructionSources {
  /** Existing project-shared files, resolved and contained. */
  shared: string[];
  /** Existing app contract file, or `undefined` when it is missing or escapes the app. */
  contract?: string;
}

/** Resolve the instruction sources for one application; missing or escaping paths are skipped. */
export function resolveAppInstructionSources(input: AppInstructionsInput): AppInstructionSources {
  const shared: string[] = [];
  for (const source of projectSharedDocs(input.projectRoot)) {
    try {
      const resolved = resolveAppPath({
        appPath: source,
        projectRoot: input.projectRoot,
        workspaceRoot: input.workspaceRoot,
      });
      const file = existingFile(resolved);
      if (file !== undefined && !shared.includes(file)) {
        shared.push(file);
      }
    } catch {
      // Shared docs are best-effort; a broken path must not block app start.
    }
  }

  let contract: string | undefined;
  try {
    contract = existingFile(
      resolveWithinRoot({
        target: path.resolve(input.appDir, input.contract),
        root: input.appDir,
        label: "contract",
      }),
    );
  } catch {
    // The contract is best-effort; a broken path must not block app start.
  }

  return {
    shared: contract === undefined ? shared : shared.filter((file) => file !== contract),
    ...(contract === undefined ? {} : { contract }),
  };
}

function projectSharedDocs(projectRoot: string): string[] {
  try {
    const raw = readFileSync(path.join(projectRoot, ".hanse", "project.yaml"), "utf8");
    const parsed = safeParseProject(parseYaml(raw));
    return parsed.success ? (parsed.data.shared ?? []) : [];
  } catch {
    // An unreadable project manifest is ignored; the app row remains launchable.
    return [];
  }
}

function existingFile(candidate: string): string | undefined {
  try {
    return lstatSync(candidate).isFile() ? candidate : undefined;
  } catch {
    // Missing or unreadable files are skipped.
    return undefined;
  }
}
