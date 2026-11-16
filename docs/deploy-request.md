# Deploy request spec

A deploy request is a handoff to the deployment agent. It is a complete, self-contained spec, not a
pointer to a branch. The deployment side deploys already-published `sha-<full-sha>` images; it never
builds from source.

## Required fields

Every request must include all of the following, even when the delta looks small:

| Field | Requirement |
| --- | --- |
| Deployed revision | The full 40-character SHA currently running. Never a short SHA. |
| Target revision | The full 40-character SHA to deploy. Never a branch name, `main`, or `latest`. |
| Publish workflow | `Publish container`. |
| Publish run id | The numeric id of a **successful** `Publish container` run for the target revision. |
| Image tag | `sha-<target-full-sha>`. The deployment side pulls this published tag. |
| Rollback tag | The previous image tag, normally `sha-<deployed-full-sha>`. |
| Cumulative delta | Every commit from the deployed revision to the target, plus the cumulative diffstat. |
| Migrations | Whether any migration changed; back up `state` and run the migration check when yes. |
| Deploy-visible changes | Routes, assets/UI, health/Compose, the verification contract, and Docker/image changes. |
| Verification | The checks from `deploy-contract.json` that the deployment side must pass. |

## Generate it

Use the generator instead of hand-writing the request:

```bash
npm run deploy:request -- \
  --deployed <deployed-full-sha> \
  --publish-run-id <successful-publish-run-id>
```

It resolves the target from `HEAD` by default. Pin it explicitly when needed, and choose a different
rollback tag if the previous deployment was not the deployed SHA:

```bash
npm run deploy:request -- \
  --deployed <deployed-full-sha> \
  --target <target-full-sha> \
  --publish-run-id <successful-publish-run-id> \
  --rollback-tag <previous-image-tag>
```

Options:

- `--deployed <sha>` - required, full 40-character SHA.
- `--target <sha>` - optional, full 40-character SHA; defaults to `HEAD`.
- `--publish-run-id <id>` - required, numeric id of the successful publish run.
- `--rollback-tag <tag>` - optional; defaults to `sha-<deployed>`.
- `--json` - emit the machine-readable request instead of Markdown.
- `--output <path>` - write the request to a file.
- `-h`, `--help` - show usage.

The generator rejects a short SHA, a non-numeric publish run id, a target equal to the deployed
revision, and a revision that is not present locally. Fetch the deployed revision first; it does not
fetch or guess.

The generated Markdown contains the complete identity block, the cumulative commit list and diffstat,
migration status, deploy-visible file flags, and the verification checklist. `--json` returns the same
information with `deployed_revision`, `target_revision`, `publish_run_id`, `image_tag`,
`rollback_tag`, `cumulative_commits`, `migrations`, and `deploy_visible`.

## Rules

- **Full SHA only.** Never send a 7-character or abbreviated SHA. The deployment side needs the full
  revision to resolve `sha-<full>` and verify `GET /readyz` `revision`.
- **Publish run id always.** A request without the successful `Publish container` run id is
  incomplete, even when the image tag exists.
- **Cumulative delta, not the last commit.** The diff is from the currently deployed revision to the
  target, not "what changed since yesterday". A settings page or a new migration can be several
  commits behind the target.
- **Flag migrations and deploy-visible changes.** Migrations, page routes, assets, health endpoints,
  Compose, the Dockerfile, and `deploy-contract.json` need explicit review and verification.
- **Never ask for a source build.** Do not ask the deploy agent to "rebuild", "pull main", or "deploy
  the branch". The deploy side pulls published `sha-<full-sha>` images only.
- **Never use `main` or `latest` as the deploy target.** Both move. Pin the full SHA and, when
  available, the digest from the `image-digests` run artifact.
- **No host specifics.** Do not include deployment-host names, addresses, ports, paths, credentials,
  or real project/session ids in a request. Use placeholders.

## Verification

The deployment-side checks come from [`deploy-contract.json`](../deploy-contract.json) (also copied
into the image at `/app/deploy-contract.json`). The minimum request-level checks are:

- `GET /healthz` returns `200 {"status":"ok"}`.
- `GET /readyz` returns `200`, `status: ok`, `dbReady: true`, and `revision` equal to the target full
  SHA.
- Anonymous `GET /` and `GET /projects` return `302` to `/login?next=...`.
- Authenticated `GET /` and `GET /projects` return the SPA document with `id="hanse-boot"`.
- `GET /assets/app.css`, `/assets/favicon.svg`, and `/assets/ui/.vite/manifest.json` return `200`;
  removed legacy assets return `404`.
- `POST /login` returns `405`.

When the delta changes a route, asset, health field, or the contract, read the release notes and
re-run the full contract against the deployed image. Contract changes bump `contractVersion` and are
recorded in [`docs/releases/README.md`](releases/README.md).
