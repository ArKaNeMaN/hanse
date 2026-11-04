import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCKERIGNORE_FILENAME,
  DockerignoreFileError,
  MAX_DOCKERIGNORE_BYTES,
  readDockerignoreFile,
} from "../src/runtime/dockerignore.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function appDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hanse-dockerignore-"));
  dirs.push(dir);
  return dir;
}

describe("readDockerignoreFile", () => {
  it("reads a regular file and returns null when it is absent", async () => {
    const dir = await appDir();
    expect(readDockerignoreFile(dir)).toBeNull();

    await writeFile(path.join(dir, DOCKERIGNORE_FILENAME), "dist/\n", "utf8");
    expect(readDockerignoreFile(dir)?.toString("utf8")).toBe("dist/\n");
  });

  it("rejects a symlinked .dockerignore", async () => {
    const dir = await appDir();
    await writeFile(path.join(dir, "source"), "dist/\n", "utf8");
    await symlink(path.join(dir, "source"), path.join(dir, DOCKERIGNORE_FILENAME));

    expect(() => readDockerignoreFile(dir)).toThrowError(DockerignoreFileError);
    try {
      readDockerignoreFile(dir);
    } catch (error) {
      expect((error as DockerignoreFileError).code).toBe("symlink");
    }
  });

  it("rejects a directory and an oversized file", async () => {
    const dir = await appDir();
    await mkdir(path.join(dir, DOCKERIGNORE_FILENAME));
    expect(() => readDockerignoreFile(dir)).toThrowError(DockerignoreFileError);

    await rm(path.join(dir, DOCKERIGNORE_FILENAME), { recursive: true });
    await writeFile(
      path.join(dir, DOCKERIGNORE_FILENAME),
      Buffer.alloc(MAX_DOCKERIGNORE_BYTES + 1),
    );
    try {
      readDockerignoreFile(dir);
    } catch (error) {
      expect((error as DockerignoreFileError).code).toBe("too_large");
    }
  });
});
