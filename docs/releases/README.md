# Release notes

Release notes describe what changes for an operator or a deployment. This file defines the
deploy-visible contract policy; individual release notes live next to it.

## Deploy-visible contract changes

[`deploy-contract.json`](../../deploy-contract.json) is the machine-readable source of truth for the
coordinator's deploy-visible HTTP and asset surface. Bump `contractVersion` and add a
**Deploy-visible changes** section to the release note when a release changes any of:

- a page route id or path, or whether a route is public;
- an HTTP status, redirect, content type, or required response field on `/`, `/login`, `/healthz`,
  `/readyz`, `/assets/*`, or a page route;
- a required or removed asset;
- the Compose healthcheck or startup behavior;
- a migration that must run during startup.

The release note must state the old and new behavior in plain language. The deployment side should
read `deploy-contract.json` from the image instead of pinning prose from an older note.

## Current contract

- `contractVersion`: `1`
- Added `deploy-contract.json` (repository root and `/app/deploy-contract.json` in the coordinator
  image) with route ids/paths, required and removed assets, health fields, and HTTP semantics.
- Anonymous page routes redirect with `302`, not `303`.
- Authenticated unknown pages return the SPA `not-found` shell (`404`) when the UI build is present;
  the static "Nothing is moored here." copy is only used when the UI build is missing.
- The coordinator healthcheck uses `start_period: 300s` because the first runner mount-layout
  migration can take several minutes before the server listens.
- The deploy request template requires the full 40-character SHA, the successful publish run id, and
  the cumulative diff; see [`docs/deploy-request.md`](../deploy-request.md).
