import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateKey, open, seal } from "../src/secrets/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-sec-"));
  dirs.push(dir);
  return dir;
}

describe("secrets", () => {
  it("creates a 32-byte key with restrictive permissions", () => {
    const dir = fixture();
    const keyPath = path.join(dir, "secret.key");
    expect(loadOrCreateKey(keyPath).length).toBe(32);
    expect(readFileSync(keyPath).length).toBe(32);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("enforces 0600 on an existing key file", () => {
    const dir = fixture();
    const keyPath = path.join(dir, "secret.key");
    loadOrCreateKey(keyPath);
    chmodSync(keyPath, 0o644);
    expect(loadOrCreateKey(keyPath).length).toBe(32);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("rejects a non-regular key path", () => {
    const dir = fixture();
    const keyPath = path.join(dir, "secret.key");
    mkdirSync(keyPath);
    expect(() => loadOrCreateKey(keyPath)).toThrow("regular file");
  });

  it("round-trips seal/open and rejects a wrong key", () => {
    const key = randomBytes(32);
    const sealed = seal(key, "token-value");
    expect(open(key, sealed)).toBe("token-value");
    expect(sealed.cipher).not.toContain("token-value");
    expect(() => open(randomBytes(32), sealed)).toThrow();
  });
});
