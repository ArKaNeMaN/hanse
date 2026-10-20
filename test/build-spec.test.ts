import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundedErrorMessage,
  computeBuildSpecHash,
  defaultImageReference,
  resolveBuildDockerfile,
} from "../src/runtime/build-spec.js";

const FROM_BASE = `FROM \${HANSE_BASE}\n`;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

async function fixture(): Promise<string> {
  const appDir = await mkdtemp(path.join(tmpdir(), "hanse-build-spec-"));
  dirs.push(appDir);
  return appDir;
}

function hashFromApp(appDir: string, buildArgs: Record<string, string> = {}): string {
  const dockerfile = resolveBuildDockerfile({ appDir, dockerfile: "Dockerfile" });
  return computeBuildSpecHash({
    dockerfile: dockerfile.content,
    defaultImage: "ghcr.io/example/hanse-agent-default:1",
    buildArgs,
  });
}

describe("computeBuildSpecHash", () => {
  it("returns a deterministic SHA-256 and ignores build arg insertion order", () => {
    const first = computeBuildSpecHash({
      dockerfile: FROM_BASE,
      defaultImage: "ghcr.io/example/base:1",
      buildArgs: { ZED: "last", ALPHA: "first" },
    });
    const second = computeBuildSpecHash({
      dockerfile: FROM_BASE,
      defaultImage: "ghcr.io/example/base:1",
      buildArgs: { ALPHA: "first", ZED: "last" },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("changes when the Dockerfile, default image, or a build arg changes", () => {
    const base = {
      dockerfile: `${FROM_BASE}RUN apt-get update\n`,
      defaultImage: "ghcr.io/example/base:1",
      buildArgs: { A: "1" },
    };
    const baseline = computeBuildSpecHash(base);

    expect(computeBuildSpecHash({ ...base, dockerfile: `${base.dockerfile}RUN true\n` })).not.toBe(
      baseline,
    );
    expect(computeBuildSpecHash({ ...base, defaultImage: "ghcr.io/example/base:2" })).not.toBe(
      baseline,
    );
    expect(computeBuildSpecHash({ ...base, buildArgs: { A: "2" } })).not.toBe(baseline);
    expect(computeBuildSpecHash({ ...base, buildArgs: { A: "1", B: "2" } })).not.toBe(baseline);
  });

  it("stays stable when only application source files change", async () => {
    const appDir = await fixture();
    await writeFile(path.join(appDir, "Dockerfile"), FROM_BASE, "utf8");
    await writeFile(path.join(appDir, "server.js"), "console.log('one');\n", "utf8");
    const before = hashFromApp(appDir);

    await writeFile(path.join(appDir, "server.js"), "console.log('two');\n", "utf8");
    await writeFile(path.join(appDir, "package.json"), "{}\n", "utf8");
    expect(hashFromApp(appDir)).toBe(before);
  });

  it("changes when the Dockerfile contents change", async () => {
    const appDir = await fixture();
    await writeFile(path.join(appDir, "Dockerfile"), FROM_BASE, "utf8");
    const before = hashFromApp(appDir);

    await writeFile(path.join(appDir, "Dockerfile"), `${FROM_BASE}RUN true\n`, "utf8");
    expect(hashFromApp(appDir)).not.toBe(before);
  });
});

describe("defaultImageReference", () => {
  it("falls back to the default agent image and appends an optional digest", () => {
    expect(defaultImageReference({})).toBe("agent-default");
    expect(defaultImageReference({ HANSE_AGENT_IMAGE: " ghcr.io/x/base:1 " })).toBe(
      "ghcr.io/x/base:1",
    );
    expect(
      defaultImageReference({
        HANSE_AGENT_IMAGE: "ghcr.io/x/base:1",
        HANSE_AGENT_IMAGE_DIGEST: "sha256:abc",
      }),
    ).toBe("ghcr.io/x/base:1@sha256:abc");
  });
});

describe("boundedErrorMessage", () => {
  it("collapses control characters and bounds the message", () => {
    expect(boundedErrorMessage(new Error("line one\nline\ttwo"))).toBe("line one line two");
    const bounded = boundedErrorMessage(new Error("x".repeat(100)), 20);
    expect(bounded).toHaveLength(20);
    expect(bounded.endsWith("...")).toBe(true);
  });
});
