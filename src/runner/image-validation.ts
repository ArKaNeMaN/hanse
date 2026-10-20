import { randomUUID } from "node:crypto";
import { boundedErrorMessage } from "../runtime/build-spec.js";
import type {
  DockerContainerCreateOptions,
  DockerContainerWait,
  DockerImageInspect,
  DockerLogs,
} from "./docker.js";

export const IMAGE_VALIDATION_TIMEOUT_MS = 30_000;
export const IMAGE_VALIDATION_MEMORY_BYTES = 256 * 1024 * 1024;
export const IMAGE_VALIDATION_NANO_CPUS = 500_000_000;
export const IMAGE_VALIDATION_PIDS_LIMIT = 64;
export const MAX_IMAGE_VALIDATION_LOG_BYTES = 16 * 1024;

const LOG_TAIL = 200;
const ERROR_DETAIL_CHARS = 400;
const VALIDATION_MARKER = "hanse image validation passed";

/**
 * Fixed probe run inside the built image. It only inspects the installed runtime surface; it does
 * not start opencode, the agent host, the MCP server, or any application code.
 */
export const IMAGE_VALIDATION_SCRIPT = String.raw`set -eu
fail() { printf 'incompatible image: %s\n' "$1" >&2; exit 1; }
test -x /usr/local/bin/hanse-agent-entrypoint || fail "missing /usr/local/bin/hanse-agent-entrypoint"
test -x /usr/local/bin/hanse || fail "missing /usr/local/bin/hanse"
command -v opencode >/dev/null 2>&1 || fail "missing opencode"
opencode --version >/dev/null 2>&1 || fail "opencode is not runnable"
if help_output=$(/usr/local/bin/hanse --help 2>&1); then
  case "$help_output" in
    *agent-host*) ;;
    *) fail "hanse CLI has no agent-host command" ;;
  esac
  case "$help_output" in
    *mcp*) ;;
    *) fail "hanse CLI has no MCP bridge" ;;
  esac
else
  fail "hanse CLI is not runnable"
fi
unset HANSE_MCP_API_BASE HANSE_AGENT_TOKEN_FILE HANSE_PROJECT_ID HANSE_APP_KEY HANSE_DB
if host_output=$(/usr/local/bin/hanse agent-host 2>&1); then
  fail "hanse agent-host started without a spec"
fi
case "$host_output" in
  *--spec*) ;;
  *) fail "hanse agent-host is not wired" ;;
esac
if mcp_output=$(/usr/local/bin/hanse mcp 2>&1); then
  fail "hanse mcp started without a coordinator context"
fi
case "$mcp_output" in
  *mcp:*) ;;
  *) fail "hanse MCP bridge is not wired" ;;
esac
git --version >/dev/null 2>&1 || fail "missing or broken git"
printf '${VALIDATION_MARKER}\n'
`;

export interface ImageValidationRuntime {
  inspectImage(reference: string): Promise<DockerImageInspect | undefined>;
  createContainer(options: DockerContainerCreateOptions): Promise<string>;
  startContainer(id: string): Promise<void>;
  waitContainer(id: string, timeoutMs?: number): Promise<DockerContainerWait>;
  logs(id: string, tail?: number): Promise<DockerLogs>;
  removeContainer(id: string, force?: boolean): Promise<void>;
}

export interface ImageValidationResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly logs: string;
}

export interface ImageValidationServiceOptions {
  readonly runtime: ImageValidationRuntime;
  readonly timeoutMs?: number;
}

export class ImageValidationService {
  readonly #runtime: ImageValidationRuntime;
  readonly #timeoutMs: number;

  constructor(options: ImageValidationServiceOptions) {
    this.#runtime = options.runtime;
    this.#timeoutMs = options.timeoutMs ?? IMAGE_VALIDATION_TIMEOUT_MS;
  }

