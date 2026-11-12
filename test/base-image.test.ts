// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Dockerfile variable syntax is intentional
import { describe, expect, it } from "vitest";
import {
  BaseImageConfigError,
  DockerfileBuildError,
  isDigest,
  resolveBaseImage,
  resolveManifestDigest,
  validateDockerfileFrom,
} from "../src/runtime/base-image.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function resolve(
  dockerfile: string,
  overrides: Partial<Parameters<typeof resolveBaseImage>[0]> = {},
) {
  return resolveBaseImage({
    dockerfile,
    args: {},
    declaredBase: null,
    defaultImage: "ghcr.io/example/hanse-agent-default:1",
    baseImage: "ghcr.io/example/hanse-agent-base:1",
    ...overrides,
  });
}

describe("resolveBaseImage", () => {
  it("treats ${HANSE_BASE} as the configured default reference", () => {
    expect(resolve("ARG HANSE_BASE\nFROM ${HANSE_BASE}\n")).toEqual({
      kind: "default",
      ref: "ghcr.io/example/hanse-agent-default:1",
    });
  });

  it("accepts ${HANSE_BASE:-...} and the $HANSE_BASE spelling", () => {
    expect(resolve("ARG HANSE_BASE\nFROM ${HANSE_BASE:-scratch}\n").kind).toBe("default");
    expect(resolve("ARG HANSE_BASE\nFROM $HANSE_BASE\n").kind).toBe("default");
  });

  it("treats a literal root as explicit", () => {
    expect(resolve("FROM node:20-bookworm\n")).toEqual({
      kind: "explicit",
      ref: "node:20-bookworm",
    });
  });

  it("ignores --platform on the root FROM", () => {
    expect(resolve("FROM --platform=linux/amd64 ${HANSE_BASE}\n")).toEqual({
      kind: "default",
      ref: "ghcr.io/example/hanse-agent-default:1",
    });
  });

  it("follows the final stage through stage aliases to the root", () => {
    const dockerfile = [
      "ARG HANSE_BASE",
      "FROM ${HANSE_BASE} AS root",
      "RUN echo one",
      "FROM root AS middle",
      "RUN echo two",
      "FROM middle",
      "RUN echo three",
      "",
    ].join("\n");
    expect(resolve(dockerfile).kind).toBe("default");
  });

  it("resolves ARG values and lets manifest args override Dockerfile defaults", () => {
    const dockerfile = [
      "ARG REGISTRY=docker.io",
      "ARG BASE=node:20",
      "FROM ${REGISTRY}/${BASE}",
      "",
    ].join("\n");
    expect(resolve(dockerfile)).toEqual({
      kind: "explicit",
      ref: "docker.io/node:20",
    });
    expect(resolve(dockerfile, { args: { BASE: "node:22" } })).toEqual({
      kind: "explicit",
      ref: "docker.io/node:22",
    });
  });

  it("supports ${VAR:-default} and indirect root arguments", () => {
    const dockerfile = ["ARG ROOT=${HANSE_BASE}", "FROM ${ROOT}", ""].join("\n");
    expect(resolve(dockerfile).kind).toBe("default");
    expect(resolve("ARG TAG\nFROM node:${TAG:-20}\n")).toEqual({
      kind: "explicit",
      ref: "node:20",
    });
  });

  it("returns unknown for an unresolved variable", () => {
    expect(resolve("FROM ${MISSING}\n")).toEqual({ kind: "unknown", ref: null });
  });

  it("returns unknown for a cyclic ARG or alias chain", () => {
    expect(resolve("ARG A=${B}\nARG B=${A}\nFROM ${A}\n").kind).toBe("unknown");
    expect(resolve("FROM self AS self\n").kind).toBe("unknown");
  });

  it("returns unknown without a FROM", () => {
    expect(resolve("RUN echo hi\n")).toEqual({ kind: "unknown", ref: null });
  });

  it("uses the declared base kind when the root consumes HANSE_BASE", () => {
    expect(resolve("FROM ${HANSE_BASE}\n", { declaredBase: "base" })).toEqual({
      kind: "base",
      ref: "ghcr.io/example/hanse-agent-base:1",
    });
    expect(resolve("FROM ${HANSE_BASE}\n", { declaredBase: "default" })).toEqual({
      kind: "default",
      ref: "ghcr.io/example/hanse-agent-default:1",
    });
  });

  it("rejects build.base=base without HANSE_AGENT_BASE_IMAGE", () => {
    expect(() =>
      resolve("FROM ${HANSE_BASE}\n", { declaredBase: "base", baseImage: undefined }),
    ).toThrowError(expect.objectContaining({ code: "base_unavailable" }));
  });

  it("rejects a manifest HANSE_BASE argument", () => {
    expect(() => resolve("FROM ${HANSE_BASE}\n", { args: { HANSE_BASE: "node:20" } })).toThrowError(
      expect.objectContaining({ code: "base_arg_reserved" }),
    );
  });

  it("rejects a declared base whose resolved root ignores HANSE_BASE", () => {
    for (const declaredBase of ["default", "base"] as const) {
      let error: unknown;
      try {
        resolve("FROM node:20 AS build\n", { declaredBase });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(BaseImageConfigError);
      expect(error).toMatchObject({ code: "base_mismatch" });
    }
  });

  it("checks the resolved root, not the final stage text", () => {
    const dockerfile = [
      "ARG HANSE_BASE",
      "FROM ${HANSE_BASE} AS root",
      "RUN echo one",
      "FROM root",
      "RUN echo two",
      "",
    ].join("\n");
    expect(resolve(dockerfile, { declaredBase: "base" }).kind).toBe("base");
  });
});

describe("resolveManifestDigest", () => {
  it("prefers an explicit @sha256 digest", () => {
    expect(
      resolveManifestDigest(`ghcr.io/x/base@${DIGEST_A}`, [`ghcr.io/x/base@${DIGEST_B}`]),
    ).toBe(DIGEST_A);
  });

  it("requires exactly one matching-repository RepoDigests entry", () => {
    expect(resolveManifestDigest("ghcr.io/x/base:1", [`ghcr.io/x/base@${DIGEST_A}`])).toBe(
      DIGEST_A,
    );
    expect(
      resolveManifestDigest("ghcr.io/x/base:1", [
        `ghcr.io/x/base@${DIGEST_A}`,
        `ghcr.io/x/base@${DIGEST_B}`,
      ]),
    ).toBeNull();
    expect(
      resolveManifestDigest("ghcr.io/x/base:1", [`ghcr.io/other/base@${DIGEST_A}`]),
    ).toBeNull();
    expect(resolveManifestDigest("ghcr.io/x/base:1", [])).toBeNull();
  });

  it("rejects a malformed digest identity", () => {
    expect(resolveManifestDigest("ghcr.io/x/base@sha256:abc", [])).toBeNull();
    expect(isDigest("sha256:abc")).toBe(false);
    expect(isDigest(DIGEST_A)).toBe(true);
  });
});

const ALLOWED_FROM = new Set([
  "ghcr.io/example/hanse-agent-default:1",
  "ghcr.io/example/hanse-agent-base:1",
  "node:20",
  "node:20-bookworm",
]);

function validateFrom(
  dockerfile: string,
  overrides: Partial<Parameters<typeof validateDockerfileFrom>[0]> = {},
): void {
  validateDockerfileFrom({
    dockerfile,
    allowedImages: ALLOWED_FROM,
    args: {},
    baseImage: "ghcr.io/example/hanse-agent-default:1",
    ...overrides,
  });
}

function expectFromError(run: () => void, code: DockerfileBuildError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DockerfileBuildError);
    expect((error as DockerfileBuildError).code).toBe(code);
    return;
  }
  throw new Error(`expected DockerfileBuildError ${code}`);
}

