import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAuthFile } from "../src/opencode/auth.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): { dir: string; authFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-auth-"));
  dirs.push(dir);
  return { dir, authFile: path.join(dir, "opencode", "auth.json") };
}

describe("writeAuthFile", () => {
  it("writes a non-empty snapshot as JSON with mode 0600", () => {
    const { authFile } = fixture();
    const auth = { deepseek: { type: "api", key: "sk-test" } };

    writeAuthFile(authFile, auth);

    expect(JSON.parse(readFileSync(authFile, "utf8"))).toEqual(auth);
    expect(statSync(authFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(authFile)).mode & 0o777).toBe(0o700);
  });

  it("removes an existing file when the snapshot is empty", () => {
    const { authFile } = fixture();
    mkdirSync(path.dirname(authFile), { recursive: true });
    writeFileSync(authFile, '{"deepseek":{"type":"api","key":"old"}}');

    writeAuthFile(authFile, {});

    expect(existsSync(authFile)).toBe(false);
  });

  it("replaces previous providers instead of merging them", () => {
    const { authFile } = fixture();
    writeAuthFile(authFile, { deepseek: { type: "api", key: "first" } });

    writeAuthFile(authFile, { openai: { type: "api", key: "second" } });

    expect(JSON.parse(readFileSync(authFile, "utf8"))).toEqual({
      openai: { type: "api", key: "second" },
    });
  });

  it("does not read or merge host auth", () => {
    const { dir, authFile } = fixture();
    const hostAuth = path.join(dir, "host-auth.json");
    writeFileSync(hostAuth, JSON.stringify({ host: { type: "api", key: "host-key" } }));
    const previous = process.env.HANSE_AUTH_FILE;
    process.env.HANSE_AUTH_FILE = hostAuth;
    try {
      writeAuthFile(authFile, { deepseek: { type: "api", key: "settings-key" } });
    } finally {
      if (previous === undefined) delete process.env.HANSE_AUTH_FILE;
      else process.env.HANSE_AUTH_FILE = previous;
    }
    expect(JSON.parse(readFileSync(authFile, "utf8"))).toEqual({
      deepseek: { type: "api", key: "settings-key" },
    });
    expect(JSON.parse(readFileSync(hostAuth, "utf8"))).toEqual({
      host: { type: "api", key: "host-key" },
    });
  });
});
