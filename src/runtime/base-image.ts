/**
 * Pure resolution of an application build's root base image.
 *
 * The coordinator never guesses: it follows the final Dockerfile stage to its single root external
 * `FROM` through stage aliases and ARG values. An unresolved or cyclic root is `unknown`, never a
 * fabricated base. The resolved kind/ref is used both for the build-spec hash (kind only) and for
 * base-drift comparisons (manifest digest, resolved separately in the image service).
 */

/** How the root base image was selected. `unknown` disables base-driven verdicts. */
export type BaseImageKind = "default" | "base" | "explicit" | "unknown";

/** Bounded configuration-error codes; the HTTP layer maps them directly. */
export type BaseImageConfigErrorCode = "base_mismatch" | "base_unavailable" | "base_arg_reserved";

/** A rejected base configuration (contradictory declaration, missing env, reserved arg). */
export class BaseImageConfigError extends Error {
  readonly code: BaseImageConfigErrorCode;

  constructor(code: BaseImageConfigErrorCode, message: string) {
    super(message);
    this.name = "BaseImageConfigError";
    this.code = code;
  }
}

export interface ResolveBaseImageInput {
  /** Raw Dockerfile bytes. */
  dockerfile: string | Uint8Array;
  /** Manifest `build.args`; they take precedence over Dockerfile ARG defaults. */
  args?: Record<string, string>;
  /** Optional `build.base` declaration. Absence enables the Dockerfile fallback. */
  declaredBase?: "default" | "base" | null;
  /** Configured default reference (`defaultImageReference()`, digest included). */
  defaultImage: string;
  /** Configured shared base reference (`HANSE_AGENT_BASE_IMAGE`), if any. */
  baseImage?: string | null;
}

export interface ResolvedBaseImage {
  kind: BaseImageKind;
  /** Resolved reference for `default`/`base`/`explicit`; null for `unknown`. */
  ref: string | null;
}

interface Stage {
  /** Raw image token (variables not expanded), without `--platform` and the `AS` alias. */
  image: string;
  alias: string | null;
  /** Arguments visible when this stage's FROM was parsed. */
  args: ReadonlyMap<string, string>;
}

