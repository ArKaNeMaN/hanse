# 0002 - Release image retention and prune for static Hanse images

Status: open
Created: 2026-10-26
Priority: medium (disk growth on long-running deployments)

## Problem

The existing image GC only manages per-application images: it matches `hanse-app-*` tags and the
`hanse.app.id` label, and protects current/previous/running app images. The five static release
images - coordinator, `hanse-agent-base`, `hanse-agent-default`, `hanse-agent-ide`, and
`hanse-runner` - are outside that scope.

Deployments therefore accumulate every old static image and every local retag (for example
`rollback-*` tags). On a long-running host this history becomes the largest consumer of Docker image
disk, while the current app-image GC reports the disk pressure but cannot free it.

## Goal

Add a safe, generic release-image retention command:

```bash
hanse images prune --scope release --keep-previous 2 --dry-run
hanse images prune --scope release --keep-previous 2 --apply
```

The command removes only old static Hanse images. It must be safe by default, work on any Hanse
deployment regardless of registry or host-specific tag naming, and remain separate from the existing
app-image GC.

## Non-goals

- Do not change or replace the existing app-image GC (`hanse-app-*` / `hanse.app.id`).
- Do not delete non-Hanse images.
- Do not delete containers or volumes.
- Do not add host-specific tag parsing or host-specific retention policy to the public repository.
- Do not make pruning automatic; callers must opt in with `--apply`.
- Do not prune the Docker build cache in this command; the existing app GC owns that.

## Image identification

Use OCI labels, not repository names:

- Static families are identified by `org.opencontainers.image.title` in:
  `hanse`, `hanse-agent-base`, `hanse-agent-default`, `hanse-agent-ide`, `hanse-runner`.
- Exclude any image with `hanse.app.id` (per-app image) and any tag starting `hanse-app-`.
- A release set is the set of static images sharing the same
  `org.opencontainers.image.revision` label (full commit SHA). This avoids depending on
  `rollback-*` or other caller-specific tag names.
- Images with a missing or `unknown` revision are not eligible for automatic deletion. Report them
  and keep them unless a future explicit override is added.
- If an image does not match the title allowlist, leave it alone even if its repository name looks
  like a Hanse image.

App images can inherit OCI labels from the base image they are built from, so the `hanse.app.id`
exclusion and the `hanse-app-*` exclusion are required, not optional.

## Retention and protection

Always protect:

- Every image referenced by any container, running or stopped (match by image ID and by tag).
- The current release revision, taken from `HANSE_REVISION` and/or the running containers.
- The last `--keep-previous N` previous revisions (default `2`; current is not counted).
- Any image named by a repeatable `--protect-ref`.
- Images with a missing/`unknown` revision.

For an old revision that is not protected:

- Remove all of its tags, including local `rollback-*` tags and local `sha-*` tags.
- Remove the image by tag; remove by ID only when it has no tags left.
- Do not use `docker rmi -f`; a removal conflict is a skip, not a failure of the whole run.
- Per-image protection wins: if one image in an old revision is used by a container, keep that image
  and remove the other eligible images in the same revision.

## Interface

### CLI

```text
hanse images prune --scope release [--keep-previous N] [--dry-run|--apply]
                   [--protect-ref REF]... [--json]
```

- `--scope release` is required for this feature. Leave room for future scopes; do not silently
  treat `release` as the existing app GC.
- `--dry-run` is the default and must make no changes.
- `--apply` performs the removals.
- `--json` prints a machine-readable report for deployment automation.
- The command runs inside the coordinator container (for example through `docker compose exec`) and
  uses the coordinator's runtime token to call the runner. It does not require the operator token
  and must not be exposed as an agent MCP tool.

### Runner

Add an internal route, for example:

```text
POST /v1/images/prune
{
  "scope": "release",
  "keepPrevious": 2,
  "currentRevision": "<full-sha>",
  "protectedRefs": ["..."],
  "dryRun": true
}
```

The runner remains the only Docker socket holder. It lists images and containers, inspects labels,
groups by revision, applies retention/protection, and removes images with the existing Docker client
primitives. The coordinator service computes `currentRevision`, `keepPrevious`, and
`protectedRefs`, checks the deployment lock, and serializes the operation with the app-image GC.

