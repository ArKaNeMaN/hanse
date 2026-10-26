import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacyV1BaseReference } from "../src/runtime/base-image.js";
import {
  boundedErrorMessage,
  computeBuildSpecHash,
  computeLegacyBuildSpecHashV1,
  defaultImageReference,
  resolveBuildDockerfile,
} from "../src/runtime/build-spec.js";

const FROM_BASE = `FROM \${HANSE_BASE}\n`;
const DEFAULT_IMAGE = "ghcr.io/example/hanse-agent-default:1";
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

function hashFromApp(
  appDir: string,
  buildArgs: Record<string, string> = {},
  baseKind: "default" | "base" | "explicit" | "unknown" = "default",
): string {
  const dockerfile = resolveBuildDockerfile({ appDir, dockerfile: "Dockerfile" });
  return computeBuildSpecHash({ dockerfile: dockerfile.content, buildArgs, baseKind });
}

describe("computeBuildSpecHash (version 2)", () => {
  it("returns a deterministic SHA-256 and ignores build arg insertion order", () => {
    const first = computeBuildSpecHash({
      dockerfile: FROM_BASE,
      baseKind: "default",
      buildArgs: { ZED: "last", ALPHA: "first" },
    });
    const second = computeBuildSpecHash({
      dockerfile: FROM_BASE,
      baseKind: "default",
      buildArgs: { ALPHA: "first", ZED: "last" },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("excludes the base reference, tag, and digest and includes only the base kind", () => {
    const baseline = computeBuildSpecHash({
      dockerfile: FROM_BASE,
      baseKind: "default",
      buildArgs: { A: "1" },
    });

    expect(
      computeBuildSpecHash({
        dockerfile: FROM_BASE,
        baseKind: "default",
        buildArgs: { A: "1" },
      }),
    ).toBe(baseline);
    expect(
      computeBuildSpecHash({
        dockerfile: FROM_BASE,
        baseKind: "base",
        buildArgs: { A: "1" },
      }),
    ).not.toBe(baseline);
    expect(
      computeBuildSpecHash({
        dockerfile: FROM_BASE,
        baseKind: "explicit",
        buildArgs: { A: "1" },
      }),
    ).not.toBe(baseline);
    expect(
      computeBuildSpecHash({
        dockerfile: FROM_BASE,
        baseKind: "unknown",
        buildArgs: { A: "1" },
      }),
    ).not.toBe(baseline);
  });

  it("changes when the Dockerfile or a build arg changes", () => {
    const base = {
      dockerfile: `${FROM_BASE}RUN apt-get update\n`,
      baseKind: "default" as const,
      buildArgs: { A: "1" },
    };
    const baseline = computeBuildSpecHash(base);

    expect(computeBuildSpecHash({ ...base, dockerfile: `${base.dockerfile}RUN true\n` })).not.toBe(
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

describe("legacy version-1 hash", () => {
  it("recomputes a full-reference v1 hash with the historical algorithm", () => {
    const v1 = computeLegacyBuildSpecHashV1({
      dockerfile: FROM_BASE,
      defaultImage: DEFAULT_IMAGE,
      buildArgs: { A: "1" },
    });
    const v2 = computeBuildSpecHash({
      dockerfile: FROM_BASE,
      baseKind: "default",
      buildArgs: { A: "1" },
    });
    expect(v1).toMatch(/^[a-f0-9]{64}$/);
    expect(v1).not.toBe(v2);
    expect(
      computeLegacyBuildSpecHashV1({
        dockerfile: FROM_BASE,
        defaultImage: DEFAULT_IMAGE,
        buildArgs: { A: "1" },
      }),
    ).toBe(v1);
    expect(
      computeLegacyBuildSpecHashV1({
        dockerfile: FROM_BASE,
        defaultImage: "ghcr.io/example/hanse-agent-default:2",
        buildArgs: { A: "1" },
      }),
    ).not.toBe(v1);
  });

  it("reconstructs only a full legacy reference, never a digest-only value", () => {
    expect(legacyV1BaseReference(DEFAULT_IMAGE)).toBe(DEFAULT_IMAGE);
    expect(legacyV1BaseReference("agent-default")).toBe("agent-default");
    expect(legacyV1BaseReference(`sha256:${"a".repeat(64)}`)).toBeNull();
    expect(legacyV1BaseReference(null)).toBeNull();
    expect(legacyV1BaseReference("   ")).toBeNull();
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
