import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BuildRecordStore } from "../src/runner/build-records.js";
import { DockerClient } from "../src/runner/docker.js";
import type { RunnerImageRecord } from "../src/runner/images.js";

const enabled = process.env.HANSE_TEST_DOCKER === "1";
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("runner build records integration", () => {
  it("pings Docker and reloads a building record as interrupted with its logs", async () => {
    const socketPath = process.env.HANSE_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock";
    const docker = DockerClient.unixSocket(socketPath);
    await expect(docker.ping()).resolves.toBeUndefined();

    const dir = mkdtempSync(path.join(tmpdir(), "hanse-build-records-"));
    dirs.push(dir);

    const record: RunnerImageRecord = {
      appId: "project:app",
      status: "building",
      imageRef: null,
      imageId: null,
      buildId: "build-integration",
      logs: "partial build output\n",
      error: null,
      updatedAt: new Date().toISOString(),
      targetRef: null,
      specHash: null,
      specHashVersion: null,
      hashVersion: null,
      baseKind: null,
      baseRef: null,
      baseDigest: null,
    };
    new BuildRecordStore({ dir }).save(record);

    const loaded = new BuildRecordStore({ dir }).load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      buildId: "build-integration",
      status: "interrupted",
      error: "runner restarted during image build",
      logs: "partial build output\n",
    });
  });
});