describe("validateDockerfileFrom", () => {
  it("allows an allowlisted multi-stage build and prior aliases", () => {
    const dockerfile = [
      "ARG HANSE_BASE",
      "FROM ${HANSE_BASE} AS root",
      "RUN echo one",
      "FROM node:20 AS middle",
      "FROM middle",
      "",
    ].join("\n");
    expect(() => validateFrom(dockerfile)).not.toThrow();
  });

  it("rejects a disallowed intermediate stage", () => {
    const dockerfile = ["FROM node:20 AS build", "FROM evil:1 AS mid", "FROM build", ""].join("\n");
    expectFromError(() => validateFrom(dockerfile), "invalid_from");
  });

  it("does not implicitly allow a literal final FROM", () => {
    expectFromError(() => validateFrom("FROM node:99\n"), "invalid_from");
    expectFromError(
      () => validateFrom("FROM node:20\n", { allowedImages: new Set<string>() }),
      "invalid_from",
    );
  });

  it("expands ARG defaults and runner build args", () => {
    const dockerfile = ["ARG BASE=node:20", "FROM ${BASE}", ""].join("\n");
    expect(() => validateFrom(dockerfile)).not.toThrow();
    expectFromError(
      () => validateFrom("ARG BASE\nFROM ${BASE}\n", { args: { BASE: "evil:1" } }),
      "invalid_from",
    );
  });

  it("expands the runner-injected HANSE_BASE", () => {
    expect(() => validateFrom("ARG HANSE_BASE\nFROM ${HANSE_BASE}\n")).not.toThrow();
    expectFromError(
      () =>
        validateFrom("ARG HANSE_BASE\nFROM ${HANSE_BASE}\n", {
          allowedImages: new Set(["node:20"]),
        }),
      "invalid_from",
    );
  });

  it("rejects unknown variables and malformed references", () => {
    expectFromError(() => validateFrom("FROM ${MISSING}\n"), "invalid_from");
    expectFromError(() => validateFrom("FROM node:20:bad ref\n"), "invalid_from");
    expectFromError(() => validateFrom("FROM\n"), "invalid_dockerfile");
  });

  it("tracks prior aliases case-insensitively but not forward aliases", () => {
    expect(() => validateFrom("FROM node:20 AS Build\nFROM bUiLd\n")).not.toThrow();
    expectFromError(() => validateFrom("FROM Later\nFROM node:20 AS Later\n"), "invalid_from");
  });

  it("allows scratch and prior stage indices", () => {
    expect(() => validateFrom("FROM scratch\n")).not.toThrow();
    expect(() => validateFrom("FROM node:20 AS first\nFROM 0\n")).not.toThrow();
    expectFromError(() => validateFrom("FROM 1\nFROM node:20 AS later\n"), "invalid_from");
  });

  it("ignores --platform values, including variables", () => {
    expect(() =>
      validateFrom("FROM --platform=$BUILDPLATFORM node:20 AS build\nFROM build\n"),
    ).not.toThrow();
    expect(() => validateFrom("FROM --platform linux/amd64 node:20\n")).not.toThrow();
    expectFromError(() => validateFrom("FROM --platform=$BUILDPLATFORM evil:1\n"), "invalid_from");
  });

  it("handles comments and line continuations", () => {
    const dockerfile = [
      "# comment",
      "ARG BASE=node:20",
      "FROM \\",
      "# comment in continuation",
      "  ${BASE} AS build",
      "FROM build",
      "",
    ].join("\n");
    expect(() => validateFrom(dockerfile)).not.toThrow();
  });

  it("skips heredoc bodies instead of parsing them as instructions", () => {
    const dockerfile = [
      "ARG HANSE_BASE",
      "FROM ${HANSE_BASE} AS build",
      "RUN <<EOF",
      "FROM evil:1",
      "RUN --network=host true",
      "EOF",
      "FROM build",
      "",
    ].join("\n");
    expect(() => validateFrom(dockerfile)).not.toThrow();
    expectFromError(() => validateFrom("RUN <<EOF\nFROM evil:1\n"), "invalid_dockerfile");
  });

  it("rejects a non-backslash escape directive", () => {
    const dockerfile = ["# escape=`", "FROM node:20", ""].join("\n");
    expectFromError(() => validateFrom(dockerfile), "invalid_dockerfile");
  });

  it("accepts digest-pinned references only when allowlisted", () => {
    const digestRef = `node@${DIGEST_A}`;
    const allowed = new Set([...ALLOWED_FROM, digestRef]);
    expect(() => validateFrom(`FROM ${digestRef}\n`, { allowedImages: allowed })).not.toThrow();
    expectFromError(() => validateFrom(`FROM ${digestRef}\n`), "invalid_from");
  });

  it("rejects RUN --network=host and container networks", () => {
    expectFromError(
      () => validateFrom("FROM node:20\nRUN --network=host true\n"),
      "invalid_run_network",
    );
    expectFromError(
      () => validateFrom("FROM node:20\nRUN --network=container:abc true\n"),
      "invalid_run_network",
    );
  });

  it("allows RUN --network=default, none, and named networks", () => {
    for (const network of ["default", "none", "hanse-build"]) {
      expect(() => validateFrom(`FROM node:20\nRUN --network=${network} true\n`)).not.toThrow();
    }
  });

  it("validates COPY --from aliases, indices, and external images", () => {
    expect(() =>
      validateFrom("FROM node:20 AS builder\nFROM node:20\nCOPY --from=builder /x /y\n"),
    ).not.toThrow();
    expect(() => validateFrom("FROM node:20\nFROM node:20\nCOPY --from=0 /x /y\n")).not.toThrow();
    expect(() => validateFrom("FROM node:20\nCOPY --from=node:20 /x /y\n")).not.toThrow();
    expectFromError(
      () => validateFrom("FROM node:20\nCOPY --from=evil:latest /x /y\n"),
      "invalid_from",
    );
    expectFromError(() => validateFrom("FROM node:20\nCOPY --from=0 /x /y\n"), "invalid_from");
  });

  it("expands COPY --from variables and fails closed on unknown values", () => {
    expect(() =>
      validateFrom("FROM node:20\nARG IMG=node:20\nCOPY --from=${IMG} /x /y\n"),
    ).not.toThrow();
    expectFromError(
      () => validateFrom("FROM node:20\nARG IMG=evil:1\nCOPY --from=${IMG} /x /y\n"),
      "invalid_from",
    );
    expectFromError(
      () => validateFrom("FROM node:20\nCOPY --from=${MISSING} /x /y\n"),
      "invalid_from",
    );
  });

  it("validates RUN --mount from= images, aliases, and context", () => {
    expect(() =>
      validateFrom(
        "FROM node:20 AS builder\nFROM node:20\nRUN --mount=type=bind,from=builder,target=/x true\n",
      ),
    ).not.toThrow();
    expect(() =>
      validateFrom("FROM node:20\nRUN --mount=type=bind,from=node:20,target=/x true\n"),
    ).not.toThrow();
    expect(() =>
      validateFrom("FROM node:20\nRUN --mount=from=context,target=/x true\n"),
    ).not.toThrow();
    expectFromError(
      () =>
        validateFrom(
          'FROM node:20\nRUN --mount=type=bind,source="/tmp/a b",from=evil:1,target=/x true\n',
        ),
      "invalid_from",
    );
    expectFromError(
      () => validateFrom("FROM node:20\nRUN --mount=from,target=/x true\n"),
      "invalid_from",
    );
  });
});

