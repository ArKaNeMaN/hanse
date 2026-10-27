import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstanceEnv } from "../src/opencode/instance.js";
import {
  hashFileContent,
  PROCESS_RULE_HASH,
  PROCESS_RULE_TEXT,
  PROCESS_RULES_VERSION,
  processRuleAppliedPath,
  processRulePath,
  readAppliedRule,
  readProcessRule,
  restoreAppliedRule,
  writeAppliedRule,
  writeProcessRule,
} from "../src/opencode/process-rules.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function envFor(root: string) {
  return resolveInstanceEnv(root, { projectId: "p", app: "web" });
}

describe("process rule content", () => {
  it("keeps the safety instruction and its hash stable", () => {
    expect(PROCESS_RULES_VERSION).toBe(1);
    expect(PROCESS_RULE_TEXT).toContain("Never signal or kill the opencode server/PID 1");
    expect(PROCESS_RULE_TEXT).toContain("Do not use `pkill`/`killall`/`kill`/`kill -9`");
    expect(PROCESS_RULE_TEXT).toContain("temporary `HOME`/`XDG_*` and a free port");
    expect(PROCESS_RULE_TEXT).toContain("report it to the operator");
    expect(PROCESS_RULE_HASH).toBe(
      createHash("sha256").update(PROCESS_RULE_TEXT, "utf8").digest("hex"),
    );
    expect(PROCESS_RULE_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes text deterministically", () => {
    expect(hashFileContent("same")).toBe(hashFileContent("same"));
    expect(hashFileContent("same")).not.toBe(hashFileContent("different"));
  });

  it("places both files under the per-instance XDG state root", () => {
    const env = envFor("/rt");
    expect(processRulePath(env)).toBe("/rt/p/web/state/hanse/agent-process-rules.md");
    expect(processRuleAppliedPath(env)).toBe(
      "/rt/p/web/state/hanse/agent-process-rules.applied.md",
    );
    expect(processRuleAppliedPath(env)).not.toBe(processRulePath(env));
  });
});

describe("process rule files", () => {
  it("writes the active file atomically with mode 0600 and no temp remnants", () => {
    const env = envFor(tempDir("hanse-rules-"));
    writeProcessRule(env, "first");
    expect(readProcessRule(env)).toBe("first");
    expect(statSync(processRulePath(env)).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(processRulePath(env)))).toEqual(["agent-process-rules.md"]);

    writeProcessRule(env, "second");
    expect(readProcessRule(env)).toBe("second");
    expect(readdirSync(path.dirname(processRulePath(env)))).toEqual(["agent-process-rules.md"]);
  });

  it("returns undefined for a missing active or applied file", () => {
    const env = envFor(tempDir("hanse-rules-"));
    expect(readProcessRule(env)).toBeUndefined();
    expect(readAppliedRule(env)).toBeUndefined();
  });

  it("writes the applied sidecar with mode 0600", () => {
    const env = envFor(tempDir("hanse-rules-"));
    writeAppliedRule(env, "applied");
    expect(readAppliedRule(env)).toBe("applied");
    expect(statSync(processRuleAppliedPath(env)).mode & 0o777).toBe(0o600);
  });

  it("restores a trusted applied sidecar into the active file", () => {
    const env = envFor(tempDir("hanse-rules-"));
    const previous = "previous applied rule";
    writeAppliedRule(env, previous);
    writeProcessRule(env, "new code rule");

    const result = restoreAppliedRule(env, hashFileContent(previous));

    expect(result).toEqual({ restored: true });
    expect(readProcessRule(env)).toBe(previous);
    expect(readAppliedRule(env)).toBe(previous);
  });

  it("does not restore a sidecar whose hash does not match", () => {
    const env = envFor(tempDir("hanse-rules-"));
    writeAppliedRule(env, "tampered");
    writeProcessRule(env, "current code rule");

    const result = restoreAppliedRule(env, PROCESS_RULE_HASH);

    expect(result).toEqual({ restored: false, reason: "hash_mismatch" });
    expect(readProcessRule(env)).toBe("current code rule");
    expect(readAppliedRule(env)).toBe("tampered");
  });

  it("reports a missing sidecar or applied hash without writing", () => {
    const env = envFor(tempDir("hanse-rules-"));
    writeProcessRule(env, "current code rule");

    expect(restoreAppliedRule(env, PROCESS_RULE_HASH)).toEqual({
      restored: false,
      reason: "missing_sidecar",
    });
    expect(restoreAppliedRule(env, null)).toEqual({
      restored: false,
      reason: "missing_applied_hash",
    });
    expect(readProcessRule(env)).toBe("current code rule");
  });

  it("never writes into the application repository", () => {
    const runtimeRoot = tempDir("hanse-rules-root-");
    const appDir = tempDir("hanse-rules-app-");
    const env = envFor(runtimeRoot);

    writeAppliedRule(env, PROCESS_RULE_TEXT);
    writeProcessRule(env, PROCESS_RULE_TEXT);

    expect(readdirSync(appDir)).toEqual([]);
    expect(path.relative(appDir, processRulePath(env)).startsWith("..")).toBe(true);
    expect(readFileSync(processRulePath(env), "utf8")).toBe(PROCESS_RULE_TEXT);
  });
});
