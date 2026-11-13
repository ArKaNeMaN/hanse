# 0059 - Build records on a host-owned directory

> Follow-up to `0056-runner-isolation.md` and `0058-build-network-classic-builder.md`. The runner
> fix-forward exposed this while verifying a real build.

## Context

The runner persists build records under `HANSE_BUILD_RECORDS_DIR`, which the deployment creates on
the host owned by uid 1000 with mode `0700`. The runner runs as root with `cap_drop: ALL` and only
`CHOWN` and `DAC_OVERRIDE`. Its first write called `chmodSync(dir, 0o700)`; root does not own the
directory and lacks `CAP_FOWNER`, so every save failed with `EPERM`:

`cannot write image build record: EPERM: operation not permitted, chmod '<records-dir>'`

Build status and logs still worked from the in-memory record, but nothing was durable and a restart
could not show `interrupted`.

## What changed

- The store no longer chmods an existing directory. It creates a missing directory with mode `0700`
  and leaves ownership alone.
- If an existing directory is broader than `0700`, it emits one bounded warning and continues; record
  files are still created `0600`.
- Deployment docs state that the operator must create the host records directory `0700`, owned by the
  host uid used by the deployment.
- A regression test pre-creates a `0755` directory, saves a record, and asserts the directory mode is
  unchanged, the file is `0600`, and the warning is emitted.

## Verification

- `npx vitest run test/runner-build.test.ts`: 44 passed.
- `npm run typecheck`, `npx biome check` on changed files: clean.
- `npm run build`: clean.
- CI run 43340859825 and publish run 43340859769 succeeded. The runner-only 3b12e35 deployment
  persisted a real build record (`0600`, host-owned `0700` directory), loaded it as `ready` after a
  runner restart, and logged no `EPERM`/build-record warning.
