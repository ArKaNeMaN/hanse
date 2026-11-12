import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DockerClient } from "../src/runner/docker.js";

const enabled = process.env.HANSE_TEST_DOCKER === "1";
const image = process.env.HANSE_TEST_MOUNT_IMAGE ?? "busybox:latest";
const roots = enabled ? [mkdtempSync(path.join(tmpdir(), "hanse-mount-smoke-"))] : [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!enabled)("runner mounts Docker smoke", () => {
  it("mounts the attachments and git leaves read-only", async () => {
    const socketPath = process.env.HANSE_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock";
    const docker = DockerClient.unixSocket(socketPath);
    await expect(docker.ping()).resolves.toBeUndefined();
    const inspected = await docker.inspectImage(image);
    if (inspected === undefined) {
      console.warn(
        `[runner-mounts] set HANSE_TEST_MOUNT_IMAGE to a locally available image (missing: ${image})`,
      );
      return;
    }

    const root = roots[0] as string;
    const appDir = path.join(root, "mounts", "project", "app");
    const attachments = path.join(appDir, "attachments");
    const git = path.join(appDir, "git");
    mkdirSync(attachments, { recursive: true });
    mkdirSync(git, { recursive: true });
    writeFileSync(path.join(attachments, "file.txt"), "attachment");
    writeFileSync(path.join(git, "id"), "key");

    const containerName = `hanse-mount-smoke-${process.pid}-${Date.now()}`;
    let id: string | undefined;
    try {
      id = await docker.createContainer({
        name: containerName,
        image,
        hostname: containerName,
        user: "1000:1000",
        entrypoint: ["/bin/sh"],
        cmd: [
          "-c",
          "test -f /data/attachments/file.txt && test -f /data/git/id && ! touch /data/attachments/probe && ! touch /data/git/probe",
        ],
        workingDir: "/",
        env: {},
        labels: { "hanse.test.mounts": "true" },
        binds: [`${attachments}:/data/attachments:ro`, `${git}:/data/git:ro`],
        tmpfs: { "/tmp": "rw,nosuid,size=16m" },
        memoryBytes: 128 * 1024 * 1024,
        nanoCpus: 1,
        pidsLimit: 64,
        networkName: "none",
        networkAliases: [],
        networkMode: "none",
        restartPolicy: "no",
      });
      const created = await docker.inspectContainer(id);
      expect(created?.HostConfig?.Binds).toEqual([
        `${attachments}:/data/attachments:ro`,
        `${git}:/data/git:ro`,
      ]);
      await docker.startContainer(id);
      const wait = await docker.waitContainer(id, 30_000);
      const logs = await docker.logs(id, 100);
      expect(wait.StatusCode, logs.logs).toBe(0);
    } finally {
      if (id !== undefined) {
        await docker.removeContainer(id, true).catch(() => undefined);
      }
    }
  });
});
