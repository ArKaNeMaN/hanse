# 0058 - Dedicated build network uses the classic builder

> Follow-up to Stage 04 (`0056-runner-isolation.md`). Host deployment of `a2dad5c` exposed the
> regression; this is the fix-forward.

## Context

The deployed runner always selected BuildKit when the Engine API supported it. The build request
also set `networkmode=hanse-build`. BuildKit rejects custom network names through the Docker Engine
API:

`network mode "hanse-build" not supported by buildkit`

The deployment therefore completed with every smoke green except image build: the app stayed on its
previous image and reported `build_error`.

## What changed

- `DockerClient.buildImage` uses BuildKit only for `default`, `none`, and `host`. A named build
  network (`hanse-build`) uses the classic builder, which accepts `networkmode=<name>`. There is
  still no fallback to `default`; that would remove the build-network isolation.
- The build regression test now asserts the custom network request omits `version=2`, and a separate
  test asserts a standard `none` network still selects BuildKit.

## Decisions and trade-offs

- **Classic builder for the dedicated bridge.** It is the only Engine API path that enforces a
  custom build network without a separately configured BuildKit builder. The legacy builder is
  deprecated by Docker, so this is a compatibility trade-off.
- **BuildKit-only Dockerfile features.** A Dockerfile using BuildKit-only syntax (for example
  `RUN --mount`) fails closed when the dedicated network is selected. `HANSE_BUILD_NETWORK=none`
  keeps BuildKit but removes build egress. A future BuildKit builder with a `network` driver-opt
  can restore both, but that is not configured by this runner.
- **No default fallback.** A named network that the builder cannot enforce never silently becomes
  `default`.

## Verification

- Host probe: BuildKit rejected `--network=hanse-build`; `DOCKER_BUILDKIT=0` built a real
  `busybox`/`RUN true` image on `hanse-build` successfully.
- `npx vitest run test/docker-build.test.ts test/runner-build.test.ts test/image-pull.test.ts test/runner-containers.test.ts`: 118 passed.
- `npm run typecheck`, `npx biome check` on changed files: clean.
- `npm run build`: clean.
- Fix-forward publish and host image-build smoke are pending.
