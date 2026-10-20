# 0009 - Packaging and publishing

Status: done. Scope: build reproducibility, public deployment path, and GHCR publishing. No product
behavior changes except the unauthenticated `/healthz` liveness endpoint.

## Why

Deployment had grown around one operator workflow: copy the working tree over SSH with `tar`, build
the image on the server, and keep the details in a local, git-ignored runbook. That is workable for
development but not a public deployment story:

- The image could only be built from a full checkout, with network access and a compiler on the host.
- `docker-compose.yml` hard-coded a LAN IP and required a host `opencode` auth file, so it was not
  portable.
- The Dockerfile copied `/usr/lib/code-server` from `codercom/code-server:latest`, leaving the IDE
  version unpinned and the copied runtime unverified against the base image.
- The final image ran as root by default (Compose overrode it), had no health check, and kept npm
  caches and an unused `opencode` binary variant in its layers.
- There was no public image, no container build gate in CI, and no publish workflow.

## What changed

### Image

- `Dockerfile` is a multi-stage, multi-arch build with pinned versions:
  `codercom/code-server:4.141.0`, Node 22, `opencode-ai@1.19.3`, `oh-my-openagent@5.1.35`,
  `@colbymchenry/codegraph@1.6.2`, and `GitHub.github-vscode-theme@6.3.5`.
- The runtime extends the official code-server image instead of copying its installation. This keeps
  code-server's native libraries, `git`, CA certificates, `curl`, and `dumb-init` authoritative.
- A Node 22 binary is copied in for the coordinator, matching `.nvmrc` and CI. code-server keeps its
  own bundled Node for the IDE, so the two runtimes do not fight over ABI.
- TypeScript/Tailwind build on `$BUILDPLATFORM`; production dependencies and the bundled tools build
  on `$TARGETPLATFORM`. `better-sqlite3` therefore matches the target architecture while `tsc` and
  Tailwind do not run under emulation.
- Build stages clean the npm cache. The selected `opencode` binary is hardlinked into
  `bin/opencode.exe`; the per-platform optional packages are then dropped, removing an unused
  ~178 MB binary from the final image.
- The image ends as `USER coder` (uid 1000), exposes 8787, has an OCI label set, and defines a
  `/healthz` health check.
- The final image prepares `/home/coder/.omo` and `/data/{workspace,state}` for uid 1000.

### Compose

- `compose.yaml` is the release file: it pulls `ghcr.io/arkaneman/hanse:${HANSE_TAG:-latest}`, binds
  loopback by default (`HANSE_BIND`), takes workspace/state paths from the environment, and sets
  `no-new-privileges`, health checks, and an IDE dependency on a healthy coordinator.
- `compose.build.yaml` adds the source build and tags it `hanse:dev`, so a local build does not
  overwrite the published tag.
- `compose.host-auth.yaml` is the opt-in overlay for reusing a host `opencode` auth file. The base
  file no longer requires that mount, so a fresh machine can start with provider keys entered in the
  UI.
- `docker-compose.yml` was replaced by `compose.yaml`; Compose v2 discovers it automatically.

### Health and CI

- `GET /healthz` returns `{"status":"ok"}` without authentication. It is the liveness endpoint used
  by the image and Compose health checks; `/assets/*` remains the public static surface.
- `ci.yml` now has a Docker job that builds `linux/amd64` on every push/PR.
- `publish.yml` builds `linux/amd64` and `linux/arm64` on `main`, `v*` tags, and manual dispatch,
  pushes `main`, `sha-<short>`, `latest`, and semver tags to GHCR, and attaches provenance and an
  SBOM. Docs-only pushes are ignored. Package visibility is documented as a one-time package
  setting; `GITHUB_TOKEN` cannot change user-package visibility through `/user/packages`.

## Decisions

- **Code-server as the runtime base.** It is the maintained distribution of the IDE we already ship;
  extending it removes a hand-copied 700 MB tree and the guesswork about missing system libraries.
- **Two Node runtimes.** Copying Node 22 is the least surprising way to keep `better-sqlite3` and the
  project's CI baseline aligned while code-server upgrades its own Node independently. The alternative
  - compiling for code-server's bundled Node - would couple the coordinator's ABI to an IDE upgrade.
- **Build output separated from dependency installation.** The build platform compiles TypeScript and
  CSS; the target platform installs native modules. This makes arm64 builds practical without running
  the compiler under emulation.
- **Release Compose file separate from the build overlay.** A user who downloads only `compose.yaml`
  can pull and run without a checkout; a developer opts into the build with one extra `-f`.
- **GHCR with `GITHUB_TOKEN`.** No long-lived registry secret, and public-repository pulls are
  anonymous once the package visibility is public.
- **`latest` tracks `main`.** The project is pre-alpha; release and `sha-<short>` tags exist for
  deployments that need to pin. The guide tells operators to pin.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` (561 tests), and `npm run build` are green.
- `docker compose config` validates the release, build, and host-auth overlays.
- Local `linux/amd64` and `linux/arm64` images build. Both run `node`, `opencode`, `code-server`, and
  `better-sqlite3`; the amd64 image served `/healthz`, `/login`, `/assets/app.css`, `/settings`, the
  project/application creation API, and the proxied IDE.
- The source-build overlay (`compose.build.yaml`) builds and tags `hanse:dev`.
- CI's Docker job built the image in 3m14s on the first run and 1m2s with the cache. The publish
  workflow built both architectures in 9m15s, pushed `main`, `sha-3b2c35e`, and `latest`, and the
  package was public for anonymous pulls.
- Anonymous `docker pull ghcr.io/arkaneman/hanse:sha-3b2c35e` succeeds; the index contains
  `linux/amd64`, `linux/arm64`, and attestation manifests. The follow-up publish at `sha-1f114ea`
  (`sha256:499197381079009ad21d4ad60da9847633c723b6ec3e01f3d1b372a3a9ccaa64`) carries the corrected
  `org.opencontainers.image.version=0.1.0` and `revision=1f114ea` labels.
- The published image was deployed to the reference host, preserving the existing project and
  workspace. Both services are healthy; `/healthz`, login, authenticated pages, assets, the API, and
  `/ide/` return the expected statuses.

## Known limits

- The image remains large because it bundles code-server, `opencode`, OMO, and CodeGraph. Multi-stage
  copies and cache cleanup remove duplication, not the tools themselves.
- The package is public by package setting, not automatically for every fork. `GITHUB_TOKEN` cannot
  change user-package visibility; the guide documents the one-time manual check.
- `latest` is mutable. Operators who need reproducibility must pin a tag.
- Database migrations remain forward-only; an image rollback after a migration is not a data
  rollback.
- The security model is unchanged: single operator, trusted projects, agents share the coordinator
  uid and can read state. Packaging does not add isolation.