A human-only HTTP route or UI action can be added later on top of the same service; it is not
required for the first cut.

## Report

Return a report with at least:

- `dryRun`, `startedAt`, `finishedAt`;
- `currentRevision`, `keptRevisions`, `removedRevisions`;
- `removedImageIds`, `removedRefs`, `estimatedReclaimedBytes`;
- `skipped`: `{ ref, reason }` where reason covers `in_use`, `protected`, `unknown_revision`,
  `not_hanse`, `shared_tag`, `limit`;
- `truncated` for per-run limits.

`estimatedReclaimedBytes` is an estimate based on image sizes; shared layers mean the actual freed
space can be lower. Report the estimate as such.

## Deployment lock and serialization

- Refuse `--apply` while the deployment lock is active, using the existing
  `deployment_in_progress` semantics.
- Do not start image removal during an active deploy or while another image prune is running.
- Share the runner-side image-operation serialization with the existing app GC so two image
  mutations cannot run at once.
- Related gap: `ImageService.gc()` currently does not check the deployment lock. The new release
  prune must check it; fixing the existing GC is out of scope unless it is a small shared change.

## Tests

Add tests at the service/runner boundary using the existing fake Docker runtime patterns:

- groups static images by `org.opencontainers.image.revision`;
- keeps the current revision and the last N previous revisions;
- always keeps images referenced by running and stopped containers;
- excludes `hanse-app-*` images and images with `hanse.app.id`;
- leaves non-Hanse images untouched;
- skips images with missing/`unknown` revision;
- dry-run performs no removal and reports the same candidates;
- apply removes old tags/images without `-f` and reports skips;
- an active deployment lock blocks the operation;
- concurrent app GC and release prune serialize;
- CLI accepts the documented flags and rejects an unsupported scope.

## Docs

- Add a "Release image retention" section to `docs/deployment.md` after the app-image GC section:
  command examples, `--keep-previous` semantics, dry-run first, no automatic deletion, app images
  are separate, and the `unknown` revision caveat.
- State that deployment automation may invoke the command after a successful deploy; the public
  repository does not define a host-specific schedule or retention value.
- Update the current-state doc only if the feature changes the documented image lifecycle.

## Acceptance criteria

- `hanse images prune --scope release --keep-previous 2 --dry-run` lists candidates and changes
  nothing.
- `--apply` removes only old static Hanse images; the current revision, the last N previous
  revisions, every container image, all app images, and all non-Hanse images remain.
- An active deployment lock returns a stable `deployment_in_progress` error and makes no changes.
- The report distinguishes removed, kept, protected, in-use, unknown-revision, and non-Hanse
  entries.
- The command is not available to agents through MCP.
- The tests above pass; `docs/deployment.md` describes the command and its safety rules.

## Open questions

- Is `--keep-previous` the right name, and should the default be `2` or `1`? (Current + two previous
  is the safer default for a single-host deployment.)
- Should the first cut expose only the CLI, or also a human-only HTTP/UI action?
- Should a future `--include-unknown` allow deletion of source-build images? Keep them by default
  until there is an explicit identity for those builds.
- How should mixed revisions across the five families be reported when a deployment was partial?
  Do not guess; keep the protected/running set and report the mixed state.
- Should local `sha-*` tags be kept for offline rollback even when their revision is old? Keep them
  with the retained revisions; removal is allowed only when the whole revision is pruned.

## References

- `src/runner/image-gc.ts` - existing app-image GC, protection set, serialization, and report.
- `src/images/service.ts` - coordinator image service, `#protectedImageRefs`, deploy-lock patterns.
- `src/runner/docker.ts` - image inspect/remove and the unused low-level `pruneImages` primitive.
- `src/runner/server.ts` - runner routes and runtime-token authorization.
- `src/cli/cli.ts`, `src/cli/commands.ts` - existing `hanse images build` command surface.
- `docs/deployment.md` - current app-image GC, deployment lock, and digest-pinning guidance.
- `src/http/handler.ts` - `/readyz` revision and schema reporting.
- `Dockerfile` - OCI title/revision labels for the five static image families.