describe("validateDockerfileFrom COPY and RUN mount sources", () => {
  it("validates COPY --from against prior stages, indices, and the allowlist", () => {
    const builderStage = "FROM node:20 AS builder\nFROM ${HANSE_BASE}\n";
    expect(() => validateFrom(`${builderStage}COPY --from=builder /x /y\n`)).not.toThrow();
    expect(() => validateFrom(`${builderStage}COPY --from builder /x /y\n`)).not.toThrow();
    expect(() => validateFrom(`${builderStage}COPY --from=BuIlDeR /x /y\n`)).not.toThrow();
    expect(() =>
      validateFrom(`FROM node:20 AS first\nFROM \${HANSE_BASE}\nCOPY --from=0 /x /y\n`),
    ).not.toThrow();
    expect(() => validateFrom(`FROM \${HANSE_BASE}\nCOPY --from=node:20 /x /y\n`)).not.toThrow();

    expectFromError(
      () => validateFrom(`${builderStage}COPY --from=evil:latest /x /y\n`),
      "invalid_from",
    );
    expectFromError(
      () => validateFrom(`FROM \${HANSE_BASE}\nCOPY --from=0 /x /y\n`),
      "invalid_from",
    );
    expectFromError(() => validateFrom(`FROM \${HANSE_BASE}\nCOPY --from /x /y\n`), "invalid_from");
  });

  it("validates RUN --mount from sources", () => {
    expect(() =>
      validateFrom(
        "FROM node:20 AS builder\nFROM ${HANSE_BASE}\nRUN --mount=type=bind,from=builder,target=/src true\n",
      ),
    ).not.toThrow();
    expect(() =>
      validateFrom("FROM ${HANSE_BASE}\nRUN --mount=type=bind,from=context,target=/src true\n"),
    ).not.toThrow();
    expect(() =>
      validateFrom("FROM ${HANSE_BASE}\nRUN --mount=type=bind,from=node:20,target=/src true\n"),
    ).not.toThrow();

    expectFromError(
      () =>
        validateFrom(
          "FROM ${HANSE_BASE}\nRUN --mount=type=bind,from=evil:latest,target=/src true\n",
        ),
      "invalid_from",
    );
    expectFromError(
      () => validateFrom("FROM ${HANSE_BASE}\nRUN --mount=type=bind,,from=builder true\n"),
      "invalid_from",
    );
    expectFromError(
      () => validateFrom("FROM ${HANSE_BASE}\nRUN --mount=type=bind,from= true\n"),
      "invalid_from",
    );
    expectFromError(() => validateFrom("FROM ${HANSE_BASE}\nRUN --mount true\n"), "invalid_from");
    expect(() => validateFrom("FROM ${HANSE_BASE}\nRUN --mount=target=/src true\n")).not.toThrow();
  });

  it("still accepts a normal multi-stage build with COPY --from=builder", () => {
    const dockerfile = [
      "ARG HANSE_BASE",
      "FROM node:20 AS builder",
      "RUN npm run build",
      "FROM ${HANSE_BASE}",
      "COPY --from=builder /app/dist /app/dist",
      "RUN --mount=type=cache,target=/root/.cache npm ci",
      "",
    ].join("\n");
    expect(() => validateFrom(dockerfile)).not.toThrow();
  });
});
