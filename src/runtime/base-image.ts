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

/** Bounded build-Dockerfile validation failures; the runner maps them to a 400 build error. */
export type DockerfileBuildErrorCode =
  | "invalid_from"
  | "invalid_dockerfile"
  | "invalid_run_network";

/** A Dockerfile that cannot be safely built under the allowlist/network policy. */
export class DockerfileBuildError extends Error {
  readonly code: DockerfileBuildErrorCode;

  constructor(code: DockerfileBuildErrorCode, message: string) {
    super(message);
    this.name = "DockerfileBuildError";
    this.code = code;
  }
}

/** Input for {@link validateDockerfileFrom}. */
export interface ValidateDockerfileFromInput {
  /** Raw Dockerfile bytes. Must be the exact bytes that enter the build context. */
  dockerfile: string | Uint8Array;
  /** Normalized exact external image references allowed in any stage's `FROM`. */
  allowedImages: ReadonlySet<string>;
  /** Validated build args; they take precedence over Dockerfile ARG defaults. */
  args?: Record<string, string>;
  /** Normalized runner-injected `HANSE_BASE` reference. */
  baseImage: string;
  /** Normalize an expanded image token (defaults to whitespace trimming). */
  normalize?: (value: string) => string | undefined;
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

/**
 * Validate every `FROM`, `COPY --from`, `RUN --mount from=` and `RUN --network` in a Dockerfile.
 *
 * Every external image token must be exactly allowlisted, `scratch`, or a previously defined stage
 * alias/index (case-insensitive); `RUN --mount from=context` is allowed. Unknown variables,
 * malformed instructions/options, malformed escape directives, and `RUN --network=host`/
 * `container:...` fail closed.
 */
export function validateDockerfileFrom(input: ValidateDockerfileFromInput): void {
  const text =
    typeof input.dockerfile === "string"
      ? input.dockerfile
      : Buffer.from(input.dockerfile).toString("utf8");
  const instructions = parseInstructions(text);
  if (!instructions.some((instruction) => instruction.keyword === "FROM")) {
    throw new DockerfileBuildError("invalid_dockerfile", "Dockerfile has no FROM instruction");
  }

  const manifestArgs = input.args ?? {};
  const globalArgs = new Map<string, string>();
  const aliases = new Set<string>();
  let pendingArgs = new Map<string, string>();
  let currentStageArgs = new Map<string, string>();
  let sawFrom = false;
  let currentStage = -1;

  for (const instruction of instructions) {
    if (instruction.keyword === "ARG") {
      applyArg(instruction.rest, sawFrom ? pendingArgs : globalArgs);
      if (sawFrom) {
        applyArg(instruction.rest, currentStageArgs);
      }
      continue;
    }

    if (instruction.keyword === "FROM") {
      sawFrom = true;
      const visible = new Map<string, string>([...globalArgs, ...pendingArgs]);
      pendingArgs = new Map();
      const parsed = parseFrom(instruction.rest);
      if (parsed === null) {
        throw new DockerfileBuildError(
          "invalid_dockerfile",
          `invalid FROM instruction: ${instruction.rest}`,
        );
      }
      currentStage += 1;
      currentStageArgs = visible;
      validateFromImage(parsed.image, visible, manifestArgs, aliases, currentStage, input);
      if (parsed.alias !== null) {
        if (!STAGE_ALIAS.test(parsed.alias)) {
          throw new DockerfileBuildError(
            "invalid_dockerfile",
            `invalid build stage alias: ${parsed.alias}`,
          );
        }
        aliases.add(parsed.alias.toLowerCase());
      }
      continue;
    }

    if (instruction.keyword === "COPY") {
      validateCopyOptions(
        instruction.rest,
        aliases,
        currentStage,
        currentStageArgs,
        manifestArgs,
        input,
      );
      continue;
    }

    if (instruction.keyword === "RUN") {
      validateRunOptions(
        instruction.rest,
        aliases,
        currentStage,
        currentStageArgs,
        manifestArgs,
        input,
      );
    }
  }
}

function validateFromImage(
  image: string,
  stageArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  aliases: ReadonlySet<string>,
  currentStage: number,
  input: ValidateDockerfileFromInput,
): void {
  const expansion = expandToken(image, stageArgs, manifestArgs, new Set(), input.baseImage);
  if (expansion.unresolved) {
    throw new DockerfileBuildError("invalid_from", `unresolved build variable in FROM: ${image}`);
  }
  assertAllowedImage(expansion.value.trim(), aliases, currentStage, input, false);
}

function validateCopyOptions(
  rest: string,
  aliases: ReadonlySet<string>,
  currentStage: number,
  stageArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  input: ValidateDockerfileFromInput,
): void {
  for (const option of leadingOptions(rest)) {
    if (option.name !== "from") continue;
    if (option.value === undefined || option.value.trim().length === 0) {
      throw new DockerfileBuildError("invalid_from", "COPY --from requires an image or stage");
    }
    assertAllowedImage(
      expandImageOption(option.value, stageArgs, manifestArgs, input, "COPY --from"),
      aliases,
      currentStage,
      input,
      false,
    );
  }
}

function validateRunOptions(
  rest: string,
  aliases: ReadonlySet<string>,
  currentStage: number,
  stageArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  input: ValidateDockerfileFromInput,
): void {
  for (const option of leadingOptions(rest)) {
    if (option.name === "network") {
      validateRunNetworkValue(option.value);
      continue;
    }
    if (option.name !== "mount") continue;
    validateMountSpec(option.value, aliases, currentStage, stageArgs, manifestArgs, input);
  }
}

function expandImageOption(
  value: string,
  stageArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  input: ValidateDockerfileFromInput,
  label: string,
): string {
  const expansion = expandToken(value, stageArgs, manifestArgs, new Set(), input.baseImage);
  if (expansion.unresolved) {
    throw new DockerfileBuildError(
      "invalid_from",
      `unresolved build variable in ${label}: ${display(value)}`,
    );
  }
  return expansion.value.trim();
}

function display(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}...` : value;
}

interface InstructionOption {
  readonly name: string;
  readonly value: string | undefined;
}

/**
 * Split an instruction into shell-like tokens so quoted option values (for example a mount source
 * containing spaces) cannot hide a later `from=` option from the validator.
 */
function shellTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"') {
        escaped = true;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Parse only the leading `--flag[=value]` options; the command/arguments are never inspected. */
function leadingOptions(rest: string): InstructionOption[] {
  const tokens = shellTokens(rest);
  const options: InstructionOption[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || !token.startsWith("--")) break;
    const equals = token.indexOf("=");
    if (equals >= 0) {
      options.push({ name: token.slice(2, equals).toLowerCase(), value: token.slice(equals + 1) });
      index += 1;
      continue;
    }
    const next = tokens[index + 1];
    const takesValue = next !== undefined && !next.startsWith("--");
    options.push({
      name: token.slice(2).toLowerCase(),
      value: takesValue ? next : undefined,
    });
    index += takesValue ? 2 : 1;
  }
  return options;
}

function assertAllowedImage(
  value: string,
  aliases: ReadonlySet<string>,
  currentStage: number,
  input: ValidateDockerfileFromInput,
  allowContext: boolean,
): void {
  if (allowContext && value.toLowerCase() === "context") return;
  const normalized = input.normalize === undefined ? value : input.normalize(value);
  if (normalized === undefined || normalized.length === 0) {
    throw new DockerfileBuildError("invalid_from", `invalid image reference: ${value}`);
  }
  if (!isAllowedStageImage(normalized, aliases, currentStage, input.allowedImages)) {
    throw new DockerfileBuildError(
      "invalid_from",
      `image is not allowed by the runner: ${normalized}`,
    );
  }
}

function isAllowedStageImage(
  value: string,
  aliases: ReadonlySet<string>,
  currentStage: number,
  allowedImages: ReadonlySet<string>,
): boolean {
  const lower = value.toLowerCase();
  if (lower === "scratch" || aliases.has(lower)) return true;
  if (/^\d+$/.test(value) && Number(value) < currentStage) return true;
  return allowedImages.has(value);
}

function validateMountSpec(
  spec: string | undefined,
  aliases: ReadonlySet<string>,
  currentStage: number,
  stageArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  input: ValidateDockerfileFromInput,
): void {
  if (spec === undefined || spec.trim().length === 0) {
    throw new DockerfileBuildError("invalid_from", "RUN --mount requires a mount specification");
  }
  for (const rawSegment of spec.split(",")) {
    const segment = rawSegment.trim();
    if (segment.length === 0) {
      throw new DockerfileBuildError("invalid_from", "malformed RUN --mount specification");
    }
    const equals = segment.indexOf("=");
    if (equals < 0) {
      // Only known boolean mount flags may omit `=`. Anything else (a bare `from`, `type`, or a
      // random token) is malformed and must fail closed.
      const flag = segment.toLowerCase();
      if (flag !== "readonly" && flag !== "ro" && flag !== "rw") {
        throw new DockerfileBuildError("invalid_from", "malformed RUN --mount specification");
      }
      continue;
    }
    const key = segment.slice(0, equals).trim().toLowerCase();
    if (key.length === 0) {
      throw new DockerfileBuildError("invalid_from", "malformed RUN --mount specification");
    }
    const value = segment.slice(equals + 1).trim();
    if (key === "type") {
      if (value.length === 0) {
        throw new DockerfileBuildError("invalid_from", "malformed RUN --mount specification");
      }
      continue;
    }
    if (key !== "from") continue;
    if (value.length === 0) {
      throw new DockerfileBuildError("invalid_from", "RUN --mount from= requires a value");
    }
    assertAllowedImage(
      expandImageOption(value, stageArgs, manifestArgs, input, "RUN --mount from"),
      aliases,
      currentStage,
      input,
      true,
    );
  }
}

function validateRunNetworkValue(value: string | undefined): void {
  if (value === undefined || value.length === 0) {
    throw new DockerfileBuildError("invalid_run_network", "RUN --network requires a network value");
  }
  const lowered = value.toLowerCase();
  if (lowered === "host" || lowered.startsWith("container:")) {
    throw new DockerfileBuildError("invalid_run_network", `RUN --network=${value} is not allowed`);
  }
  if (lowered !== "default" && lowered !== "none") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
      throw new DockerfileBuildError(
        "invalid_run_network",
        `RUN --network value is not a valid network name: ${value}`,
      );
    }
  }
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

interface Instruction {
  readonly keyword: string;
  readonly rest: string;
}

interface Heredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

const PARSER_DIRECTIVE = /^\s*#\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(\S+)\s*$/;
const HEREDOC_KEYWORDS = new Set(["RUN", "COPY", "ADD"]);
const STAGE_ALIAS = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Split instructions into logical lines and collect FROM stages with their visible ARG map. */
function parseStages(text: string): Stage[] {
  return stagesFromInstructions(parseInstructions(text));
}

function stagesFromInstructions(instructions: readonly Instruction[]): Stage[] {
  const stages: Stage[] = [];
  const globalArgs = new Map<string, string>();
  let pendingArgs = new Map<string, string>();
  let sawFrom = false;

  for (const instruction of instructions) {
    if (instruction.keyword === "ARG") {
      applyArg(instruction.rest, sawFrom ? pendingArgs : globalArgs);
      continue;
    }

    if (instruction.keyword !== "FROM") continue;
    sawFrom = true;
    const visible = new Map<string, string>([...globalArgs, ...pendingArgs]);
    const parsed = parseFrom(instruction.rest);
    if (parsed === null) {
      pendingArgs = new Map();
      continue;
    }
    stages.push({ image: parsed.image, alias: parsed.alias, args: visible });
    pendingArgs = new Map();
  }
  return stages;
}

function applyArg(rest: string, target: Map<string, string>): void {
  const [key, ...valueParts] = rest.split("=");
  const name = key?.trim() ?? "";
  if (!VARIABLE_NAME.test(name)) return;
  const value = valueParts.length === 0 ? undefined : valueParts.join("=").trim();
  if (value !== undefined && value.length > 0) {
    target.set(name, value);
  } else {
    target.delete(name);
  }
}

function parseFrom(rest: string): { image: string; alias: string | null } | null {
  const tokens = rest.split(/\s+/).filter((token) => token.length > 0);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || !token.startsWith("--")) break;
    index += token === "--platform" ? 2 : 1;
  }
  const image = tokens[index];
  if (image === undefined) return null;
  const maybeAs = tokens[index + 1]?.toUpperCase();
  const alias = maybeAs === "AS" ? (tokens[index + 2] ?? null) : null;
  return { image, alias };
}

function parseInstructions(text: string): Instruction[] {
  const result: Instruction[] = [];
  for (const line of instructionLines(text)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.search(/\s/);
    const keyword = (space < 0 ? trimmed : trimmed.slice(0, space)).toUpperCase();
    const rest = space < 0 ? "" : trimmed.slice(space).trim();
    result.push({ keyword, rest });
  }
  return result;
}

/** Return the escape character declared by leading parser directives; a non-`\` escape fails. */
function readEscapeDirective(lines: readonly string[]): string {
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith("#")) break;
    const match = PARSER_DIRECTIVE.exec(raw);
    if (match === null) break;
    if (match[1]?.toLowerCase() !== "escape") continue;
    const value = match[2];
    if (value !== "\\") {
      throw new DockerfileBuildError(
        "invalid_dockerfile",
        `unsupported Dockerfile escape directive: ${value ?? ""}`,
      );
    }
    return value;
  }
  return "\\";
}

/** Remove a trailing continuation escape and report whether the line continues. */
function stripContinuation(line: string, escapeChar: string): { text: string; continued: boolean } {
  const trimmed = line.replace(/\s+$/, "");
  if (!trimmed.endsWith(escapeChar)) return { text: line, continued: false };
  return { text: trimmed.slice(0, -escapeChar.length), continued: true };
}

function heredocDelimiters(instruction: string): Heredoc[] {
  const space = instruction.search(/\s/);
  const keyword = (space < 0 ? instruction : instruction.slice(0, space)).toUpperCase();
  if (!HEREDOC_KEYWORDS.has(keyword)) return [];
  const delimiters: Heredoc[] = [];
  let quote: string | null = null;
  for (let index = 0; index < instruction.length; index += 1) {
    const char = instruction[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "<" || instruction[index + 1] !== "<") continue;
    let cursor = index + 2;
    let stripTabs = false;
    if (instruction[cursor] === "-") {
      stripTabs = true;
      cursor += 1;
    }
    while (instruction[cursor] === " " || instruction[cursor] === "\t") cursor += 1;
    let delimiter = "";
    const delimiterQuote = instruction[cursor];
    if (delimiterQuote === "'" || delimiterQuote === '"') {
      cursor += 1;
      while (cursor < instruction.length && instruction[cursor] !== delimiterQuote) {
        delimiter += instruction[cursor] ?? "";
        cursor += 1;
      }
      if (instruction[cursor] === delimiterQuote) cursor += 1;
    } else {
      while (cursor < instruction.length && /[A-Za-z0-9_.-]/.test(instruction[cursor] ?? "")) {
        delimiter += instruction[cursor] ?? "";
        cursor += 1;
      }
    }
    if (delimiter.length === 0) continue;
    delimiters.push({ delimiter, stripTabs });
    index = cursor - 1;
  }
  return delimiters;
}

/** Build logical instruction lines, honoring `# escape=`, comments/continuations and heredocs. */
function instructionLines(text: string): string[] {
  const rawLines = text.split(/\r?\n/);
  const escapeChar = readEscapeDirective(rawLines);
  const result: string[] = [];
  let index = 0;

  while (index < rawLines.length) {
    while (index < rawLines.length) {
      const candidate = rawLines[index];
      if (candidate === undefined) break;
      const trimmed = candidate.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("#")) break;
      index += 1;
    }
    if (index >= rawLines.length) break;

    const parts: string[] = [];
    let current: string | undefined = rawLines[index];
    index += 1;
    while (current !== undefined) {
      const { text: stripped, continued } = stripContinuation(current, escapeChar);
      parts.push(stripped);
      if (!continued) break;
      do {
        current = rawLines[index];
        index += 1;
      } while (
        current !== undefined &&
        (current.trim().length === 0 || current.trim().startsWith("#"))
      );
    }

    const logical = parts.join("\n");
    result.push(logical);
    for (const heredoc of heredocDelimiters(logical)) {
      let closed = false;
      while (index < rawLines.length) {
        const bodyLine = rawLines[index] ?? "";
        index += 1;
        const candidate = heredoc.stripTabs ? bodyLine.replace(/^\t+/, "") : bodyLine;
        if (candidate === heredoc.delimiter) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new DockerfileBuildError(
          "invalid_dockerfile",
          `unterminated heredoc: ${heredoc.delimiter}`,
        );
      }
    }
  }
  return result;
}

