import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { type App, appSchema, type Project, projectSchema } from "../schema/index.js";

/** Marker directory present at both project and application roots. */
export const HANSE_DIR = ".hanse";
/** Project manifest filename inside {@link HANSE_DIR}. */
export const PROJECT_CONFIG_FILENAME = "project.yaml";
/** Application descriptor filename inside {@link HANSE_DIR}. */
export const APP_CONFIG_FILENAME = "app.yaml";

export type ConfigErrorCode = "NOT_FOUND" | "READ_FAILED" | "VALIDATION_FAILED";

/** Typed error thrown by config loading. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly path: string | undefined;
  readonly issues: readonly string[] | undefined;

  constructor(
    code: ConfigErrorCode,
    message: string,
    options: { path?: string; issues?: readonly string[] } = {},
  ) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.path = options.path;
    this.issues = options.issues;
  }
}

function findConfigFile(startDir: string, filename: string): string | undefined {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, HANSE_DIR, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function loadYamlFile(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new ConfigError("READ_FAILED", `Failed to read ${filePath}`, {
      path: filePath,
      issues: [error instanceof Error ? error.message : String(error)],
    });
  }
  try {
    return parseYaml(raw);
  } catch (error) {
    throw new ConfigError("VALIDATION_FAILED", `Invalid YAML in ${filePath}`, {
      path: filePath,
      issues: [error instanceof Error ? error.message : String(error)],
    });
  }
}

export interface LoadedProject {
  project: Project;
  filePath: string;
  rootPath: string;
}

/** Locate `.hanse/project.yaml` by walking up from {@link startDir}. */
export function locateProjectConfig(startDir: string): string | undefined {
  return findConfigFile(startDir, PROJECT_CONFIG_FILENAME);
}

/** Load and validate `.hanse/project.yaml`, searching upward from {@link startDir}. */
export async function loadProject(startDir: string): Promise<LoadedProject> {
  const filePath = findConfigFile(startDir, PROJECT_CONFIG_FILENAME);
  if (filePath === undefined) {
    throw new ConfigError(
      "NOT_FOUND",
      `No ${HANSE_DIR}/${PROJECT_CONFIG_FILENAME} found at or above ${path.resolve(startDir)}`,
    );
  }
  const data = await loadYamlFile(filePath);
  const result = projectSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError("VALIDATION_FAILED", `Invalid project manifest: ${filePath}`, {
      path: filePath,
      issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }
  return { project: result.data, filePath, rootPath: path.dirname(path.dirname(filePath)) };
}

/** Load and validate `.hanse/project.yaml`, returning only the project. */
export async function loadProjectConfig(startDir: string): Promise<Project> {
  return (await loadProject(startDir)).project;
}

/** Load and validate `.hanse/app.yaml`, searching upward from {@link startDir}. */
export async function loadAppConfig(startDir: string): Promise<App> {
  const filePath = findConfigFile(startDir, APP_CONFIG_FILENAME);
  if (filePath === undefined) {
    throw new ConfigError(
      "NOT_FOUND",
      `No ${HANSE_DIR}/${APP_CONFIG_FILENAME} found at or above ${path.resolve(startDir)}`,
    );
  }
  const data = await loadYamlFile(filePath);
  const result = appSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError("VALIDATION_FAILED", `Invalid app descriptor: ${filePath}`, {
      path: filePath,
      issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }
  return result.data;
}
