import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);

interface PinnedFile {
  readonly path: string;
  readonly sha256: string;
}

function readFixture(): Map<string, string> {
  const text = readFileSync(new URL("test/fixtures/legacy-clients.sha256", ROOT), "utf8");
  const pins = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^([a-f0-9]{64})\s{2}(.+)$/.exec(line);
    expect(match, `malformed legacy-client pin: ${line}`).not.toBeNull();
    if (match !== null) {
      pins.set(match[2], match[1]);
    }
  }
  return pins;
}

function hash(path: string): string {
  return createHash("sha256")
    .update(readFileSync(new URL(path, ROOT)))
    .digest("hex");
}

describe("frozen legacy chat/terminal clients", () => {
  const pins = readFixture();
  const expected: PinnedFile[] = [
    { path: "assets/chat.js", sha256: pins.get("assets/chat.js") ?? "" },
    { path: "assets/terminal.js", sha256: pins.get("assets/terminal.js") ?? "" },
  ];

  it("pins both legacy clients in the fixture", () => {
    expect(readsFixture()).toEqual(["assets/chat.js", "assets/terminal.js"]);
  });

  it.each(expected)("$path matches its recorded Stage 0 hash", ({ path, sha256 }) => {
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(hash(path)).toBe(sha256);
  });

  function readsFixture(): string[] {
    return [...pins.keys()].sort();
  }
});
