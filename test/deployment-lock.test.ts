import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeploymentInProgressError,
  DeploymentLock,
  deploymentLockPath,
} from "../src/coordinator/deployment-lock.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-deploy-lock-"));
  dirs.push(dir);
  return dir;
}

const NOW = Date.parse("2026-10-22T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function validLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: "lock-1",
    phase: "switching",
    startedAt: iso(-60_000),
    updatedAt: iso(0),
    expiresAt: iso(2 * 60 * 60 * 1000),
    ...overrides,
  };
}

function writeLock(file: string, value: unknown): void {
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function lockAt(file: string, now = NOW): DeploymentLock {
  return new DeploymentLock(file, { now: () => now });
}

describe("deploymentLockPath", () => {
  it("defaults to the coordinator state directory", () => {
    expect(deploymentLockPath("/state", {})).toBe(path.join("/state", "hanse", "deploy.lock"));
  });

  it("honors an absolute override and rejects a relative one", () => {
    expect(deploymentLockPath("/state", { HANSE_DEPLOY_LOCK_FILE: "/run/hanse/deploy.lock" })).toBe(
      "/run/hanse/deploy.lock",
    );
    expect(() => deploymentLockPath("/state", { HANSE_DEPLOY_LOCK_FILE: "relative.lock" })).toThrow(
      /absolute/,
    );
  });
});

describe("DeploymentLock", () => {
  it("treats a missing file as inactive", () => {
    const file = path.join(tempDir(), "deploy.lock");
    expect(lockAt(file).status()).toEqual({ active: false, reason: "missing" });
    expect(lockAt(file).isActive()).toBe(false);
  });

  it("treats a valid current lock as active and exposes the phase", () => {
    const file = path.join(tempDir(), "deploy.lock");
    writeLock(file, validLock());
    const lock = lockAt(file);
    expect(lock.status()).toMatchObject({
      active: true,
      state: { id: "lock-1", phase: "switching", version: 1 },
    });
    expect(lock.isActive()).toBe(true);
    expect(() => lock.assertUnlocked("restart")).toThrowError(DeploymentInProgressError);
    try {
      lock.assertUnlocked("restart");
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        code: "deployment_in_progress",
        operation: "restart",
        phase: "switching",
      });
    }
  });

  it("accepts and logs an unknown phase", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const file = path.join(tempDir(), "deploy.lock");
    writeLock(file, validLock({ phase: "future_phase" }));
    expect(lockAt(file).isActive()).toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("future_phase"));
  });

  it("treats a stale heartbeat as inactive", () => {
    const file = path.join(tempDir(), "deploy.lock");
    writeLock(file, validLock());
    expect(lockAt(file, NOW + 4 * 60 * 1000 + 59_999).isActive()).toBe(true);
    expect(lockAt(file, NOW + 5 * 60 * 1000 + 1).status()).toEqual({
      active: false,
      reason: "stale",
    });
  });

  it("treats a passed expiresAt as inactive", () => {
    const file = path.join(tempDir(), "deploy.lock");
    writeLock(file, validLock({ updatedAt: iso(0), expiresAt: iso(1000) }));
    expect(lockAt(file, NOW + 1001).isActive()).toBe(false);
  });

  it("clamps expiresAt to two hours after the last heartbeat", () => {
    const file = path.join(tempDir(), "deploy.lock");
    writeLock(file, validLock({ updatedAt: iso(0), expiresAt: iso(8 * 60 * 60 * 1000) }));
    const atTwoHours = new DeploymentLock(file, {
      now: () => NOW + 2 * 60 * 60 * 1000,
      staleAfterMs: 3 * 60 * 60 * 1000,
    });
    expect(atTwoHours.isActive()).toBe(true);
    const status = new DeploymentLock(file, {
      now: () => NOW + 2 * 60 * 60 * 1000 + 1,
      staleAfterMs: 3 * 60 * 60 * 1000,
    }).status();
    expect(status.active).toBe(false);
    if (!status.active) {
      expect(status.reason).toBe("stale");
    }
  });

  it("accepts malformed content while its mtime is fresh and ignores it afterwards", () => {
    const dir = tempDir();
    const file = path.join(dir, "deploy.lock");
    writeLock(file, "{ not json");

    const fresh = new DeploymentLock(file);
    expect(fresh.status()).toEqual({ active: true, reason: "malformed" });

    const staleAt = new Date(Date.now() - 6 * 60 * 1000);
    utimesSync(file, staleAt, staleAt);
    expect(fresh.status()).toEqual({ active: false, reason: "malformed" });
  });

  it("keeps a malformed lock active when its mtime is in the future", () => {
    const file = path.join(tempDir(), "deploy.lock");
    writeLock(file, "not-json");
    const future = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(file, future, future);
    expect(new DeploymentLock(file).isActive()).toBe(true);
  });

  it("fails closed for a non-ENOENT read error", () => {
    const file = path.join(tempDir(), "deploy.lock");
    mkdirSync(file);
    expect(new DeploymentLock(file).status()).toEqual({ active: true, reason: "malformed" });
  });

  it("rejects an unknown version and invalid fields as malformed", () => {
    const file = path.join(tempDir(), "deploy.lock");
    for (const value of [
      validLock({ version: 2 }),
      validLock({ id: "" }),
      validLock({ startedAt: "not-a-date" }),
      validLock({ updatedAt: iso(0), expiresAt: iso(-1000) }),
      validLock({ phase: "" }),
    ]) {
      writeLock(file, value);
      expect(new DeploymentLock(file).status()).toEqual({ active: true, reason: "malformed" });
    }
  });

  it("never writes the lock file", () => {
    const file = path.join(tempDir(), "deploy.lock");
    writeLock(file, validLock());
    const before = readFileSync(file, "utf8");
    const lock = lockAt(file);
    lock.status();
    lock.isActive();
    expect(() => lock.assertUnlocked("stop")).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
