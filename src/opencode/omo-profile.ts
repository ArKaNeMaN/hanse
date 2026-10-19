import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashValue, sha256Hex } from "../settings/hash.js";

/** Agents pinned by the OMO 5.1.35 baseline; the profile must carry a model for each. */
export const PINNED_AGENTS = [
  "sisyphus",
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "prometheus",
  "metis",
  "momus",
  "atlas",
  "sisyphus-junior",
] as const;

/** Categories pinned by the OMO 5.1.35 baseline; the profile must carry a model for each. */
export const PINNED_CATEGORIES = [
  "visual-engineering",
  "artistry",
  "ultrabrain",
  "deep-low",
  "deep-high",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
] as const;

export interface OmoProfileInput {
  appId: string;
  model: string;
  disableWebsearch: boolean;
}

export interface OmoProfileResult {
  name?: string;
  applied: boolean;
  contentHash: string;
  warning?: string;
}

export interface OmoProfileStoreOptions {
  /** Config file to rewrite. Production defaults to `<home>/.omo/omo.jsonc`. */
  path?: string;
  pinnedAgents?: string[];
  pinnedCategories?: string[];
}

interface ProfileBuild {
  profile: Record<string, unknown>;
  warning?: string;
}

interface ReadBase {
  base?: Record<string, unknown>;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profileName(appId: string): string {
  return `hanse-app-${sha256Hex(appId).slice(0, 16)}`;
}

function withModel(value: unknown, pinned: string[], model: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  if (isRecord(value)) {
    for (const [name, entry] of Object.entries(value)) {
      entries[name] = isRecord(entry) ? { ...entry, model } : { model };
    }
  }
  for (const name of pinned) {
    if (!(name in entries)) {
      entries[name] = { model };
    }
  }
  return entries;
}

function disabledMcps(
  value: unknown,
  disableWebsearch: boolean,
): { list: string[]; warning?: string } {
  const list = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  if (disableWebsearch) {
    if (!list.includes("websearch")) {
      list.push("websearch");
    }
    return { list };
  }
  if (list.includes("websearch")) {
    return {
      list,
      warning:
        "omo_profile_websearch_disabled: the base OMO config disables the websearch MCP; built-in search cannot be re-enabled by the profile",
    };
  }
  return { list };
}

function buildProfile(
  base: Record<string, unknown>,
  input: OmoProfileInput,
  pinnedAgents: string[],
  pinnedCategories: string[],
): ProfileBuild {
  const opencode = isRecord(base["[opencode]"]) ? base["[opencode]"] : {};
  const disabled = disabledMcps(opencode.disabled_mcps, input.disableWebsearch);
  const profile = {
    "[opencode]": {
      ...opencode,
      disabled_mcps: disabled.list,
      agents: withModel(opencode.agents, pinnedAgents, input.model),
      categories: withModel(opencode.categories, pinnedCategories, input.model),
    },
  };
  return disabled.warning === undefined ? { profile } : { profile, warning: disabled.warning };
}

function withProfile(
  base: Record<string, unknown>,
  name: string,
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const profiles = isRecord(base.profiles) ? base.profiles : {};
  return { ...base, profiles: { ...profiles, [name]: profile } };
}

function readBase(file: string): ReadBase {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return { error: "config root must be a JSON object" };
    }
    return { base: parsed };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown read error" };
  }
}

function atomicWrite(file: string, value: unknown): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Per-app OMO profile generator.
 *
 * Writes are serialized by an instance-local promise chain so concurrent `ensure` calls cannot lose
 * each other's read-modify-write updates. Failures degrade to `applied: false` plus a warning.
 */
export class OmoProfileStore {
  readonly #path: string;
  readonly #pinnedAgents: string[];
  readonly #pinnedCategories: string[];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: OmoProfileStoreOptions = {}) {
    this.#path = options.path ?? path.join(os.homedir(), ".omo", "omo.jsonc");
    this.#pinnedAgents = options.pinnedAgents ?? [...PINNED_AGENTS];
    this.#pinnedCategories = options.pinnedCategories ?? [...PINNED_CATEGORIES];
  }

  preview(input: OmoProfileInput): OmoProfileResult {
    return this.#compute(input, false);
  }

  ensure(input: OmoProfileInput): Promise<OmoProfileResult> {
    const result = this.#queue.then(
      () => this.#compute(input, true),
      () => this.#compute(input, true),
    );
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #compute(input: OmoProfileInput, write: boolean): OmoProfileResult {
    const name = profileName(input.appId);
    const read = readBase(this.#path);
    if (read.base === undefined) {
      const fallback = buildProfile({}, input, this.#pinnedAgents, this.#pinnedCategories);
      return {
        name,
        applied: false,
        contentHash: hashValue(fallback.profile),
        warning: `omo_profile_unavailable: ${read.error ?? "cannot read base config"}`,
      };
    }
    const built = buildProfile(read.base, input, this.#pinnedAgents, this.#pinnedCategories);
    const contentHash = hashValue(built.profile);
    if (!write) {
      return {
        name,
        applied: true,
        contentHash,
        ...(built.warning === undefined ? {} : { warning: built.warning }),
      };
    }
    try {
      atomicWrite(this.#path, withProfile(read.base, name, built.profile));
      return {
        name,
        applied: true,
        contentHash,
        ...(built.warning === undefined ? {} : { warning: built.warning }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown write error";
      const warning = `omo_profile_write_failed: ${message}`;
      return {
        name,
        applied: false,
        contentHash,
        warning: built.warning === undefined ? warning : `${warning}; ${built.warning}`,
      };
    }
  }
}
