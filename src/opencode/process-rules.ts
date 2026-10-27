import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IsolatedEnv } from "./instance.js";

/** Version of the persistent agent process-safety instruction. */
export const PROCESS_RULES_VERSION = 1;

/**
 * Persistent English instruction injected into every managed instance.
 *
 * It is a guardrail, not a sandbox: wrappers, scripts, and app-owned config can bypass it. The
 * content is deliberately constant so its hash can participate in the launch/settings hash.
 */
export const PROCESS_RULE_TEXT = `# Agent process safety

- Never signal or kill the opencode server/PID 1 or its process group.
- Do not use \`pkill\`/\`killall\`/\`kill\`/\`kill -9\` against opencode, even to "test" it.
- To inspect opencode, use a separate instance with a temporary \`HOME\`/\`XDG_*\` and a free port, or read-only \`opencode --version\`/\`opencode debug\` commands. Kill only the recorded PID of that throwaway instance, never by process name.
- If the server appears stuck, report it to the operator instead of self-terminating.
`;

/** Stable lowercase hex SHA-256 of {@link PROCESS_RULE_TEXT}. */
export const PROCESS_RULE_HASH = hashFileContent(PROCESS_RULE_TEXT);

/** Instance environment needed to locate the process-rule files. */
export type ProcessRuleEnv = Pick<IsolatedEnv, "XDG_STATE_HOME">;

/** Absolute path of the active process-rule file for one instance. */
export function processRulePath(env: ProcessRuleEnv): string {
  return path.join(env.XDG_STATE_HOME, "hanse", "agent-process-rules.md");
}

/** Absolute path of the applied sidecar (the content trusted by the last explicit start). */
export function processRuleAppliedPath(env: ProcessRuleEnv): string {
  return path.join(env.XDG_STATE_HOME, "hanse", "agent-process-rules.applied.md");
}

/** SHA-256 of arbitrary text as stable lowercase hex. */
export function hashFileContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Atomically write the active rule file (temp file, mode 0600, rename). */
export function writeProcessRule(env: ProcessRuleEnv, content: string): void {
  atomicWrite(processRulePath(env), content);
}

/** Atomically write the applied sidecar (temp file, mode 0600, rename). */
export function writeAppliedRule(env: ProcessRuleEnv, content: string): void {
  atomicWrite(processRuleAppliedPath(env), content);
}

/** Read the active rule file, or `undefined` when it does not exist. */
export function readProcessRule(env: ProcessRuleEnv): string | undefined {
  return readIfPresent(processRulePath(env));
}

/** Read the applied sidecar, or `undefined` when it does not exist. */
export function readAppliedRule(env: ProcessRuleEnv): string | undefined {
  return readIfPresent(processRuleAppliedPath(env));
}

function readIfPresent(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Outcome of restoring the applied sidecar into the active rule file. */
export type RestoreAppliedRuleResult =
  | { restored: true }
  | {
      restored: false;
      reason: "missing_applied_hash" | "missing_sidecar" | "hash_mismatch";
    };

/**
 * Restore the applied sidecar into the active rule file when it is the trusted applied copy.
 *
 * The sidecar is trusted only when its content hash equals `appliedHash`. On a mismatch or a
 * missing sidecar nothing is written; the caller restores the current code rule and keeps the
 * applied hashes unchanged so the app remains "Restart required".
 */
export function restoreAppliedRule(
  env: ProcessRuleEnv,
  appliedHash: string | null,
): RestoreAppliedRuleResult {
  if (appliedHash === null) return { restored: false, reason: "missing_applied_hash" };
  const applied = readAppliedRule(env);
  if (applied === undefined) return { restored: false, reason: "missing_sidecar" };
  if (hashFileContent(applied) !== appliedHash) {
    return { restored: false, reason: "hash_mismatch" };
  }
  writeProcessRule(env, applied);
  return { restored: true };
}
