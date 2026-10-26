// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Dockerfile variable syntax is intentional
import { describe, expect, it } from "vitest";
import {
  BaseImageConfigError,
  isDigest,
  resolveBaseImage,
  resolveManifestDigest,
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