  async validate(imageRef: string, appId?: string): Promise<ImageValidationResult> {
    let inspect: DockerImageInspect | undefined;
    try {
      inspect = await this.#runtime.inspectImage(imageRef);
    } catch (error) {
      return failure(`cannot inspect image ${imageRef}: ${errorMessage(error)}`);
    }
    if (inspect === undefined) {
      return failure(`image ${imageRef} is not present in the Docker daemon`);
    }

    // USER, ENTRYPOINT, and CMD are overridden explicitly by createContainer. Image-declared volumes
    // are different: Docker would create writable anonymous mounts inside the fixed envelope.
    const volumes = Object.keys(inspect.Config?.Volumes ?? {});
    if (volumes.length > 0) {
      return failure(
        `image declares VOLUME ${volumes.join(", ")}; image volumes cannot be overridden by the runner`,
      );
    }

    const name = validationContainerName(appId);
    let id: string | undefined;
    try {
      id = await this.#runtime.createContainer({
        name,
        image: imageRef,
        hostname: "hanse-validation",
        user: "1000:1000",
        entrypoint: ["/bin/sh", "-c"],
        cmd: [IMAGE_VALIDATION_SCRIPT],
        workingDir: "/tmp",
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: "/tmp/hanse-validation-home",
          TMPDIR: "/tmp",
          XDG_CACHE_HOME: "/tmp/hanse-validation-cache",
          LC_ALL: "C",
          LANG: "C",
        },
        labels: {
          "hanse.validation": "true",
          ...(appId === undefined ? {} : { "hanse.app.id": appId }),
        },
        binds: [],
        tmpfs: {
          "/tmp": "rw,nosuid,nodev,size=16m",
          "/run": "rw,nosuid,nodev,size=4m",
        },
        memoryBytes: IMAGE_VALIDATION_MEMORY_BYTES,
        nanoCpus: IMAGE_VALIDATION_NANO_CPUS,
        pidsLimit: IMAGE_VALIDATION_PIDS_LIMIT,
        networkName: "none",
        networkAliases: [],
        networkMode: "none",
        restartPolicy: "no",
      });
      await this.#runtime.startContainer(id);
      const wait = await this.#runtime.waitContainer(id, this.#timeoutMs);
      const logs = boundLogs((await this.#runtime.logs(id, LOG_TAIL)).logs);
      if (wait.Error?.Message !== undefined) {
        return failure(`image validation failed: ${wait.Error.Message}`, logs);
      }
      const exitCode = wait.StatusCode ?? 0;
      if (exitCode !== 0) {
        return failure(`image validation exited with code ${exitCode}`, logs);
      }
      if (!logs.includes(VALIDATION_MARKER)) {
        return failure("image validation did not complete all checks", logs);
      }
      return { ok: true, error: null, logs };
    } catch (error) {
      const message = errorMessage(error);
      if (/timed out|timeout/i.test(message)) {
        return failure(`image validation timed out after ${this.#timeoutMs}ms`);
      }
      return failure(`image validation failed: ${message}`);
    } finally {
      if (id !== undefined) {
        await this.#runtime.removeContainer(id, true).catch(() => undefined);
      }
    }
  }
}

function validationContainerName(appId: string | undefined): string {
  const safe = (appId ?? "image").replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 32);
  return `hanse-validate-${safe}-${randomUUID().slice(0, 8)}`;
}

function failure(message: string, logs = ""): ImageValidationResult {
  const detail = logs.trim();
  const boundedDetail =
    detail.length <= ERROR_DETAIL_CHARS
      ? detail
      : `...${detail.slice(detail.length - (ERROR_DETAIL_CHARS - 3))}`;
  const raw = boundedDetail.length === 0 ? message : `${message}: ${boundedDetail}`;
  return { ok: false, error: boundedErrorMessage(new Error(raw), 1000), logs };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundLogs(text: string): string {
  const sanitized = Array.from(text, (character) => {
    if (character === "\n" || character === "\t") return character;
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "" : character;
  }).join("");
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.length <= MAX_IMAGE_VALIDATION_LOG_BYTES) return sanitized;
  return `[logs truncated]\n${bytes.subarray(bytes.length - MAX_IMAGE_VALIDATION_LOG_BYTES).toString("utf8")}`;
}
