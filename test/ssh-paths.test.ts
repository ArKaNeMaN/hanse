import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDestination, readAppFile, remotePath, remotePathInside } from "../src/ssh/paths.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ssh-paths-"));
  dirs.push(dir);
  return dir;
}

describe("SSH local path confinement", () => {
  it("reads regular files and rejects traversal, absolute outside, and symlinks", () => {
    const app = fixture();
    mkdirSync(path.join(app, "sub"));
    writeFileSync(path.join(app, "a.txt"), "hello");
    symlinkSync("/etc/passwd", path.join(app, "passwd-link"));
    symlinkSync("/tmp", path.join(app, "tmp-link"));
    expect(readAppFile(app, "a.txt").data.toString()).toBe("hello");
    expect(() => readAppFile(app, "sub/../a.txt")).toThrow(/\.\./);
    expect(() => readAppFile(app, "../a.txt")).toThrow(/\.\./);
    expect(() => readAppFile(app, "/etc/passwd")).toThrow(/outside/);
    expect(() => readAppFile(app, "passwd-link")).toThrow(/path/i);
    expect(() => readAppFile(app, "tmp-link/passwd")).toThrow(/path/i);
    expect(() => readAppFile(app, "")).toThrow(/empty/i);
  });

  it("does not block on a FIFO and writes atomically without following a final symlink", () => {
    const app = fixture();
    execFileSync("mkfifo", [path.join(app, "pipe")]);
    expect(() => readAppFile(app, "pipe")).toThrow(/regular file/i);

    const outside = path.join(fixture(), "outside.txt");
    writeFileSync(outside, "unchanged");
    symlinkSync(outside, path.join(app, "out.txt"));
    const target = openAppDestination(app, "out.txt");
    try {
      target.write(Buffer.from("new"));
    } finally {
      target.close();
    }
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
    expect(readFileSync(path.join(app, "out.txt"), "utf8")).toBe("new");
  });

  it("normalizes remote paths and confines them to the remote root", () => {
    expect(remotePath("/srv/app/file", "/srv/app")).toBe("/srv/app/file");
    expect(remotePath("/srv/app/file", null)).toBe("/srv/app/file");
    expect(() => remotePath("/srv/app/../etc/passwd", "/srv/app")).toThrow(/\.\./);
    expect(() => remotePath("/etc/passwd", "/srv/app")).toThrow(/outside/);
    expect(() => remotePath("relative", null)).toThrow(/absolute/);
    expect(remotePathInside("/srv/app/file", "/srv/app")).toBe(true);
    expect(remotePathInside("/srv/application", "/srv/app")).toBe(false);
  });
});
