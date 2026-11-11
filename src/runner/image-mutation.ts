/**
 * Process-wide serialization of operations that mutate the runner's image store.
 *
 * Builds are asynchronous: the HTTP handler returns `202` while Docker keeps building. The lease
 * therefore spans the whole build, not only the request, and is released by the build job in its
 * `finally`. Pulls, GC, and per-app purges hold the same mutex for their entire duration.
 *
 * Conflict semantics preserve the pre-existing contracts:
 * - build-vs-build and purge-vs-build keep `build_in_progress`;
 * - every other overlap (including any pull conflict) is `409 image_mutation_in_progress`.
 */

export type ImageMutationKind = "build" | "pull" | "gc" | "purge";

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
