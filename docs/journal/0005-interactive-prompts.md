# 0005 - Interactive prompts, Todo panel, and permission guardrail

Date: 2026-10-19. Status: implemented, verified, and deployed to `deployment-host`; not committed (owner has not asked).

## Artifacts

- Design: [`docs/design/interactive-prompts.md`](../design/interactive-prompts.md) (Oracle
  PASS-WITH-CHANGES after two review rounds; owner decisions closed).
- Plan: [`docs/plans/0004-interactive-prompts.md`](../plans/0004-interactive-prompts.md) (Momus
  OKAY; non-blocking notes folded in).
- ADR: [`docs/decisions/0005-permission-policy-guardrail.md`](../decisions/0005-permission-policy-guardrail.md).

## What was done

- The chat client now uses one app-level typed SSE stream
  (`GET /api/apps/:app/events`) instead of the raw per-session stream. The server parses upstream
  `/event`, normalizes v1 and v2 question/permission events, Todo updates, session activity, and
  stream warnings.
- Added question and permission docks above the composer. Questions support single/multi questions,
  options, multi-select, custom answers, review, empty-answer confirmation, dismissal, and
  error/expired/answered-elsewhere states. Permissions support type/pattern/metadata evidence,
  `once`/`always`/`reject` with feedback, inline confirmations, v1 instance scope vs v2 durable
  project scope, `*` caveats, and the reject cascade warning.
- Added the session `Plan` (opencode Todo) section in the context rail, with a `Plan N/M` chip below
  1360, status/priority rendering, progress, cancelled/unknown handling, 0/0 state, and live updates.
- Added v2 durable Saved permissions with list/revoke and a new-grant badge, a top-bar
  input-needed count/queue for other sessions, per-session rail flags, and a policy warning
  banner/chip.
- Added the human-only API in `src/http/prompts.ts`: prompts list (v1+v2), question
  reply/reject, permission reply, saved permissions list/revoke, Todo, and the app SSE route.
  Auth order is 401 -> 403 -> 503 -> 404; replies require `source`, re-fetch pending requests, and
  validate answers/source/empty labels/`tooLarge`.
- Added the permission overlay (`external_directory` deny + trusted roots; question/Todo/network/
  `.env` allow; `.opencode` edit denies; `doom_loop` ask), coordinator env scrub,
  `GIT_CEILING_DIRECTORIES`, and warning-only post-start `/agent` + `/path` verification with a
  `policyWarnings` accessor.
- Client-owned prompt state uses `${source}:${id}` keys, hydration sequence guards, a bounded event
  log, and tombstones for successful/404/dismiss/reject and received terminal events. Per-session
  pending-send state prevents a background send from clobbering the active session.
- The VS Code extension was intentionally not changed.

## Owner decisions

- R6 is a Hanse-route guarantee, not hard isolation; the residual same-uid/loopback bypass is
  accepted for this stage.
- Policy verification is warning-only and never blocks startup.
- App-owned `opencode.json`/plugin edits are denied; `bash` can still bypass this.
- v1 and v2 prompts are both supported; v2 `always` is durable/project-scoped and revocable.
- Empty answers are allowed after explicit confirmation; `tooLarge` requests are dismiss-only.
- `GIT_CEILING_DIRECTORIES`, the trusted external roots, explicit `always` scope/`*`, `.env`
  read+write, and the durable v2 self-grant residual were accepted.

## Verification

- `npm run lint` - pass.
- `npm run typecheck` - pass.
- `npm test` - 27 files, 256 tests pass.
- `npm run build` - pass (`tsc` + Tailwind CSS).
- Deployed to `deployment-host` as `hanse:0.1.0` image `sha256:cb59aeb792b5e6c31f2c3489b0e05a96d4ff396ccac52b8314b33fac7c3653d1`; health checks and new prompt/saved/Todo/SSE routes verified. A follow-up CSS deploy (`sha256:2c7504c722abf02ef48711fd7e8242be4edc693a49dbaf6a966c64da2ddf7444`) fixed chat grid auto-placement so the composer stays visible with a long thread. Rollback tags and backups are recorded in `docs/deploy/deploy-log.md`.
- Unit/integration coverage: SSE parser/projector, v1/v2 normalization, policy builder and evaluator,
  env scrub/ceiling, prompt routes/auth/source/empty answers/`tooLarge`, saved permissions, Todo,
  app SSE, existing chat regression.
- Browser smoke (external Playwright, mocked API/SSE, 1440 and 390): question dock answered with
  `{source:"v1",answers:[["Postgres"]]}`; permission dock after session switch; Plan, Saved
  permissions, policy warning, top-bar queue; no console errors or horizontal overflow. Mobile
  footer/confirm buttons measured 44px; the single-question empty action reads "Send without
  answering".
- The repo has no Playwright product dependency; the browser smoke used the optional local
  Playwright/Chromium resolver pattern from `docs/design/capture.mjs`. Full browser automation is not
  part of `npm test`.

## Residual risks and next threads

- Hard isolation: agents share the coordinator uid, can read `/proc`/state, and can call the
  unauthenticated loopback opencode API. This is a separate stage (separate uid/container,
  authenticated upstream, or an unreachable proxy).
- Warning-only policy verification means a widened ruleset does not stop the app; app-owned
  config/plugins and `.opencode` writes via `bash` remain residual bypasses.
- v2 `always` can be created directly by an agent and persists until revoked; Saved permissions is an
  audit/cleanup surface, not a boundary.
- `.env` and network are intentionally allowed and can exfiltrate secrets.
- No production browser test harness is committed; browser QA remains an external/optional run.
- No commit was made; the stage is ready for the owner's commit decision.
