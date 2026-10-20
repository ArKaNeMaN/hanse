import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BuildContextError,
  type BuildContextErrorCode,
  createBuildContext,
} from "../src/runner/build-context.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hanse-build-context-"));
  dirs.push(dir);
  return dir;
}

async function makeApp(
  files: Record<string, string | Buffer>,
  base?: string,
): Promise<{ base: string; app: string }> {
  const root = base ?? (await tempDir());
  const app = path.join(root, "app");
  await mkdir(app, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(app, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { base: root, app };
}

async function expectCode(
  run: Promise<unknown>,
  code: BuildContextErrorCode,
): Promise<BuildContextError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(BuildContextError);
    const typed = error as BuildContextError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`expected createBuildContext to reject with ${code}`);
}

interface TarEntry {
  readonly path: string;
  readonly type: string;
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
  readonly uid: number;
  readonly gid: number;
  readonly data: Buffer;
}

function readString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

/** Minimal local ustar reader: validates headers/checksums and returns members in archive order. */
function readTar(tar: Buffer): TarEntry[] {
  expect(tar.length % 512).toBe(0);
  const entries: TarEntry[] = [];
  let offset = 0;
  let sawTerminator = false;

  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (isZeroBlock(block)) {
      sawTerminator = true;
      offset += 512;
      continue;
    }
    expect(sawTerminator).toBe(false);
    expect(block.subarray(257, 262).toString("latin1")).toBe("ustar");
    expect(block[262]).toBe(0);
    expect(block.subarray(263, 265).toString("ascii")).toBe("00");

    const header = Buffer.from(block);
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    expect(readOctal(block, 148, 8)).toBe(checksum);

    const name = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    const size = readOctal(block, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    expect(dataEnd).toBeLessThanOrEqual(tar.length);

    entries.push({
      path: prefix.length > 0 ? `${prefix}/${name}` : name,
      type: String.fromCharCode(block[156] ?? 0),
      mode: readOctal(block, 100, 8),
      size,
      mtime: readOctal(block, 136, 12),
      uid: readOctal(block, 108, 8),
      gid: readOctal(block, 116, 8),
      data: Buffer.from(tar.subarray(dataStart, dataEnd)),
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  expect(offset).toBe(tar.length);
  expect(sawTerminator).toBe(true);
  return entries;
}

describe("createBuildContext", () => {
  it("builds a sorted POSIX ustar context with the Dockerfile at its relative path", async () => {
    const { app } = await makeApp({
      ".hanse/Dockerfile": "FROM scratch\n",
      ".hanse/app.yaml": "id: demo\n",
      "README.md": "# demo\n",
      "src/index.ts": "export const x = 1;\n",
      "src/lib/util.ts": "export const y = 2;\n",
      "empty/.keep": "",
    });

    const context = await createBuildContext(app);

    expect(context.dockerfile).toBe(".hanse/Dockerfile");
    expect(context.files).toEqual([
      ".hanse/Dockerfile",
      ".hanse/app.yaml",
      "README.md",
      "empty/.keep",
      "src/index.ts",
      "src/lib/util.ts",
    ]);
    expect(context.bytes).toBe(context.tar.length);

    const entries = readTar(context.tar);
    expect(entries.map((entry) => entry.path)).toEqual([
      ".hanse/",
      ".hanse/Dockerfile",
      ".hanse/app.yaml",
      "README.md",
      "empty/",
      "empty/.keep",
      "src/",
      "src/index.ts",
      "src/lib/",
      "src/lib/util.ts",
    ]);

    for (const entry of entries) {
      expect(entry.uid).toBe(0);
      expect(entry.gid).toBe(0);
      expect(entry.mtime).toBe(0);
      if (entry.type === "5") {
        expect(entry.path.endsWith("/")).toBe(true);
        expect(entry.mode).toBe(0o755);
        expect(entry.size).toBe(0);
      } else {
        expect(entry.type).toBe("0");
        expect(entry.mode).toBe(0o644);
      }
    }

    const dockerfile = entries.find((entry) => entry.path === ".hanse/Dockerfile");
    expect(dockerfile?.data.toString("utf8")).toBe("FROM scratch\n");
    const appYaml = entries.find((entry) => entry.path === ".hanse/app.yaml");
    expect(appYaml?.data.toString("utf8")).toBe("id: demo\n");
    expect(context.tar.subarray(-1024).every((byte) => byte === 0)).toBe(true);
  });

  it("is deterministic across repeated builds", async () => {
    const { app } = await makeApp({
      ".hanse/Dockerfile": "FROM scratch\n",
      "src/a.ts": "a",
      "src/b.ts": "b",
    });

    const first = await createBuildContext(app);
    const second = await createBuildContext(app);

    expect(second.tar.equals(first.tar)).toBe(true);
    expect(second.files).toEqual(first.files);
    expect(second.dockerfile).toBe(first.dockerfile);
    expect(second.bytes).toBe(first.bytes);
  });

  it("supports a custom Dockerfile path and uses the ustar prefix field for long paths", async () => {
    const longDirectory = "d".repeat(90);
    const { app } = await makeApp({
      "build/Dockerfile": "FROM scratch\n",
      [`${longDirectory}/nested/file.txt`]: "long\n",
    });

    const context = await createBuildContext(app, { dockerfile: "build/Dockerfile" });

    expect(context.dockerfile).toBe("build/Dockerfile");
    const paths = readTar(context.tar).map((entry) => entry.path);
    expect(paths).toContain("build/Dockerfile");
    expect(paths).toContain(`${longDirectory}/nested/file.txt`);
  });

  it("never emits absolute or parent-traversal member paths", async () => {
    const { app } = await makeApp({
      ".hanse/Dockerfile": "FROM scratch\n",
      "src/index.ts": "x",
    });

    const context = await createBuildContext(app);
    for (const entry of readTar(context.tar)) {
      expect(entry.path.startsWith("/")).toBe(false);
      expect(entry.path).not.toContain("\0");
      expect(entry.path.split("/").filter(Boolean)).not.toContain("..");
    }
  });

  describe("appDir validation", () => {
    it("rejects a missing directory", async () => {
      const base = await tempDir();
      await expectCode(createBuildContext(path.join(base, "missing")), "INVALID_APP_DIR");
    });

    it("rejects a regular file", async () => {
      const base = await tempDir();
      const file = path.join(base, "file");
      await writeFile(file, "not a directory");
      await expectCode(createBuildContext(file), "INVALID_APP_DIR");
    });

    it("rejects an empty path", async () => {
      await expectCode(createBuildContext(""), "INVALID_APP_DIR");
    });

    it("rejects a symlinked appDir", async () => {
      const base = await tempDir();
      const real = path.join(base, "real");
      await mkdir(path.join(real, ".hanse"), { recursive: true });
      await writeFile(path.join(real, ".hanse", "Dockerfile"), "FROM scratch\n");
      const link = path.join(base, "link");
      await symlink(real, link);

      await expectCode(createBuildContext(link), "SYMLINK_REJECTED");
    });
  });

  describe("Dockerfile validation", () => {
    it("rejects a missing default Dockerfile", async () => {
      const { app } = await makeApp({ "README.md": "x" });
      await expectCode(createBuildContext(app), "INVALID_DOCKERFILE");
    });

    it("rejects absolute, traversing, dot-segment, and NUL Dockerfile paths", async () => {
      const { base, app } = await makeApp({ ".hanse/Dockerfile": "FROM scratch\n" });
      await writeFile(path.join(base, "outside.Dockerfile"), "FROM scratch\n");

      await expectCode(
        createBuildContext(app, { dockerfile: path.join(base, "outside.Dockerfile") }),
        "INVALID_DOCKERFILE",
      );
      await expectCode(
        createBuildContext(app, { dockerfile: "../outside.Dockerfile" }),
        "INVALID_DOCKERFILE",
      );
      await expectCode(
        createBuildContext(app, { dockerfile: "./.hanse/Dockerfile" }),
        "INVALID_DOCKERFILE",
      );
      await expectCode(
        createBuildContext(app, { dockerfile: ".hanse/Dockerfile\0" }),
        "INVALID_DOCKERFILE",
      );
    });

    it("rejects a Dockerfile that is a directory", async () => {
      const { app } = await makeApp({ ".hanse/Dockerfile/placeholder": "x" });
      await expectCode(createBuildContext(app), "INVALID_DOCKERFILE");
    });

    it("rejects a Dockerfile inside an excluded top-level entry", async () => {
      const { app } = await makeApp({ "state/Dockerfile": "FROM scratch\n" });
      await expectCode(
        createBuildContext(app, { dockerfile: "state/Dockerfile" }),
        "INVALID_DOCKERFILE",
      );
    });

    it("rejects a Dockerfile symlink escaping the app directory", async () => {
      const { base, app } = await makeApp({});
      await mkdir(path.join(app, ".hanse"), { recursive: true });
      const outside = path.join(base, "Dockerfile");
      await writeFile(outside, "FROM scratch\n");
      await symlink(outside, path.join(app, ".hanse", "Dockerfile"));

      await expectCode(createBuildContext(app), "SYMLINK_REJECTED");
    });

    it("rejects a symlinked Dockerfile path component", async () => {
      const { base, app } = await makeApp({});
      const outsideDirectory = path.join(base, "outside");
      await mkdir(outsideDirectory, { recursive: true });
      await writeFile(path.join(outsideDirectory, "Dockerfile"), "FROM scratch\n");
      await symlink(outsideDirectory, path.join(app, ".hanse"));

      await expectCode(createBuildContext(app), "SYMLINK_REJECTED");
    });
  });

  describe("symlinks and special files", () => {
    it("rejects a symlinked file", async () => {
      const { app } = await makeApp({
        ".hanse/Dockerfile": "FROM scratch\n",
        "README.md": "x",
      });
      await symlink(path.join(app, "README.md"), path.join(app, "link.txt"));

      await expectCode(createBuildContext(app), "SYMLINK_REJECTED");
    });

    it("rejects a symlinked directory", async () => {
      const { app } = await makeApp({
        ".hanse/Dockerfile": "FROM scratch\n",
        "src/index.ts": "x",
      });
      await symlink(path.join(app, "src"), path.join(app, "linked"));

      await expectCode(createBuildContext(app), "SYMLINK_REJECTED");
    });

    it("rejects a dangling symlink", async () => {
      const { app } = await makeApp({ ".hanse/Dockerfile": "FROM scratch\n" });
      await symlink(path.join(app, "missing"), path.join(app, "dangling"));

      await expectCode(createBuildContext(app), "SYMLINK_REJECTED");
    });

    it("rejects a symlink pointing outside the app directory", async () => {
      const { base, app } = await makeApp({ ".hanse/Dockerfile": "FROM scratch\n" });
      const outside = path.join(base, "secret.txt");
      await writeFile(outside, "secret");
      await symlink(outside, path.join(app, "escape.txt"));

      await expectCode(createBuildContext(app), "SYMLINK_REJECTED");
    });

    it("rejects a fifo when the platform can create one", async (context) => {
      const { app } = await makeApp({ ".hanse/Dockerfile": "FROM scratch\n" });
      const fifo = path.join(app, "pipe");
      const result = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      if (result.status !== 0) {
        context.skip();
        return;
      }

      await expectCode(createBuildContext(app), "SPECIAL_FILE");
    });
  });

  describe("exclusions", () => {
    it("drops only top-level excluded entries and keeps nested source directories", async () => {
      const { app } = await makeApp({
        ".hanse/Dockerfile": "FROM scratch\n",
        ".git/config": "git",
        ".codegraph/graph.json": "graph",
        "node_modules/pkg/index.js": "module",
        "state/opencode.db": "state",
        "agents/home/.keep": "agents",
        ".cache/tool": "cache",
        ".mise/tool": "mise",
        "src/node_modules/keep.ts": "kept",
        "src/state/keep.ts": "kept",
        "src/agents/keep.ts": "kept",
        "src/.cache/keep.ts": "kept",
        "src/.mise/keep.ts": "kept",
        "src/.git/keep.ts": "kept",
        "src/.codegraph/keep.ts": "kept",
      });

      const context = await createBuildContext(app);
      const paths = readTar(context.tar).map((entry) => entry.path);

      for (const excluded of [
        ".git",
        ".codegraph",
        "node_modules",
        "state",
        "agents",
        ".cache",
        ".mise",
      ]) {
        expect(paths.some((entry) => entry === `${excluded}/`)).toBe(false);
        expect(paths.some((entry) => entry.startsWith(`${excluded}/`))).toBe(false);
      }

      for (const kept of [
        "src/node_modules/keep.ts",
        "src/state/keep.ts",
        "src/agents/keep.ts",
        "src/.cache/keep.ts",
        "src/.mise/keep.ts",
        "src/.git/keep.ts",
        "src/.codegraph/keep.ts",
      ]) {
        expect(paths).toContain(kept);
      }
      expect(paths).toContain(".hanse/Dockerfile");
    });
  });

  describe("limits", () => {
    it("rejects a context whose file bytes exceed maxBytes", async () => {
      const { app } = await makeApp({
        ".hanse/Dockerfile": "FROM scratch\n",
        "big.bin": "x".repeat(100),
      });

      const error = await expectCode(createBuildContext(app, { maxBytes: 50 }), "TOO_LARGE");
      expect(error.message).toContain("maxBytes");
    });

    it("accepts a context exactly at maxBytes", async () => {
      const dockerfile = "FROM scratch\n";
      const data = "y".repeat(37);
      const { app } = await makeApp({
        ".hanse/Dockerfile": dockerfile,
        "data.txt": data,
      });

      const context = await createBuildContext(app, {
        maxBytes: Buffer.byteLength(dockerfile) + Buffer.byteLength(data),
      });

      expect(context.files).toContain("data.txt");
    });

    it("rejects a context with too many entries", async () => {
      const { app } = await makeApp({
        ".hanse/Dockerfile": "FROM scratch\n",
        "a.txt": "a",
        "b.txt": "b",
      });

      // .hanse/, .hanse/Dockerfile, a.txt, b.txt => 4 entries.
      await expectCode(createBuildContext(app, { maxEntries: 3 }), "TOO_MANY_ENTRIES");
    });

    it("rejects invalid limit values", async () => {
      const { app } = await makeApp({ ".hanse/Dockerfile": "FROM scratch\n" });

      await expectCode(createBuildContext(app, { maxBytes: 0 }), "INVALID_OPTIONS");
      await expectCode(createBuildContext(app, { maxBytes: -1 }), "INVALID_OPTIONS");
      await expectCode(createBuildContext(app, { maxBytes: 1.5 }), "INVALID_OPTIONS");
      await expectCode(createBuildContext(app, { maxBytes: Number.NaN }), "INVALID_OPTIONS");
      await expectCode(createBuildContext(app, { maxEntries: 0 }), "INVALID_OPTIONS");
      await expectCode(createBuildContext(app, { maxEntries: -5 }), "INVALID_OPTIONS");
    });
  });
});
