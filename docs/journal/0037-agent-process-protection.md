# 0037 - Agent process protection

Status: **deployed** (2026-10-27; commit `25e5c81`).
Design: [Agent process protection](../design/agent-process-protection.md) (approved, `oracle` round 10 PASS).
Plan: [0030 - Agent process protection](../plans/0030-agent-process-protection.md) (`momus` OKAY).
Owner decisions: [open questions](../open-questions.md), 2026-10-27.

## Scope

The stage implements the persistent safe-test instruction, narrow bash self-kill denies with
`/agent` verification, runtime-epoch stop detection, persisted chat notices, subagent-to-parent
signals, recency-guarded top-level session auto-resume, non-starting chat read paths, and the
interleaved notice/stopped-shell UI. It deliberately does not add a manual Resume mechanism, a
settings UI, child auto-resume, seccomp/UID isolation, or an auto-start for a stopped app.

## Phase 0 probes

The disposable probes ran against the bundled `opencode 1.19.3` and a temporary
`XDG_*`/`HOME` under the workspace. No deployment state, secrets, or real project data were used.

- **Absolute `instructions` path:** `opencode debug config` accepted
  `OPENCODE_CONFIG_CONTENT.instructions` with an absolute path under the temporary
  `XDG_STATE_HOME`, and the overlay preserved the path byte-for-byte. This is the prerequisite for
  the per-app rule file.
- **Bash permission map:** `opencode debug config` preserved the deny-only `bash` map without
  adding a catch-all, so the generated overlay shape is accepted.
- **Live model probes not run:** the app container has no provider credentials for a disposable
  model turn and no Docker socket for a live runner restart. Consequently the SIGTERM abort-event
  observation, caller-supplied message-id acceptance, and assistant `parentID` behavior with queued
  prompts were not exercised live. The design's safe paths are implemented regardless:
  - the SIGTERM/timeout rule preserves the busy marker unless a live status/epoch probe proves the
    turn finished;
  - the deterministic `msg_` id is sent and startup reconciliation resolves it if the transport
    outcome is ambiguous;
  - completion/busy correlation uses the bounded message tail rather than strict `parentID`
    equality.

## Implementation

### A - Persistent rule and bash policy

- Migration v20 adds `instances.applied_rule_hash`, runtime epoch/exit/OOM/stop-intent fields, and
  the `session_resume`, `session_notices`, and `session_notice_dedupe` tables/indexes.
- `src/opencode/process-rules.ts` materializes the constant English safety instruction at
  `<app XDG_STATE_HOME>/hanse/agent-process-rules.md`, with a SHA-256 hash and an applied sidecar.
  Writes are atomic (temp + rename, `0600`). A fresh start writes the applied sidecar first, then
  the active file; the manager appends the absolute path after app-specific instructions and
  persists `applied_rule_hash`. A reconnect restores only a sidecar whose hash matches the applied
  hash; otherwise it restores the current code rule, keeps the applied hashes unchanged, logs
  `process_rule_integrity_failed`, and leaves the app `Restart required`.
- `src/opencode/policy.ts` adds the deny-only bash patterns from the design (no `"*"`, no broad
  `kill *`), bumps `ATTACHMENTS_POLICY_VERSION` to 3, and verifies every non-hidden agent
  (including subagents) against all probes. Warnings remain warning-only; hidden agents keep their
  intentional profiles.

### B - Runtime epoch, notices, and detection

- `RuntimeAppStatus`/`HostStatusPayload` now expose `startedAt`, `restartCount`, `exitCode`,
  `oomKilled`, and `finishedAt`; Docker inspect maps `StartedAt`/`FinishedAt`/`ExitCode`/
  `OOMKilled`/`RestartCount`, and B0 host status supplies `restartCount: 0` when unknown.
- `session_resume` tracks busy/retry cycles, `last_busy_seen_at`, interruption epoch/key, defer/
  dispatch/attempt state. Terminal idle/error is confirmed after 5 s with `GET /session/status`
  and a live runtime status probe; completed tails clear the marker, unfinished tails with a
  changed/failed epoch are preserved.
- `session_notices` stores the latest 50 notices per session, deduped transactionally by
  `(app, session, dedupe_key)` with a separate evidence table that survives pruning. Notices are
  emitted live over app SSE as `notice.created` and are always recoverable from the DB-only
  `GET .../sessions/:sid/notices` route.
- Detection classifies operator restart/stop, external restart/stop, deployment, crashes, and child
  aborts. `#stopLocked` records the intent and notices before deleting the container; a fresh
  intent is consumed only on a new epoch. Startup catch-up and the reconciler use bounded passes
  with stop-intent/deployment precedence and a grace/re-probe before `skipped_stopped`.
- Child `MessageAbortedError` uses the 30 s server-side abort tombstone and ancestor walk to
  distinguish an operator abort from an unexpected subagent abort; parent and child notices dedupe
  by child session + epoch.

### C - Resume, no-start reads, and UI

