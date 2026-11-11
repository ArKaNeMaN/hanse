import { readFileSync } from "node:fs";
import type { RuntimeResources } from "../agent/spec.js";
import { hashValue } from "../settings/hash.js";
import type { WebPermissionOptions } from "./policy.js";

/**
 * One captured launch input set (design §5.3).
 *
 * The snapshot deliberately excludes the target image (the intended update) and per-request
 * identity such as the agent token and opencode password. Instruction entries are file **contents**,
 * not paths, so moving an unchanged contract does not look like a configuration change.
 */
export interface LaunchSnapshot {
  settings: {
    effective: unknown;
    providerKeys: unknown;
    authHash: string;
    gitAuthHash: string;
    policyVersion: number;
  } | null;
  profileHash: string | null;
  skillsHash: string | null;
  modelProvidersHash: string | null;
  ruleHash: string;
  appInstructions: string[];
  sharedInstructions: string[];
  baselinePlugins: string[];
  codegraphCommand: string[] | null;
  coordinatorCommand: string[];
  coordinatorMcp: {
    apiBase: string;
    tokenFile: string;
  };
  webOverlay: unknown | null;
  permission: {
    roots: string[];
    web: WebPermissionOptions;
    denyPatterns: string[];
  };
  resources: RuntimeResources;
  agentApiBase: string | null;
}

/** Stable SHA-256 of a launch snapshot; equal snapshots always produce equal fingerprints. */
export function launchFingerprint(snapshot: LaunchSnapshot): string {
  return hashValue(snapshot);
}

/** Read the contents of the given instruction sources; unreadable paths are skipped. */
export function readInstructionContents(sources: readonly string[] | undefined): string[] {
  if (sources === undefined) return [];
  const contents: string[] = [];
  for (const source of sources) {
    try {
      contents.push(readFileSync(source, "utf8"));
    } catch {
      // A missing or unreadable instruction source is skipped at launch; keep the snapshot stable.
    }
  }
  return contents;
}
