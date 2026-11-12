/**
 * Process-wide serialization of operations that mutate the runner's image store.
 *
 * Builds are asynchronous: the HTTP handler returns `202` while Docker keeps building. The lease
 * therefore spans the whole build, not only the request, and is released by the build job in its
 * `finally`. Pulls and builds hold the mutex for their entire duration; GC and per-app purges also
 * take it so a removal never overlaps a pull or build.
 *
 * `ImageGate` is the reader-writer gate in front of the mutex: GC/purge are exclusive while
 * create/build/pull are shared, so a create does not wait for a long build. Mutex conflict
 * semantics are unchanged for the operations that still reach it:
 * - build-vs-build keeps `build_in_progress`;
 * - every other overlap (including any pull conflict) is `409 image_mutation_in_progress`.
 */

export type ImageMutationKind = "build" | "pull" | "gc" | "purge" | "create";

/** Thrown when another image mutation already holds the shared lease. */
export class ImageMutationConflictError extends Error {
  readonly status = 409;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImageMutationConflictError";
    this.code = code;
  }
}

/** An acquired lease; `release` is idempotent and must run in a `finally`. */
export interface ImageMutationLease {
  release(): void;
}

const BUILD_IN_PROGRESS = "build_in_progress";
const MUTATION_IN_PROGRESS = "image_mutation_in_progress";

function conflict(holder: ImageMutationKind, requested: ImageMutationKind): never {
  if (
    (requested === "build" && (holder === "build" || holder === "purge")) ||
    (requested === "purge" && holder === "build")
  ) {
    throw new ImageMutationConflictError(BUILD_IN_PROGRESS, "another image build is in progress");
  }
  throw new ImageMutationConflictError(
    MUTATION_IN_PROGRESS,
    "another image operation is in progress",
  );
}

/** Shared, non-queuing lease guard for builds, pulls, GC, and purges. */
export class ImageMutationMutex {
  #holder: ImageMutationKind | undefined;

  /** The current holder, exposed for diagnostics and focused tests. */
  get holder(): ImageMutationKind | undefined {
    return this.#holder;
  }

  get busy(): boolean {
    return this.#holder !== undefined;
  }

  /** Acquire or throw a typed conflict; the caller owns the returned lease. */
  tryAcquire(kind: ImageMutationKind): ImageMutationLease {
    const holder = this.#holder;
    if (holder !== undefined) conflict(holder, kind);
    this.#holder = kind;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.#holder === kind) this.#holder = undefined;
      },
    };
  }
}

const EXCLUSIVE_GATE_KINDS: ReadonlySet<ImageMutationKind> = new Set(["gc", "purge"]);

/**
 * Reader-writer gate for image data.
 *
 * GC and per-app purges are exclusive; creates, builds, and pulls share the gate. A create can
 * therefore proceed while a long build holds its shared lease, while GC cannot start until every
 * shared lease is released. Conflicts are immediate (no queueing) and always map to
 * `409 image_mutation_in_progress`.
 */
export class ImageGate {
  readonly #shared = new Map<ImageMutationKind, number>();
  #exclusive: ImageMutationKind | undefined;

  /** The current exclusive holder, exposed for diagnostics and focused tests. */
  get exclusiveHolder(): ImageMutationKind | undefined {
    return this.#exclusive;
  }

  get sharedCount(): number {
    let count = 0;
    for (const leases of this.#shared.values()) count += leases;
    return count;
  }

  tryShared(kind: ImageMutationKind): ImageMutationLease {
    if (EXCLUSIVE_GATE_KINDS.has(kind)) {
      throw new Error(`image gate kind ${kind} must use tryExclusive`);
    }
    if (this.#exclusive !== undefined) {
      throw new ImageMutationConflictError(
        MUTATION_IN_PROGRESS,
        "an image GC or purge is in progress",
      );
    }
    const leases = this.#shared.get(kind) ?? 0;
    this.#shared.set(kind, leases + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const current = this.#shared.get(kind) ?? 0;
        if (current <= 1) this.#shared.delete(kind);
        else this.#shared.set(kind, current - 1);
      },
    };
  }

  tryExclusive(kind: ImageMutationKind): ImageMutationLease {
    if (!EXCLUSIVE_GATE_KINDS.has(kind)) {
      throw new Error(`image gate kind ${kind} must use tryShared`);
    }
    if (this.#exclusive !== undefined || this.#shared.size > 0) {
      throw new ImageMutationConflictError(
        MUTATION_IN_PROGRESS,
        "another image operation is in progress",
      );
    }
    this.#exclusive = kind;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.#exclusive === kind) this.#exclusive = undefined;
      },
    };
  }
}
