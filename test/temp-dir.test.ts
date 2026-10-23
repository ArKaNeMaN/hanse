import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeDir, sweepStaleRuntimeDirs } from "../src/git/temp-dir.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-temp-dir-test-"));
  dirs.push(dir);
  return dir;
}

describe("runtime temp directories", () => {
  it("registers exactly one exit listener across runtime directories", () => {
    const base = root();
    const before = process.listenerCount("exit");
    createRuntimeDir("hanse-temp-test-", base);
    const afterFirst = process.listenerCount("exit");
    createRuntimeDir("hanse-temp-test-", base);
    const afterSecond = process.listenerCount("exit");
    expect(afterFirst - before).toBe(1);
    expect(afterSecond).toBe(afterFirst);
    expect(readdirSync(base)).toHaveLength(2);
  });

  it("sweeps only stale directories with the matching prefix", () => {
    const base = root();
    const now = Date.now();
    const fresh = path.join(base, "hanse-git-clone-fresh");
    const stale = path.join(base, "hanse-git-clone-stale");
    const other = path.join(base, "hanse-git-other-stale");
    mkdirSync(fresh);
    mkdirSync(stale);
    mkdirSync(other);
    utimesSync(fresh, new Date(now), new Date(now));
    utimesSync(stale, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
    utimesSync(other, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));

    sweepStaleRuntimeDirs({
      root: base,
      prefix: "hanse-git-clone-",
      maxAgeMs: 60 * 60 * 1000,
      now,
    });

    expect(statSync(fresh, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
    expect(statSync(stale, { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(other, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
  });

  it("keeps registered, protected, and symlinked directories", () => {
    const base = root();
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    const active = createRuntimeDir("hanse-git-clone-active", base);
    const workspace = path.join(base, "workspace");
    const protectedDir = path.join(workspace, "hanse-git-clone-protected");
    mkdirSync(workspace);
    mkdirSync(protectedDir);
    const target = path.join(base, "target");
    const link = path.join(base, "hanse-git-clone-link");
    mkdirSync(target);
    symlinkSync(target, link);
    utimesSync(active, old, old);
    utimesSync(protectedDir, old, old);
    utimesSync(link, old, old);

    sweepStaleRuntimeDirs({
      root: base,
      prefix: "hanse-git-clone-",
      maxAgeMs: 60 * 60 * 1000,
      now,
      protectedRoot: workspace,
    });

    expect(statSync(active, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
    expect(statSync(protectedDir, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
    expect(lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);
    expect(statSync(target, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
  });
});
