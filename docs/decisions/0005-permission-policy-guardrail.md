# ADR-0005: Permission policy as a guardrail, not a sandbox

## Status

Accepted (2026-10-19; owner decisions recorded in
[`docs/design/interactive-prompts.md`](../design/interactive-prompts.md)).

## Context

opencode 1.19.3 can block an agent turn on a question or permission request. Before this stage Hanse
forwarded the upstream event stream but discarded every payload, so those requests were invisible and
an agent could wait forever. The instance config overlay did not set permissions; OMO sets a global
`external_directory: "allow"` in its config hook, leaving agents able to read outside their
application directory. The coordinator also inherited its own environment into every managed
instance, including `HANSE_OPERATOR_TOKEN` and (potentially) `OPENCODE_PERMISSION`.

opencode's permission system is a UX guardrail, not a sandbox. Agents run as the same uid as the
coordinator, the loopback `opencode serve` API is unauthenticated, and `bash` path checks are
best-effort. The owner explicitly chose a Hanse-route guarantee and warning-only verification rather
than hard isolation in this stage.

## Decision

We will:

1. Inject an explicit permission overlay into every managed instance:
   - `external_directory`: `"*": "deny"`, then allow only trusted runtime roots (tool-output, git
     repos cache, temp, per-instance config/cache skills, `~/.claude/skills`, `~/.agents/skills`,
     bundled plugin skills).
   - `question`, `todowrite`, `todoread`, `webfetch`, `websearch`: allow.
   - `read`/`edit`: `.env`, `.env.*`, `.env.example` allow (read+write decision).
   - `edit`: deny app-owned `opencode.json`/`opencode.jsonc`, `.opencode/opencode.json*`, and
     `.opencode/plugin*`/`.opencode/plugins/*` in worktree-relative bare and `*/` forms.
   - `doom_loop`: ask. No `"permission": "allow"` shorthand and no top-level `"*": "allow"`.
2. Scrub `HANSE_OPERATOR_TOKEN`, `OPENCODE_PERMISSION`, `HANSE_API_BASE`, `HANSE_AUTH_FILE`,
   `HANSE_DB`, and `HANSE_STATE_HOME` from the child environment after every env spread.
3. Set `GIT_CEILING_DIRECTORIES` to the app's real parent so a nested app does not inherit a wider
   parent git worktree.
4. Keep prompt/Todo/event routes human-only and re-fetch pending requests before replies. Treat this
   as a Hanse-route guarantee, not a boundary against the loopback API or a same-uid agent.
5. Verify the final `/agent` ruleset and `/path` after startup for every non-hidden agent for
   external-directory denial; check trusted roots and question/todowrite only for primary/`all`
   agents, since subagent restrictions are intentional. **Warn only**; never block startup (owner
   decision).
6. Support both v1 and v2 prompts. v1 `always` is instance-lifetime; v2 `always` is a durable
   project-scoped saved permission with a list/revoke surface.

## Consequences

Positive:

- Agents can no longer silently hang on questions or permissions; the operator can answer both
  sources from the Web UI.
- Paths outside the app are denied by default while skills, references, truncation, network, and
  `.env` keep working.
- OMO's global external allow is overridden, and a nested app cannot silently widen its worktree.
- Policy drift is visible as a warning in `/prompts` and the UI.

Negative / residual:

- The policy is not a security boundary. The agent can call the unauthenticated loopback opencode
  API or read coordinator state/credentials under the same uid. A v2 `always` can be created
  directly by the agent and persists across restarts; Saved permissions is an audit/revoke surface,
  not a boundary.
- App-owned config/plugins can widen the final ruleset; the `.opencode` edit deny is bypassable with
  `bash`, and verification runs at startup only. Warning-only means a widened ruleset does not stop
  the app.
- `.env` and network access are intentionally allowed and can exfiltrate secrets.
- Hard isolation (separate uid/container, authenticated upstream, or an unreachable proxy) is a
  separate stage.