- Resume is top-level-only, uses `last_busy_seen_at` with a 30-minute TTL, requires an already
  running/ready runtime, never calls `ensure`, and has one `auto_attempts` (plus one
  provably-not-sent dispatch retry). The deterministic `msg_` id and a synthetic text part carrying
  `metadata.hanse="agent-resume"` are used; the prompt is the exact design text. Prepared/sent/
  ambiguous/failed states, a 2-minute extendable lease, tail correlation, supersession, completed
  outcomes, and startup reconciliation are implemented. There is no manual Resume route and no
  child auto-resume.
- All chat read routes (`/sessions`, `/messages`, app SSE, `/prompts`, `/saved-permissions`,
  `/todo`, `/context`, legacy session SSE) use `endpointFor` only and return
  `503 {error:"agent is stopped", code:"agent_stopped"}` when no endpoint is attached. Mutations and
  explicit send/Start keep `ensure`.
- The client stores/interleaves persisted notices by timestamp/id inside the ordinary feed,
  renders `.feed-notice` break rows, keeps a message-only count, preserves notices through scroll/
  hydrate/runtime-switch paths, and handles live `notice.created` plus older-notice pagination.
  A stopped reload renders a shell with the URL session id, notices, and an explicit **Start agent**
  action; boot/reconnect/hydration never auto-start. The resume synthetic part is excluded from OMO
  classification and visible parts; `resume_started` is the visible representation.
- `src/http/styles.css` adds light/dark `.feed-notice`/`.chat-stopped` styles and a 767px
  adjustment; `assets/app.css` was rebuilt.

## Verification

All commands were run with `HANSE_CREDENTIALS_DIR` unset, because this environment sets a managed
git-credential directory that changes the fixed git test expectation.

```text
npm test
→ 135 files, 2645 tests passed
```

`vitest.config.ts` sets a 15 s per-test timeout: the suite starts many local HTTP servers and,
under a full parallel run on a loaded host, several integration tests intermittently exceeded the
5 s default. The timeout does not hide failures; the full suite passed before this change with an
explicit `--testTimeout=15000`.

```text
npm run lint          → pass (330 files)
npm run typecheck     → pass
npm run build         → pass (tsc + Tailwind)
npm run check:sensitive → pass
```

Targeted suites during the phases (all green): `process-rules`, `permission-policy`, `instance`,
`manager`, `migrations`, `settings-store`, `session-resume`, `session-notices`,
`runtime-status`, `runner-containers`, `process-recovery`, `http`, `chat-page`,
`prompts-http`, `app-events`, `chat-core`, and `client`.

Browser QA (`docs/design/process-protection-qa.mjs`): **PASS** — 5 scenarios, 46 assertions,
5 screenshots, zero unexpected console/page errors. Evidence:
`docs/design/artifacts/process-protection/` (`stopped-reload-1440-dark`,
`interleaved-{1440,768}-{dark,light}`, report `report.json`/`report.md`). The QA uses a disposable
test state/token and does not include deployment data.

## Known limits

- The instruction and bash denies are guardrails, not a security boundary. Wrappers, scripts,
  app-owned config/plugins, v1 `always` approvals, and v2 saved allows can widen the final ruleset;
  verification is warning-only.
- The rule file and its sidecar are agent-writable; the applied hash detects a missing/mismatched
  copy but cannot prevent a determined agent from writing a different file. The container mount
  remains the hard boundary.
- Auto-resume is top-level only, TTL 30 minutes, one automatic attempt, and requires an already
  running/ready app. A stopped app is never auto-started; the operator starts it and sends a normal
  message. Notice retention is 50 per session; completion correlation uses a bounded message tail.
- External `docker stop` leaves a notice and never starts the app. External `docker restart` is
  treated as an unexpected restart; a deployment or restart claim defers the resume. A transient
  stopped sample is protected by a grace/re-probe, but a restart slower than that grace can still
  be terminalized (the operator can send a normal continuation).
- The live model-level Phase 0 probes remain unverified in this environment (no disposable provider
  credentials). The deterministic-id and SIGTERM fallbacks are implemented and tested at the
  coordinator/fake-runtime level.

## Deployment

- Commit `25e5c811361fd5e0104887018c2acfddbb129ee0` was pushed to `main` and deployed to
  `<deployment-host>`.
- Coordinator image digest: `sha256:a2ec04063abf611d2c3a130346b9d9f0c5d49d1553f45880f3208ae35936b1f2`.
  The publish run produced all five manifests and matching OCI revision labels.
- `/readyz` reported `revision=25e5c81...`, `schemaVersion=20`, `deploying=false`,
  `inFlightLifecycle=0`; all static services were healthy.
- Migration applied v19 and v20 at startup (schema 18 -> 20) with no schema/checksum/process-rule/
  resume/5xx warnings.
- Previously running apps were restored and returned sessions 200. The disposable smoke verified
  explicit start, the process-rule file plus matching applied-sidecar hash, chat 200, stopped reads
  as `503 agent_stopped` with no lazy start, and the DB-only notices route 200 while stopped; the
  test app was returned to stopped.
- The first deployment attempt aborted during the pre-deploy backup before any image switch and
  rolled back; the incomplete backup was marked unusable. The retry succeeded. No post-deploy
  rollback was needed.
- The private deployment record lives only in the untracked deployment area.

## Commit

The stage is one coherent commit `25e5c81` on `main`; the deployment commit is separate.
