// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose and workflow interpolation placeholders are asserted literally.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
const targets = ["runtime", "agent-base", "agent-default", "agent-ide", "runner"];
const publishedSuffixes = ["", "-agent-base", "-agent-default", "-agent-ide", "-runner"];

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function loadYaml(relativePath: string): Record<string, unknown> {
  return parseYaml(read(relativePath)) as Record<string, unknown>;
}

function composeServices(file: string): Record<string, Record<string, unknown>> {
  const document = loadYaml(file);
  const services = document.services as Record<string, Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => {
      const merged = service["<<"];
      return [
        name,
        merged !== null && typeof merged === "object" && !Array.isArray(merged)
          ? { ...(merged as Record<string, unknown>), ...service }
          : service,
      ];
    }),
  );
}

function stageBlock(name: string): string {
  const lines = read("Dockerfile").split("\n");
  const start = lines.findIndex(
    (line) => line.trim().startsWith("FROM ") && line.trim().endsWith(`AS ${name}`),
  );
  if (start === -1) {
    throw new Error(`missing Dockerfile stage: ${name}`);
  }
  const next = lines.findIndex((line, index) => index > start && line.trim().startsWith("FROM "));
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

describe("compose image tags", () => {
  const services = composeServices("compose.yaml");

  it("resolves the coordinator tag from HANSE_TAG only", () => {
    expect(services.hanse.image).toBe(
      "${HANSE_IMAGE:-ghcr.io/arkaneman/hanse}:${HANSE_TAG:-latest}",
    );
  });

  it("keeps the agent on its own tag with a HANSE_TAG fallback", () => {
    const agentImage =
      "${HANSE_AGENT_IMAGE:-ghcr.io/arkaneman/hanse-agent-default}:${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}";
    expect((services.hanse.environment as Record<string, string>).HANSE_AGENT_IMAGE).toBe(
      agentImage,
    );
    expect((services.runner.environment as Record<string, string>).HANSE_AGENT_IMAGE).toBe(
      agentImage,
    );
  });

  it("overrides the IDE tag independently", () => {
    expect(services.ide.image).toBe(
      "${HANSE_IDE_IMAGE:-ghcr.io/arkaneman/hanse-agent-ide}:${HANSE_IDE_TAG:-${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}}",
    );
  });

  it("overrides the runner tag independently", () => {
    expect(services.runner.image).toBe(
      "${HANSE_RUNNER_IMAGE:-ghcr.io/arkaneman/hanse-runner}:${HANSE_RUNNER_TAG:-${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}}",
    );
  });

  it("passes the deployment lock path through to the coordinator", () => {
    expect((services.hanse.environment as Record<string, string>).HANSE_DEPLOY_LOCK_FILE).toBe(
      "${HANSE_DEPLOY_LOCK_FILE:-/data/state/hanse/deploy.lock}",
    );
  });
});

describe("compose source-build overlay", () => {
  const services = composeServices("compose.build.yaml");
  const raw = read("compose.build.yaml");

  it("builds only the three Compose services with explicit targets", () => {
    expect(Object.keys(services).sort()).toEqual(["hanse", "ide", "runner"]);
    expect((services.hanse.build as Record<string, string>).target).toBe("runtime");
    expect((services.ide.build as Record<string, string>).target).toBe("agent-ide");
    expect((services.runner.build as Record<string, string>).target).toBe("runner");
  });

  it("does not claim to build the per-app agent service", () => {
    expect(services["agent-default"]).toBeUndefined();
    expect(raw).toContain("does not build agent-default");
    expect(raw).not.toContain("HANSE_AGENT_BUILD_IMAGE");
  });
});

describe(".env.example image configuration", () => {
  const env = read(".env.example");

  it("documents every image repository and tag variable", () => {
    for (const name of [
      "HANSE_IMAGE",
      "HANSE_TAG",
      "HANSE_AGENT_IMAGE",
      "HANSE_AGENT_TAG",
      "HANSE_IDE_IMAGE",
      "HANSE_IDE_TAG",
      "HANSE_RUNNER_IMAGE",
      "HANSE_RUNNER_TAG",
    ]) {
      expect(env).toMatch(new RegExp(`^# ${name}=`, "m"));
    }
  });

  it("documents the lock path and the image-provided revision", () => {
    expect(env).toMatch(/^# HANSE_DEPLOY_LOCK_FILE=/m);
    expect(env).toContain("HANSE_REVISION is image-provided");
  });

  it("states that image variables are repositories, not full references", () => {
    expect(env).toContain("repositories only, not full references or digests");
    expect(env).toContain("Except for HANSE_AGENT_BASE_IMAGE");
    expect(env).toMatch(/^# HANSE_AGENT_BASE_IMAGE=/m);
    expect(env).toContain("build.base: base` requires this reference");
  });
});

describe("publish workflow", () => {
  const workflow = loadYaml(".github/workflows/publish.yml");
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;

  it("runs the repository gates with read-only permissions before publishing", () => {
    expect(jobs.verify.permissions).toEqual({ contents: "read" });
    const steps = jobs.verify.steps as Array<Record<string, unknown>>;
    const uses = steps.map((step) => step.uses);
    expect(uses).toContain("actions/checkout@v4");
    const setupNode = steps.find((step) => step.uses === "actions/setup-node@v4");
    expect(setupNode?.with).toEqual({ "node-version": 22, cache: "npm" });
    const runs = steps
      .map((step) => step.run)
      .filter((run): run is string => typeof run === "string");
    expect(runs).toEqual(
      expect.arrayContaining([
        "npm ci",
        "npm run lint",
        "npm run check:sensitive",
        "npm run typecheck",
        "npm test",
        "npm run build",
      ]),
    );
  });

  it("pre-builds every Docker target without pushing", () => {
    expect(jobs["docker-verify"].permissions).toEqual({ contents: "read" });
    expect(
      (jobs["docker-verify"].strategy as { matrix: { target: string[] } }).matrix.target,
    ).toEqual(targets);
    const steps = jobs["docker-verify"].steps as Array<Record<string, unknown>>;
    const build = steps.find((step) => step.uses === "docker/build-push-action@v6");
    expect(build?.with).toMatchObject({
      context: ".",
      platforms: "linux/amd64",
      push: false,
      load: false,
      "cache-from": "type=gha,scope=ci-${{ matrix.target }}",
      "cache-to": "type=gha,mode=max,scope=ci-${{ matrix.target }}",
    });
  });

  it("gates publish on both verification jobs", () => {
    expect(jobs.publish.needs).toEqual(["verify", "docker-verify"]);
    const matrix = (jobs.publish.strategy as { matrix: { include: Array<{ suffix: string }> } })
      .matrix;
    expect(matrix.include.map((entry) => entry.suffix)).toEqual(publishedSuffixes);
  });

  it("publishes both short and full SHA tags", () => {
    const steps = jobs.publish.steps as Array<Record<string, unknown>>;
    const metadata = steps.find((step) => step.id === "meta");
    if (metadata === undefined) {
      throw new Error("missing metadata step");
    }
    const tags = (metadata.with as Record<string, string>).tags;
    expect(tags).toContain("type=sha,format=short");
    expect(tags).toContain("type=sha,format=long");
  });

  it("verifies every full-SHA manifest after a partial or complete publish", () => {
    const verifyImages = jobs["verify-images"];
    expect(verifyImages.needs).toBe("publish");
    expect(verifyImages.if).toBe("always() && needs.publish.result != 'cancelled'");
    expect(verifyImages.permissions).toEqual({ contents: "read", packages: "read" });

    const steps = verifyImages.steps as Array<Record<string, unknown>>;
    expect(steps.map((step) => step.uses)).toContain("docker/login-action@v3");
    expect(steps.map((step) => step.uses)).toContain("docker/setup-buildx-action@v3");

    const script = steps.find(
      (step) => typeof step.run === "string" && step.run.includes("digests.txt"),
    );
    const body = script?.run as string;
    expect(body).toContain(
      'for suffix in "" "-agent-base" "-agent-default" "-agent-ide" "-runner"',
    );
    expect(body).toContain("for attempt in $(seq 1 12)");
    expect(body).toContain("sleep 10");
    expect(body).toContain("docker manifest inspect");
    expect(body).toContain("docker buildx imagetools inspect");
    expect(body).toContain("sha-${GITHUB_SHA}");

    const upload = steps.find((step) => step.uses === "actions/upload-artifact@v4");
    expect(upload?.with).toEqual({
      name: "image-digests",
      path: "digests.txt",
      "if-no-files-found": "error",
    });
  });
});

describe("CI workflow", () => {
  const workflow = loadYaml(".github/workflows/ci.yml");
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;

  it("keeps the same Docker target matrix and cache scopes", () => {
    expect((jobs.docker.strategy as { matrix: { target: string[] } }).matrix.target).toEqual(
      targets,
    );
    const steps = jobs.docker.steps as Array<Record<string, unknown>>;
    const build = steps.find((step) => step.uses === "docker/build-push-action@v6");
    expect(build?.with).toMatchObject({
      platforms: "linux/amd64",
      push: false,
      load: false,
      "cache-from": "type=gha,scope=ci-${{ matrix.target }}",
      "cache-to": "type=gha,mode=max,scope=ci-${{ matrix.target }}",
    });
  });
});

describe("Dockerfile revision", () => {
  for (const name of ["runtime", "agent-base", "agent-ide", "runner"]) {
    it(`exposes HANSE_REVISION and scopes the ARG in the ${name} stage`, () => {
      const block = stageBlock(name);
      expect(block).toContain("ARG REVISION=");
      expect(block).toContain("HANSE_REVISION=${REVISION}");
    });
  }

  it("lets agent-default inherit the base revision without rebaking it", () => {
    expect(stageBlock("agent-default").trimStart().startsWith("FROM agent-base")).toBe(true);
  });
});

describe("tracked release files", () => {
  const files = [
    ".env.example",
    "compose.yaml",
    "compose.build.yaml",
    ".github/workflows/publish.yml",
    ".github/workflows/ci.yml",
    "Dockerfile",
    "docs/deployment.md",
    "README.md",
    "docs/current-state.md",
  ];

  const forbidden: Array<[string, RegExp]> = [
    [
      "private network address",
      /(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/,
    ],
    ["deployment host alias", /\bsrv\d+\b/],
    [
      "absolute home path",
      /(?<![\w.-])(?:\/home|\/Users)\/(?!coder\b|node\b|you\b|user\b|app\b|agent\b)[A-Za-z0-9_][A-Za-z0-9._-]*/,
    ],
    [
      "credential-like literal",
      /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/,
    ],
  ];

  for (const file of files) {
    it(`contains no host-specific data in ${file}`, () => {
      const source = read(file);
      for (const [label, pattern] of forbidden) {
        expect(source, `${file}: ${label}`).not.toMatch(pattern);
      }
    });
  }
});