interface Expansion {
  value: string;
  referencesBase: boolean;
  unresolved: boolean;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** True for a valid `sha256:<64 hex>` manifest/image identity. */
export function isDigest(value: string | null | undefined): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

/**
 * Reconstruct the legacy v1 hash input reference.
 *
 * The pre-v2 coordinator stored everything after `@` for a digest-pinned default reference. Such a
 * value cannot be reconstructed into the historical reference/tag, so it is `null` (unknown).
 * A full legacy reference is returned unchanged.
 */
export function legacyV1BaseReference(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  const value = stored.trim();
  if (value.length === 0 || isDigest(value)) return null;
  if (/\s/.test(value)) return null;
  return value;
}

/**
 * Resolve a manifest digest from a local image's `RepoDigests`.
 *
 * An explicit `@sha256` in the reference wins. Otherwise exactly one distinct digest whose
 * repository matches the reference repository is required; anything else is unknown.
 */
export function resolveManifestDigest(
  reference: string,
  repoDigests: readonly string[] | null | undefined,
): string | null {
  const explicit = digestFromReference(reference);
  if (explicit !== null) return explicit;
  const repository = repositoryOf(reference);
  const matches = new Set<string>();
  for (const entry of repoDigests ?? []) {
    if (typeof entry !== "string") continue;
    const at = entry.indexOf("@");
    if (at <= 0) continue;
    if (entry.slice(0, at) !== repository) continue;
    const digest = entry.slice(at + 1);
    if (DIGEST.test(digest)) matches.add(digest);
  }
  return matches.size === 1 ? (matches.values().next().value ?? null) : null;
}

function digestFromReference(reference: string): string | null {
  const at = reference.indexOf("@");
  if (at < 0) return null;
  const digest = reference.slice(at + 1);
  return DIGEST.test(digest) ? digest : null;
}

function repositoryOf(reference: string): string {
  const withoutDigest = reference.split("@")[0] ?? reference;
  const colon = withoutDigest.lastIndexOf(":");
  const slash = withoutDigest.lastIndexOf("/");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

/**
 * Resolve the base image kind/reference for a build.
 *
 * Throws {@link BaseImageConfigError} for a contradictory `build.base`, a `base` declaration with no
 * configured base reference, or a manifest `HANSE_BASE` argument.
 */
export function resolveBaseImage(input: ResolveBaseImageInput): ResolvedBaseImage {
  const manifestArgs = input.args ?? {};
  if (Object.hasOwn(manifestArgs, "HANSE_BASE")) {
    throw new BaseImageConfigError(
      "base_arg_reserved",
      "build.args must not set HANSE_BASE; the base image is coordinator-owned",
    );
  }
  if (input.declaredBase === "base" && !hasText(input.baseImage)) {
    throw new BaseImageConfigError(
      "base_unavailable",
      "build.base is base but HANSE_AGENT_BASE_IMAGE is not configured",
    );
  }

  const dockerfile =
    typeof input.dockerfile === "string"
      ? input.dockerfile
      : Buffer.from(input.dockerfile).toString("utf8");
  const stages = parseStages(dockerfile);
  if (stages.length === 0) {
    return { kind: "unknown", ref: null };
  }

  const final = stages[stages.length - 1] as Stage;
  const root = followRoot(final, stages, manifestArgs);
  if (root === null) {
    return { kind: "unknown", ref: null };
  }

  const expansion = expandToken(root.image, root.args, manifestArgs, new Set());
  if (expansion.referencesBase) {
    const kind = input.declaredBase ?? "default";
    return {
      kind,
      ref: kind === "base" ? (input.baseImage?.trim() ?? null) : input.defaultImage.trim(),
    };
  }
  if (expansion.unresolved) {
    return { kind: "unknown", ref: null };
  }

  if (input.declaredBase !== undefined && input.declaredBase !== null) {
    throw new BaseImageConfigError(
      "base_mismatch",
      `build.base is ${input.declaredBase} but the Dockerfile root FROM does not use HANSE_BASE`,
    );
  }
  const literal = expansion.value.trim();
  if (literal.length === 0) {
    return { kind: "unknown", ref: null };
  }
  return { kind: "explicit", ref: literal };
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Follow a stage alias chain to the root external stage. `null` means cyclic/unresolved alias. */
function followRoot(
  stage: Stage,
  stages: readonly Stage[],
  manifestArgs: Record<string, string>,
): Stage | null {
  const aliases = new Map<string, Stage>();
  for (const candidate of stages) {
    if (candidate.alias !== null) {
      aliases.set(candidate.alias.toLowerCase(), candidate);
    }
  }
  const seen = new Set<Stage>();
  let current = stage;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const expanded = expandToken(current.image, current.args, manifestArgs, new Set());
    if (expanded.referencesBase || expanded.unresolved) {
      return current;
    }
    const target = aliases.get(expanded.value.trim().toLowerCase());
    if (target === undefined) {
      return current;
    }
    current = target;
  }
}

/** Split instructions into logical lines and collect FROM stages with their visible ARG map. */
function parseStages(text: string): Stage[] {
  const stages: Stage[] = [];
  const globalArgs = new Map<string, string>();
  let pendingArgs = new Map<string, string>();
  let sawFrom = false;

  for (const line of logicalLines(text)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const space = trimmed.search(/\s/);
    const keyword = (space < 0 ? trimmed : trimmed.slice(0, space)).toUpperCase();
    const rest = space < 0 ? "" : trimmed.slice(space).trim();

    if (keyword === "ARG") {
      const [key, ...valueParts] = rest.split("=");
      const name = key?.trim() ?? "";
      if (!VARIABLE_NAME.test(name)) continue;
      const value = valueParts.length === 0 ? undefined : valueParts.join("=").trim();
      const target = sawFrom ? pendingArgs : globalArgs;
      if (value !== undefined && value.length > 0) {
        target.set(name, value);
      } else {
        target.delete(name);
      }
      continue;
    }

    if (keyword !== "FROM") continue;
    sawFrom = true;
    const visible = new Map<string, string>([...globalArgs, ...pendingArgs]);
    const tokens = rest.split(/\s+/).filter((token) => token.length > 0);
    const imageIndex = tokens.findIndex((token) => !token.startsWith("--"));
    if (imageIndex < 0) {
      pendingArgs = new Map();
      continue;
    }
    const image = tokens[imageIndex] ?? "";
    const maybeAs = tokens[imageIndex + 1]?.toUpperCase();
    const alias = maybeAs === "AS" ? (tokens[imageIndex + 2] ?? null) : null;
    stages.push({ image, alias, args: visible });
    pendingArgs = new Map();
  }
  return stages;
}

/** Join Dockerfile continuation lines (`\` at end of line) and drop comment-only lines. */
function logicalLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let buffer = "";
  for (const raw of lines) {
    const line = raw.replace(/\\\s*$/, "");
    buffer = buffer.length === 0 ? line : `${buffer}\n${line}`;
    if (line !== raw) {
      continue;
    }
    result.push(buffer);
    buffer = "";
  }
  if (buffer.length > 0) result.push(buffer);
  return result;
}

function expandToken(
  token: string,
  dockerArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  stack: Set<string>,
): Expansion {
  let value = "";
  let referencesBase = false;
  let unresolved = false;
  let index = 0;
  while (index < token.length) {
    const char = token[index];
    if (char !== "$") {
      value += char;
      index += 1;
      continue;
    }
    const next = token[index + 1];
    if (next === "{") {
      const end = token.indexOf("}", index + 2);
      if (end < 0) {
        unresolved = true;
        index += 1;
        continue;
      }
      const inner = token.slice(index + 2, end);
      const expanded = expandBraced(inner, dockerArgs, manifestArgs, stack);
      value += expanded.value;
      referencesBase ||= expanded.referencesBase;
      unresolved ||= expanded.unresolved;
      index = end + 1;
      continue;
    }
    const match = token.slice(index + 1).match(VARIABLE_NAME);
    if (match === null) {
      value += "$";
      index += 1;
      continue;
    }
    const expanded = expandVariable(match[0], dockerArgs, manifestArgs, stack);
    value += expanded.value;
    referencesBase ||= expanded.referencesBase;
    unresolved ||= expanded.unresolved;
    index += 1 + match[0].length;
  }
  return { value, referencesBase, unresolved };
}

function expandBraced(
  inner: string,
  dockerArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  stack: Set<string>,
): Expansion {
  const defaultIndex = inner.indexOf(":-");
  if (defaultIndex >= 0) {
    const name = inner.slice(0, defaultIndex);
    const fallback = inner.slice(defaultIndex + 2);
    const resolved = lookup(name, dockerArgs, manifestArgs, stack);
    if (resolved.value !== null && resolved.value.length > 0) {
      return resolved;
    }
    const expandedFallback = expandToken(fallback, dockerArgs, manifestArgs, stack);
    return {
      value: expandedFallback.value,
      referencesBase: resolved.referencesBase || expandedFallback.referencesBase,
      unresolved: expandedFallback.unresolved,
    };
  }
  if (!VARIABLE_NAME.test(inner)) {
    return { value: "", referencesBase: false, unresolved: true };
  }
  return lookup(inner, dockerArgs, manifestArgs, stack);
}

function lookup(
  name: string,
  dockerArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  stack: Set<string>,
): Expansion {
  if (name === "HANSE_BASE") {
    return { value: name, referencesBase: true, unresolved: false };
  }
  if (stack.has(name)) {
    return { value: "", referencesBase: false, unresolved: true };
  }
  const raw = Object.hasOwn(manifestArgs, name) ? manifestArgs[name] : dockerArgs.get(name);
  if (raw === undefined) {
    return { value: "", referencesBase: false, unresolved: true };
  }
  const next = new Set(stack);
  next.add(name);
  const expanded = expandToken(raw, dockerArgs, manifestArgs, next);
  return {
    value: expanded.value,
    referencesBase: expanded.referencesBase,
    unresolved: expanded.unresolved,
  };
}

function expandVariable(
  name: string,
  dockerArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  stack: Set<string>,
): Expansion {
  return lookup(name, dockerArgs, manifestArgs, stack);
}
