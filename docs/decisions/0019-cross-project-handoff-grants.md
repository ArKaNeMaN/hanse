# 19. Explicit cross-project handoff grants

- Status: Accepted
- Date: 2026-11-10
- Design: [`docs/design/cross-project-handoffs.md`](../design/cross-project-handoffs.md)
- Plan: [`docs/plans/0044-cross-project-handoffs.md`](../plans/0044-cross-project-handoffs.md)
- Journal: [`docs/journal/0052-cross-project-handoffs.md`](../journal/0052-cross-project-handoffs.md)

## Context

Session-bound handoffs (ADR 0015) and handoff threads (ADR 0016) resolve a target only inside the
caller's project, and `handoff_policies` is the same-project authority. An application in one project
could not route work to an application in another project, so cross-project collaboration required
copying work or sharing a project.

The owner wants an explicit, operator-owned egress permission: one application may hand off to an
application in a different project, for one-shot and threaded handoffs. This expands the trust
boundary — a source agent can cause a target agent to act in the target workspace with the target
app's credentials and tool access — so it must be an explicit human decision, not an implicit
side-effect of project membership.

## Decision

1. **Source-owned outbound grants.** A grant is "app X of project A may hand off to app Y in project
   B". The source project owns and manages it. The target project does not consent in this stage.
2. **A separate `handoff_grants` table.** Cross-project permission is not an extension of
   `handoff_policies`: `handoff_policies` stays the same-project authority, and a matching outbound
   grant is authoritative for a cross-project pair. The table has a concrete target project (no
   project wildcard), optional `*` app keys, `dispatch_mode`/`reply_mode`, a unique
   `(project_id, from_app_key, target_project_id, to_app_key)`, and a
   `CHECK (project_id <> target_project_id)`.
3. **Default-deny.** Absence of a matching grant is deny. The resolver matches key text only and
   never queries the app registry, so an ungranted caller cannot probe app existence through error
   differences. There are no deny/exception rows; narrowing a wildcard means deleting it and adding
   exact grants.
4. **`auto/auto` default.** A new grant defaults to `dispatch_mode = auto` and `reply_mode = auto`,
   so the intended ask/answer workflow is autonomous once the operator has opened the pair. The
   operator can tighten a specific pair to `approve` on either side; the agent's `requires_approval`
   can raise `auto` to `approve`, never lower it.
5. **One grant covers one-shot and threads; replies need no reverse grant.** The grant is checked at
   admission. A reply is part of the same handoff/thread and never requires a grant in the reverse
   direction.
6. **Builtin/master exclusion.** The master project is a privileged operator surface; a grant to or
   from it would let an app inject prompts into the master agent. Grants, admission, discovery, and
   grant CRUD all reject it. Deleting projects/apps are rejected on creation and fail closed on
   admission.
7. **Public/human projection split.** Public `GET /api/projects` never exposes a cross-project row, a
   foreign app key, or a foreign project id; the human-only `/api/handoffs` projection and the
   project page expose both project ids/names (needed to disambiguate equal bare app keys) but still
   exclude bodies, errors, sessions, and results.
8. **Snapshot at admission.** The handoff stores `target_project_id`, `grant_id`, and the resolved
   modes. They are insert-only, so editing or revoking a grant affects only new handoffs; an
   in-flight handoff/thread keeps its snapshot and is stopped through the existing human cancel
   route. Dispatch/reply never re-resolve the grant.

## Consequences

- Same-project behavior is unchanged: without `to_project` the service takes the existing branch,
  and existing handoffs are backfilled with `target_project_id = project_id`.
- Cross-project rows appear on both project surfaces and in the global inbox, but `allHandoffs`
  dedupes them and `buildSite` counts each once.
- Grant lifecycle and admission write content-free audit events; a denied attempt is deduped per app
  per rate window and counts toward the existing failure limiter, so probing cannot flood the event
  table.
- Project deletion cascades grants from either side; app deletion removes exact-app grants on both
  sides while wildcard grants remain.
- A compromised source agent with a grant can use the target agent as a proxy to read/write the
  target workspace and exfiltrate data through the reply. The grant is the operator's explicit
  acceptance of that risk; container isolation and the target app's credential policy still apply.

## Alternatives rejected

- **Reuse `handoff_policies` with a project column:** mixes same-project and cross-project authority
  in one table and makes absence ambiguous.
- **Project-level grant ("project A may talk to project B"):** too broad; the operator cannot scope a
  single app pair or a single target app.
- **Target consent/approval:** adds a second human gate and a pending-grant lifecycle; the owner chose
  source-owned grants with read-only inbound visibility for this stage.
- **Reverse grant for replies:** would make an admitted ask unable to answer itself and add a second
  failure mode.
- **Implicit allow for sibling projects:** defeats the default-deny boundary and the master-agent
  protection.
- **Mutable grant snapshot:** a later revoke/edit could silently change an in-flight handoff; the
  insert-only snapshot keeps admission and execution consistent.