function expandToken(
  token: string,
  dockerArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  stack: Set<string>,
  baseValue?: string,
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
      const expanded = expandBraced(inner, dockerArgs, manifestArgs, stack, baseValue);
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
    const expanded = expandVariable(match[0], dockerArgs, manifestArgs, stack, baseValue);
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
  baseValue?: string,
): Expansion {
  const defaultIndex = inner.indexOf(":-");
  if (defaultIndex >= 0) {
    const name = inner.slice(0, defaultIndex);
    const fallback = inner.slice(defaultIndex + 2);
    const resolved = lookup(name, dockerArgs, manifestArgs, stack, baseValue);
    if (resolved.value !== null && resolved.value.length > 0) {
      return resolved;
    }
    const expandedFallback = expandToken(fallback, dockerArgs, manifestArgs, stack, baseValue);
    return {
      value: expandedFallback.value,
      referencesBase: resolved.referencesBase || expandedFallback.referencesBase,
      unresolved: expandedFallback.unresolved,
    };
  }
  if (!VARIABLE_NAME.test(inner)) {
    return { value: "", referencesBase: false, unresolved: true };
  }
  return lookup(inner, dockerArgs, manifestArgs, stack, baseValue);
}

function lookup(
  name: string,
  dockerArgs: ReadonlyMap<string, string>,
  manifestArgs: Record<string, string>,
  stack: Set<string>,
  baseValue?: string,
): Expansion {
  if (name === "HANSE_BASE") {
    return {
      value: baseValue ?? name,
      referencesBase: true,
      unresolved: false,
    };
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
  const expanded = expandToken(raw, dockerArgs, manifestArgs, next, baseValue);
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
  baseValue?: string,
): Expansion {
  return lookup(name, dockerArgs, manifestArgs, stack, baseValue);
}
