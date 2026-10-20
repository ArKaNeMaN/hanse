import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOpencodePassword,
  opencodePasswordPath,
  readOpencodePassword,
} from "../src/opencode/password.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-password-"));
  dirs.push(dir);
  return path.join(dir, "state", "opencode-password");
}

describe("opencode server password", () => {
  it("mints a random password and writes it atomically with mode 0600", () => {
    const file = fixture();
    const password = ensureOpencodePassword(file);

    expect(password.length).toBeGreaterThan(20);
    expect(readFileSync(file, "utf8").trim()).toBe(password);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(opencodePasswordPath(path.dirname(file))).toBe(file);
  });

  it("reuses an existing password across calls", () => {
    const file = fixture();
    const first = ensureOpencodePassword(file);
    const second = ensureOpencodePassword(file);
    expect(second).toBe(first);
    expect(readFileSync(file, "utf8").trim()).toBe(first);
  });

  it("replaces an empty password file", () => {
    const file = fixture();
    ensureOpencodePassword(file);
    writeFileSync(file, "\n", { mode: 0o600 });
    expect(readOpencodePassword(file)).toBeUndefined();
    const password = ensureOpencodePassword(file);
    expect(password.length).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8").trim()).toBe(password);
  });
});
