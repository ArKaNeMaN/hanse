import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MASTER_DIR_NAME } from "../src/master/constants.js";
import {
  listWorkspaceDir,
  MAX_DIR_ENTRIES,
  MAX_READ_BYTES,
  readWorkspaceFile,
  WorkspaceFileError,
  writeWorkspaceFile,
} from "../src/master/workspace-files.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-master-files-"));
  dirs.push(dir);
  return dir;
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceFileError);
    expect((error as WorkspaceFileError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("master workspace files", () => {
  it("writes, replaces, and reads a file inside the workspace", () => {
    const root = workspace();
    const first = writeWorkspaceFile(root, "project/apps/one/AGENTS.md", "# One\n");
    expect(first).toEqual({ path: "project/apps/one/AGENTS.md", bytes: 6, created: true });
    expect(readWorkspaceFile(root, "project/apps/one/AGENTS.md")).toEqual({
      path: "project/apps/one/AGENTS.md",
      bytes: 6,
      content: "# One\n",
    });
    const second = writeWorkspaceFile(root, "project/apps/one/AGENTS.md", "# Two\n");
    expect(second.created).toBe(false);
    expect(readFileSync(path.join(root, "project/apps/one/AGENTS.md"), "utf8")).toBe("# Two\n");
  });

  it("rejects escaping and malformed paths", () => {
    const root = workspace();
    for (const value of ["", ".", "..", "../x", "/etc/passwd", "C:\\x", "a\\b", "a\0b", "a\nb"]) {
      expectCode(() => readWorkspaceFile(root, value), "invalid_path");
    }
  });

  it("rejects symlinked ancestors and final targets", () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    symlinkSync(outside, path.join(root, "link"));
    expectCode(() => readWorkspaceFile(root, "link/secret.txt"), "denied");
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "real", "target.txt"));
    expectCode(() => readWorkspaceFile(root, "real/target.txt"), "denied");
    expectCode(() => writeWorkspaceFile(root, "real/target.txt", "new"), "denied");
  });

  it("refuses .git, manifests, the master instructions, and binary content", () => {
    const root = workspace();
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, ".git", "config"), "[core]\n");
    expectCode(() => readWorkspaceFile(root, ".git/config"), "denied");
    expectCode(() => writeWorkspaceFile(root, ".git/config", "x"), "denied");
    mkdirSync(path.join(root, "app", ".hanse"), { recursive: true });
    expectCode(() => writeWorkspaceFile(root, "app/.hanse/app.yaml", "name: x\n"), "denied");
    mkdirSync(path.join(root, MASTER_DIR_NAME));
    expectCode(() => writeWorkspaceFile(root, `${MASTER_DIR_NAME}/AGENTS.md`, "changed"), "denied");
    writeFileSync(path.join(root, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
    expectCode(() => readWorkspaceFile(root, "binary.bin"), "binary");
    writeFileSync(path.join(root, "invalid.bin"), Buffer.from([0xff, 0xfe, 0xff]));
    expectCode(() => readWorkspaceFile(root, "invalid.bin"), "binary");
  });

  it("enforces the size and control-character caps", () => {
    const root = workspace();
    const large = "a".repeat(MAX_READ_BYTES + 1);
    expectCode(() => writeWorkspaceFile(root, "large.txt", large), "too_large");
    expectCode(() => writeWorkspaceFile(root, "control.txt", "a\u0001b"), "invalid_path");
    writeFileSync(path.join(root, "large.txt"), large);
    expectCode(() => readWorkspaceFile(root, "large.txt"), "too_large");
    expect(writeWorkspaceFile(root, "ok.txt", "a\tb\nc\r\n").bytes).toBe(7);
  });

  it("refuses directories and special files for reads", () => {
    const root = workspace();
    mkdirSync(path.join(root, "dir"));
    expectCode(() => readWorkspaceFile(root, "dir"), "not_a_file");
    if (process.platform !== "win32") {
      try {
        execFileSync("mkfifo", [path.join(root, "pipe")]);
        expectCode(() => readWorkspaceFile(root, "pipe"), "not_a_file");
      } catch {
        // mkfifo is unavailable in the test environment
      }
    }
  });

  it("lists directories without following entries and caps the result", () => {
    const root = workspace();
    writeFileSync(path.join(root, "a.txt"), "a");
    mkdirSync(path.join(root, "b"));
    symlinkSync(path.join(root, "a.txt"), path.join(root, "link"));
    const listing = listWorkspaceDir(root);
    expect(listing.path).toBe("");
    expect(listing.entries).toEqual([
      { name: "a.txt", type: "file", size: 1 },
      { name: "b", type: "directory", size: expect.any(Number) },
      { name: "link", type: "symlink", size: expect.any(Number) },
    ]);
    expect(listing.truncated).toBe(false);

    const full = workspace();
    for (let index = 0; index <= MAX_DIR_ENTRIES; index += 1) {
      writeFileSync(path.join(full, `f-${String(index).padStart(3, "0")}`), "x");
    }
    const capped = listWorkspaceDir(full);
    expect(capped.entries).toHaveLength(MAX_DIR_ENTRIES);
    expect(capped.truncated).toBe(true);
  });
});
