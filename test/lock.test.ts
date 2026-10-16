import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileWriterLock, LockUnavailableError } from "../src/coordinator/lock.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-lock-"));
  dirs.push(dir);
  return dir;
}

describe("FileWriterLock", () => {
  it("excludes a second holder and frees on release", () => {
    const lock = new FileWriterLock(root());
    const handle = lock.acquire("web", "one");
    expect(lock.isHeld("web")).toBe(true);
    expect(() => lock.acquire("web", "two")).toThrow(LockUnavailableError);
    handle.release();
    expect(lock.isHeld("web")).toBe(false);
    expect(() => lock.acquire("web", "two")).not.toThrow();
  });

  it("steals a lock left by a dead process", () => {
    const base = root();
    const lock = new FileWriterLock(base);
    mkdirSync(path.join(base, "locks"), { recursive: true });
    writeFileSync(
      lock.lockPath("web"),
      JSON.stringify({ owner: "dead", pid: 2147483647, startedAt: "" }),
    );
    const handle = lock.acquire("web", "alive");
    expect(handle.owner).toBe("alive");
    handle.release();
  });

  it("blocks while another process holds the lock, then acquires after it exits", async () => {
    const base = root();
    const lock = new FileWriterLock(base);
    const file = lock.lockPath("web");
    mkdirSync(path.dirname(file), { recursive: true });
    const script = [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ owner: 'child', pid: process.pid, startedAt: '' }));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const child = spawn("node", ["-e", script], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(() => lock.acquire("web", "parent")).toThrow(LockUnavailableError);

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const handle = lock.acquire("web", "parent");
    expect(handle.owner).toBe("parent");
    handle.release();
  });
});
