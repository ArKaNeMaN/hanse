# Plan 0021: opencode slash commands in the chat composer

- Status: implemented and verified (journal 0025); commit pending
- Stage: `0021-slash-commands`
- Design: [`docs/design/slash-commands.md`](../design/slash-commands.md) - approved for planning
  (`oracle`, round 2 **PASS**, 2026-10-23)
- Design reviewer: `oracle` (round 1 FAIL; round 2 PASS)
- Plan reviewer: `momus` (PASS, 2026-10-23)
- Owner decisions: [`docs/open-questions.md`](../open-questions.md) stage `0021-slash-commands` -
  six resolved decisions, zero open items
- Date: 2026-10-23

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0021-slash-commands` |
| Design artifact | `docs/design/slash-commands.md` |
| Design review | `oracle` - PASS after 2 rounds |
| Plan artifact | `docs/plans/0021-slash-commands.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0025-slash-commands.md`; index `docs/journal/README.md` |
| Decision record | none; the design's resolved decisions (§17) and the owner answers are the record |
| Open questions | none for this stage |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Extra verification | `node docs/design/chat-qa.mjs`; live `chat-qa --live`; `npm run check:sensitive` |
| Commit policy | explicit owner authorization; one coherent Conventional Commit for the stage |
| Deploy | not part of this plan; record separately if performed |

## Owner decisions carried into this plan

1. Proxy the opencode command catalog and execution as-is; no per-command implementation and no
   template/argument expansion in Hanse.
2. Five TUI-local actions are Hanse-internal (`new`, `help`, `editor`, `compact`, `diff`), merged into
   the same palette and mapped to existing web UI behavior. `/sessions` is excluded.
3. `/restart` and `/diff` are in scope, not deferred.
4. The template is never sent to the browser; a conservative `shell` tri-state is computed server-side
   and `present`/`unknown` require an explicit confirmation.
5. The other 25 TUI-local commands are skipped; `/model` and `/stop` are deferred.
6. `/diff` opens the application page `Changes` (`#changes-title`, worktree-wide) in a new tab;
   inline feed diffs stay the per-edit view.

## Scope

### In scope

- One merged command catalog: opencode's `GET /command` entries plus six static Hanse entries, with
  server-side collision, whitelist, and cap policy.
- One execution route that forwards a selected opencode command name and the raw argument string to
  opencode's v1 `POST /session/{sid}/command`, detached behind a `202` and reconciled over the
  existing app SSE.
- One composer palette with an action map for `new` (alias `clear`), `help`, `editor` (alias `ide`),
  `compact`, `diff`, and Hanse-native `restart`.
- `shell: none | present | unknown` display metadata and the `confirmShell` gate, including the
  argument scan.
- The version decision gate in phase 0: v1 primary, the design §6.6 v2 contingency only when the v1
  pair is absent and the v2 pair is present, Hanse-only when neither pair exists.
- Unit, HTTP, browser, and live verification listed in phase 4.

### Out of scope (non-goals)

- Template expansion, `$ARGUMENTS`/`$1..$N` handling, argument expansion/splitting/quoting/
  interpolation/reinterpretation, and shell execution in Hanse. The only read of the argument string
  is the shell-pattern safety scan.
- Command authoring/editing/deletion or a command file browser; per-command dialogs or forms.
- Adopting the experimental v2 API as the primary path, or a general runtime version adapter.
- `/sessions`, the other 24 skipped TUI-local commands, `/model`, and `/stop`.
- Command history, favorites, pinning, recently-used persistence.
- A database migration, audit table, durable command state, feature flag, new dependency, framework,
  or bundler.
- File attachments (`parts`), agent/model/variant overrides, or any change to the SSE vocabulary,
  message pagination, or model injection.
- Deployment. Deployment-host evidence belongs only in the git-ignored `docs/deploy/`.

## Global invariants

- **Additive and reversible.** New routes, one new pure server module, one new asset module, and one
  palette branch. No migration, no DB write, no dependency, no feature flag.
- **Template confidentiality.** `template` is never returned, cached, or logged. The DTO is an
  explicit whitelist, never an object spread.
- **No reinterpretation.** `name` and `arguments` are forwarded verbatim; Hanse never expands,
  splits, quotes, interpolates, or executes them.
- **Human-only.** Both command routes require a human principal before app resolution. The POST is
  JSON-only and rejects a present cross-site `Origin`.
- **Deletion first.** `found.app.deleting`/`found.project.deleting` is checked before any manager,
  `stopped`, or `unconfigured` branch; the result is `409 deletion_pending`.
- **Fresh shell decision on send.** POST always fetches a fresh upstream list; the 5 s GET summary
  cache is never used for dispatch or shell classification.
- **Detached boundary.** After the upstream request is dispatched, every failure observed inside the
  750 ms early window is `502 command_failed` with `outcome: "unknown"`; pre-dispatch failures are
  `not_sent`. Later failures are logged and reconciled over SSE, never returned.
- **Existing chat preserved.** Ordinary text keeps its trimmed send, the acceptance lock, the SSE
  output path, and the server-injected model. Palette Enter inserts; composer Enter submits.
- **No secret or internal leakage.** No upstream body, `OpencodeHttpError.message`, `bodyExcerpt`,
  expanded prompt, template, or shell output is returned or logged.
- **Shared worktree discipline.** The repository already contains unrelated uncommitted design/plan
  files. Stage only the files this plan names; never stage `docs/deploy/` or live QA artifacts.

## File map

| Phase | Create | Edit |
| --- | --- | --- |
| 0 | `docs/design/artifacts/slash-commands/probe.md` | none |
| 1 | `src/opencode/commands.ts`, `test/commands-registry.test.ts` | `src/opencode/client.ts` |
| 2 | `src/http/commands.ts`, `test/slash-commands.test.ts` | `src/http/server.ts`, `src/http/handler.ts` (`HttpDeps` logger), `src/cli/commands.ts` (logger wiring) |
| 3 | `assets/chat-commands.js`, `test/chat-commands.test.ts` | `assets/chat.js`, `src/http/chat.ts`, `src/http/handler.ts` (asset allowlist), `src/http/styles.css`, `test/chat-page.test.ts`, `docs/design/chat-qa.mjs`, `docs/design/artifacts/chat/README.md` |
| 4 | none | `docs/current-state.md`, `docs/design/README.md` (status) |
| 5 | `docs/journal/0025-slash-commands.md` | `docs/journal/README.md`, `docs/plans/README.md` (status) |

`assets/app.css` is generated and git-ignored; `npm run build` refreshes it locally and it is not
listed as a committed change.

## Phase 0 - Probe the pinned opencode 1.19.3 and decide the version branch

### Boundaries

- Only probe evidence and the version decision. No `src/`, `assets/`, test, or client changes.
- Do not bump or downgrade the pin. Do not implement a fallback "just in case".

### Invariants

- The probe uses a throwaway install and a synthetic app; no real project, app, session, host, port,
  path, token, or deployment detail is committed.
- Evidence uses placeholders (`<PROBE_DIR>`, `<PORT>`, `<SESSION_ID>`, `<APP_DIR>`) and redacted
  bodies. Synthetic command names only.
- A probe that cannot run is a blocked gate, not a skipped row; record the blocker and stop before
  phase 1.

### Work

1. Create an isolated probe environment (no host specifics):

   ```bash
   PROBE_DIR=$(mktemp -d)
   npm install --prefix "$PROBE_DIR" --no-save --no-audit --no-fund opencode-ai@1.19.3
   "$PROBE_DIR/node_modules/.bin/opencode" --version
   mkdir -p "$PROBE_DIR/app/.opencode/command"
   printf -- '---\ndescription: Probe command\n---\nProbe $ARGUMENTS\n' \
     > "$PROBE_DIR/app/.opencode/command/probe-hello.md"
   ```

   Start the server in the synthetic app directory, then stop it when done:

   ```bash
   cd "$PROBE_DIR/app"
   HOME="$PROBE_DIR/home" XDG_CONFIG_HOME="$PROBE_DIR/config" \
     XDG_DATA_HOME="$PROBE_DIR/data" XDG_STATE_HOME="$PROBE_DIR/state" \
     XDG_CACHE_HOME="$PROBE_DIR/cache" \
     "$PROBE_DIR/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port <PORT>
   ```

   A short-lived `opencode serve` from the pinned agent image is an acceptable equivalent, provided
   the evidence still uses placeholders. Do not record the deployment host or a production image tag.

2. Fill the probe matrix. Record the exact request, status, and a **redacted** body shape per row.

   | ID | Probe | What must be recorded |
   | --- | --- | --- |
   | P0-1 | `GET /command` (no query) | 200/404/405; array; fields; `template` type; `hints`; `source`; `agent`; `model` |
   | P0-2 | `GET /command` cwd check | With cwd `<APP_DIR>`, `probe-hello` is returned (project list, not a global/default list); also record what changes when cwd is `<PROBE_DIR>` |
   | P0-3 | `POST /session` then `POST /session/<SESSION_ID>/command` | Body field types (`arguments` string), `messageID` honored (echoed or applied), blocking vs immediate, success shape |
   | P0-4 | Client disconnect during a blocking command | Whether the turn is aborted, continues, or errors; record the observable status |
   | P0-5 | `GET /api/command` and `POST /api/session/<SESSION_ID>/command` | Presence; list shape; query form (`location[directory]` vs none); `text` semantics (raw args vs `/name args`); `204` |
   | P0-6 | Missing session and unknown command on both pairs | Exact status/body and whether any turn starts; do not assume 404 means "session missing" |
   | P0-7 | MCP prompt serialization | Register a minimal one-prompt stdio MCP server in the probe app (a probe-only JSON-RPC server answering `initialize` and `prompts/list` is enough; its source is not committed), call `GET /command`, record the MCP entry's `source` and `template` JSON type (`absent`/`null`/`{}`/string) |
   | P0-8 | Shell grammar | ``prefix !`cmd` `` inline; line-start block; multiple blocks; argument-injected block through a `$ARGUMENTS` template and through a template with no placeholder; record which blocks run |
   | P0-9 | Unknown/non-array list | A missing route, a non-array body, and an oversized body; record status and body class |
   | P0-10 | `GET /doc` (if present) | Path templates for v1/v2 list and send routes, for the presence decision |

3. Write the evidence to `docs/design/artifacts/slash-commands/probe.md` (decision: artifact, not a
   plan appendix). Structure: environment line (`opencode 1.19.3`, synthetic app, placeholders),
   the P0-1..P0-10 table, raw redacted examples, and a `Decision` section. Never include an absolute
   path, a host, a port, a token, a real session/app/project id, or an unredacted prompt/template.

4. Apply the decision rule.

   | Observation | Branch |
   | --- | --- |
   | v1 pair present (list returns an array **and** send route present/working) | **v1** - primary path in phases 1-3 |
   | v1 pair absent or partial, v2 pair present (list and send) | **v2** - design §6.6 adapter only |
   | Neither pair present | **Hanse-only** - warning, no pin change, `502 commands_unavailable` before dispatch |
   | v1 pair present **and** v2 pair present | **v1** wins; v2 is not implemented |
   | v1 pair present but a field shape differs | v1 stays selected; the whitelist handles the difference or the source degrades to `unavailable`; record the degraded field |

   Presence is judged from `/doc` path templates where available, confirmed by a live call on a
   synthetic session. A generic route-not-found 404/405 means absent; a command/session validation
   error on an existing route means present. Record the exact evidence for the judgment.

### Acceptance criteria

- `probe.md` exists, every P0-1..P0-10 row is filled or explicitly blocked with a reason, and a
  single `Decision: v1 | v2 | hanse-only` line is present.
- The decision cites the probe rows that justify it; no branch is inferred from the design alone.
- `npm run check:sensitive` passes on the new artifact.
- `git status` shows no production file changed by this phase.

### Risks

- The probe environment differs from the managed instance (MCP config, plugins, permissions). Record
  the difference; do not generalize an unprobed shape.
- MCP prompt setup may be heavy; if it cannot be reached, mark P0-7 blocked and cover the non-string
  template branch with the synthetic unit tests in phase 1. Do not claim a live MCP result.
- The pinned image may not contain the exact npm package; record the version output and stop if it is
  not 1.19.3.

### Verification for this phase

```bash
npm run check:sensitive
git status --short
```

### Outcome

2026-10-23 - probed `opencode-ai@1.19.3` in an isolated synthetic app; `opencode --version` printed
`1.19.3`. Decision: **v1**. The v1 pair is complete and live (`/doc` in P0-10; list in P0-1; blocking
send in P0-3), while the v2 list is present but its send route is absent (P0-5), so no pin change and
no v2 adapter are needed. No row is blocked; P0-9's oversized **server list** body is not inducible
(Hanse's 4 MiB cap stays a client-side guard), and P0-1 has no non-null `agent`/`model` sample because
the synthetic app configured neither. Evidence: `docs/design/artifacts/slash-commands/probe.md`.
Phase 0 changed no production file.

## Phase 1 - Server foundations: client functions, registry, merge, shell detection

### Boundaries

- `src/opencode/client.ts`, new `src/opencode/commands.ts`, `test/commands-registry.test.ts`.
- No HTTP route, no chat page change, no client asset.
- Implement only the phase-0 branch. If the branch is v1, do not build the v2 adapter. If v2, do not
  build v1. If Hanse-only, do not call `GET /command` at all.

### Invariants

- `src/opencode/commands.ts` is pure: no I/O, no network, no environment reads.
- `template` is accepted as `unknown` at the boundary, coerced to a string only for detection, and
  never stored in the output DTO.
- The shell detector uses the exact upstream pattern ``/!`([^`]+)`/g`` anywhere; the implementation
  uses a non-global copy (or resets `lastIndex`) so repeated calls are deterministic.
- Caps apply before serialization: 500 commands per upstream list, 500-character description,
  10 hints x 200 characters, 20 warnings, 4 MiB upstream list, 1 MiB merged response.
- Hanse entries are never dropped by the merged cap; only trailing opencode entries are.

### Work

1. `src/opencode/client.ts`:
   - Add `OpencodeCommand` exactly as design §6.3, with `template?: string` and the runtime guard.
   - Add `listCommands(endpoint, options?)`: `GET /command` with **no** `directory`/`workspace`
     query; 4 MiB cap; 10 s timeout; reject a non-array body; never log a template.
   - Add `runSessionCommand(endpoint, sessionId, name, args, messageID, options?)`:
     `POST /session/{sid}/command` with `{command, arguments, messageID}`; default 30 min timeout;
     drain at most 1 MiB of the response and ignore the body.
   - If phase 0 selects v2, add `listCommandsV2(endpoint, appDir, options?)` and
     `runSessionCommandV2(endpoint, sessionId, name, text, options?)` in the same file using the
     probed list query form (no query if cwd already scopes the list, otherwise
     `location[directory]`), `{name, text}` with `text` as the raw argument text (not `/name args`
     unless the probe proves otherwise), and the `204` contract. Do not expose a runtime selector.
   - Reuse the private `getJson`/`requestResponse`/`readCapped` helpers; do not duplicate transport
     code.

2. `src/opencode/commands.ts`:
   - Types: `ShellPresence`, `HanseCommandAction`, `HanseCommand`, `CommandWarningCode`,
     `CommandWarning`, `CommandSourceStatus`, `CommandEntry`, `CommandList`.
   - Static registry, exactly six entries in this order: `new` (alias `clear`), `help`, `editor`
     (alias `ide`), `compact`, `diff`, `restart`. Descriptions and hints are fixed and bounded.
   - `containsShellBlock(text)` and `detectShell(template)`; the client owns
     `shellRequiresConfirmation(shell)` so the predicate is not duplicated across languages.
   - `sanitizeName`, `sanitizeDescription`, `sanitizeHints`, a name-shape check matching
     `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`, and control-character stripping.
   - `whitelistOpencodeCommands(raw)` building the explicit DTO (no spread), applying origin
     defaults and the model normalization (string or `{providerID, modelID}` object), dropping
     invalid names/duplicates with `command_dropped`, and capping at 500 with `command_dropped` for
     every extra entry.
   - `mergeCommands(hanse, opencode, options)`: Hanse registry order, opencode sorted by name,
     upstream-wins canonical collisions, alias removal plus `command_shadowed`, master
     `available:false`/`unavailableReason` for `editor` and `diff`, and a warnings array capped at 20.
   - `capMergedResponse(list)`: serialize, drop trailing opencode entries until <= 1 MiB, add exactly
     one `command_cap_reached` summary when anything was dropped; never drop a Hanse entry.
   - `upstreamCommandSupport()` returning the phase-0 branch (`v1`, `v2`, or `none`) as a
     compile-time constant with a comment naming the probe artifact.

3. `test/commands-registry.test.ts`:
   - Registry order, aliases, six entries, bounded metadata.
   - Detector: inline block not at line start, line-start block, multiple blocks, no block, repeated
     calls with no `lastIndex` leak, absent/`undefined`/object/non-string -> `unknown`.
   - `containsShellBlock` on arguments, including a block injected after `$ARGUMENTS`.
   - Whitelist: no `template` key anywhere, description cap/control stripping, hint caps, origin and
     source defaults, model string/object/omitted, invalid name drop, duplicate first-wins,
     non-object entries, non-array source.
   - Merge: order, collision warning and Hanse hide, alias collision, direct-typed token resolution
     inputs, master availability, unknown action retained as disabled-ready metadata.
   - Caps: 500 per list, 1 MiB merged cap drops trailing opencode entries only, one
     `command_cap_reached`, Hanse entries preserved, warnings capped at 20, serialized size <= 1 MiB.

### Acceptance criteria

- The pure module has no I/O imports and no `template` in any output type.
- `detectShell` is deterministic across repeated calls; a unit test fails if the pattern is
  implemented as line-start-only or with a leaking global regex.
- `whitelistOpencodeCommands`/`mergeCommands` never return a template, including when the upstream
  object contains one.
- The merged cap is proven by serializing the result and asserting `Buffer.byteLength <= 1 MiB`.
- The six Hanse entries and the 25 skipped/2 deferred set match design §9.3 and the owner answers.
- No route, client asset, or page markup changed.

### Risks

- The upstream `Command.model` shape may differ at 1.19.3; the whitelist accepts string, object, or
  omit and the probe row records the real shape.
- An MCP template may serialize as an empty object; `detectShell` must return `unknown` for any
  non-string, which is tested both with absent and object values.
- The 1 MiB cap could be computed after JSON escaping differently from the route; the test must
  assert the serialized response bytes, not an estimate.

### Verification for this phase

```bash
npx vitest run test/commands-registry.test.ts
npm run typecheck
npm run lint
```

### Outcome

2026-10-23 - Phase 1 implemented `src/opencode/client.ts` (`OpencodeCommand`, `listCommands`,
`runSessionCommand`, v1 only) and the pure `src/opencode/commands.ts` (six-entry registry, shell
tri-state, whitelist/merge/caps/collision, `upstreamCommandSupport() === "v1"`), with
`test/commands-registry.test.ts` (27 tests). The focused test, `npm run typecheck`, and targeted
Biome checks passed. The repository-wide `npm run lint` is currently blocked by an unrelated
untracked file (`src/skills/tool-projection.ts`, formatting), not by this phase.

## Phase 2 - HTTP routes: list and detached execution

### Boundaries

- New `src/http/commands.ts`; `src/http/server.ts`; `src/http/handler.ts` (`HttpDeps.logger`
  optional field); `src/cli/commands.ts` (pass a real logger); `test/slash-commands.test.ts`.
- No client asset, page markup, or CSS.

### Invariants

- Route order in `src/http/server.ts`: `isCommandsRoute` is evaluated before `isChat`, the same way
  the context route is. Both command paths match regardless of method so a wrong method is `405`, not
  a chat 404.
- Authentication order: `401 sign_in_required` -> `403 human_only` -> POST `403 cross_site` ->
  `405 method_not_allowed` -> POST `415 unsupported_media_type` -> app resolution. An agent principal
  is rejected before any app probing.
- Deletion markers are checked immediately after `findApp` and before `manager`, `stopped`, or
  `unconfigured`.
- GET never starts a stopped app and never returns a non-200 for a missing runtime; only an
  unknown/deleting app is non-200.
- POST always fetches a fresh list and ignores the 5 s GET cache; a name miss triggers exactly one
  more fresh fetch before `404 command_not_found`. The session id comes from the path and is not
  prevalidated; a missing session is classified like any post-dispatch failure.
- The argument string is capped at 32 KiB raw UTF-8 (the global 64 KiB body cap may produce `413`
  first); the name is at most 128 characters and must match the shape check.
- `dispatchStarted` flips only after the upstream request is issued. Every failure observed inside
  750 ms after that point is the fixed `502 command_failed` with `outcome: "unknown"`, the generated
  `messageID`, `sessionID`, and `name`; no upstream body or error text is included.
- A 202 is returned even if the background call later fails; the failure is logged only.
- The server summary cache holds only whitelisted display summaries, GET-only, 5 s per endpoint; it
  never holds a template.

### Work

1. `src/http/commands.ts`:
   - `isCommandsRoute(method, path)` matching both:
     `^/api/apps/([^/]+)/commands$` and `^/api/apps/([^/]+)/sessions/([^/]+)/commands$`.
   - `handleCommands(deps, request)` with the auth/Origin/method/content-type order above.
   - `findApp(deps, projectParam(request), appKey)`; unknown -> `404 unknown_app`; deletion marker ->
     `409 deletion_pending` before any runtime branch.
   - GET: `deps.manager === undefined` -> Hanse-only + `sources.opencode="unconfigured"` +
     `agent_runtime_unconfigured`; `manager.isRunning(app.id) === false` -> Hanse-only +
     `"stopped"` + `agent_stopped` with no `ensure` call; running -> `manager.ensure` then
     `listCommands`; an `ensure` result that reports a stopped instance -> `"stopped"`; any other
     `ensure`/list failure -> `"unavailable"` + `commands_unavailable`; a `DeletionPendingError` to
     `409`. Apply the 5 s summary cache only here. Return `200 {commands, sources, warnings}` with
     `cache-control: no-store`.
   - POST: `deps.manager === undefined` -> `503 agent_runtime_unconfigured`; `manager.ensure`
     failure -> `502 agent_unavailable` or the mapped lifecycle response; fetch a fresh list with
     `listCommands` (10 s/4 MiB) -> `502 commands_unavailable` before dispatch on failure; name miss
     -> one more fresh fetch -> `404 command_not_found`; derive the effective shell from the fresh
     `template` and `arguments`; `present`/`unknown` without `confirmShell:true` ->
     `400 shell_confirmation_required`; generate
     `messageID = "msg_" + randomUUID().replaceAll("-", "")`; start
     `runSessionCommand` behind a 30 min `AbortController`; return the fixed early-window error if
     the call rejects within 750 ms, otherwise return `202 {accepted:true, sessionID, name,
     messageID}` immediately on success or after the 750 ms window expires.
   - Fixed message constants per code (the client displays `error`):
     `invalid_json`: "Invalid JSON body."; `empty_command`: "Choose a command.";
     `invalid_command`: "Invalid command name."; `command_too_large`: "Command arguments are too
     large."; `shell_confirmation_required`: "Confirm the shell command before running it.";
     `sign_in_required`: "Sign in required."; `human_only`: "Only a human principal may run
     commands."; `cross_site`: "Cross-site request rejected."; `unknown_app`: "Unknown application.";
     `command_not_found`: "Command not found; refresh the list."; `method_not_allowed`: "Method not
     allowed."; `deletion_pending`: "Application is pending deletion."; `payload_too_large`: existing
     global message; `unsupported_media_type`: "Content type must be application/json.";
     `agent_unavailable`: "Agent is unavailable."; `commands_unavailable`: "Commands are
     unavailable."; `command_failed`: "Command outcome unknown."; `agent_runtime_unconfigured`:
     "Agent runtime is not configured."
   - Fixed GET warning messages: `agent_stopped` "Application commands load when the agent starts.";
     `agent_runtime_unconfigured` "No agent runtime is configured; Hanse commands still work.";
     `commands_unavailable` "Application commands are unavailable; Hanse commands still work.";
     `command_shadowed` "/<name> is provided by the application."; `command_dropped` "Some
     application commands were skipped."; `command_cap_reached` "Some application commands were
     omitted because the list is too large."
   - Logging via the optional `HttpDeps.logger` (`src/logging/logger.ts`): `commands.list`,
     `commands.send.accepted`, `commands.send.rejected`, `commands.send.early_failed`,
     `commands.send.failed`, `commands.send.timeout`, `commands.list.shadowed`. Fields are limited
     to ids, name, status/code, counts, byte lengths, duration, and `messageID`; never arguments,
     templates, prompts, or upstream bodies.
   - If phase 0 selected v2: use `listCommandsV2`/`runSessionCommandV2`; every v2 entry is
     `shell:"unknown"`; `messageID` is logged only and the client does not rekey by it; a known-absent
     v2 send route is `502 commands_unavailable` before dispatch.
   - If phase 0 selected Hanse-only: no upstream call; GET returns `sources.opencode =
     "unavailable"` + `commands_unavailable`; POST returns `502 commands_unavailable` before
     dispatch.

2. `src/http/server.ts`: import and register `isCommandsRoute`/`handleCommands` before `isChat`, in the
   existing ternary chain.

3. `src/http/handler.ts`: add `logger?: Logger` to `HttpDeps` (optional; tests may omit it).
   `src/cli/commands.ts`: pass `logger: createLogger()` into `createHttpServer`.

4. `test/slash-commands.test.ts`, using a local fixture modeled on `test/context-http.test.ts` and a
   `fakeOpencodeHandler` modeled on `test/chat-page.test.ts`:
   - GET auth matrix (401/403 agent/200 human), project disambiguation, unknown app, wrong method.
   - Deletion markers for both `app.deleting` and `project.deleting` -> 409 before any manager or
     `stopped` branch; `manager === undefined` -> `unconfigured`; `isRunning` false -> `stopped` and
     zero `ensure` calls; running -> `ensure` + list; `ensure` reporting a stopped instance ->
     `stopped`.
   - Upstream list 404/5xx/oversized/non-array -> `unavailable`; merged list; no `template` anywhere
     in the JSON; shell tri-state; summary cache: two GETs within 5 s make one upstream call, after
     the TTL a second call is made and a changed upstream template does not leak.
   - POST auth/Origin/content-type/JSON/empty/invalid/oversize (arguments > 32 KiB, and the global
     64 KiB body cap); agent + unknown app -> 403 not 404;
     deletion 409 before `ensure`; unconfigured 503; `ensure` failure 502 `agent_unavailable`;
     unknown command -> 404 after exactly two fresh list calls; no Hanse action dispatch
     (`POST {name:"help"}` -> 404).
   - Shell: fresh-list TOCTOU (cached GET says `none`, fresh POST template has a block ->
     `shell_confirmation_required`); argument-injected block -> 400 then success with
     `confirmShell:true`; non-string/MCP template -> `unknown` -> 400 then success; `confirmShell`
     never forwarded upstream.
   - Success 202 exact body; `messageID` forwarded exactly; upstream `{info,parts}` body not
     returned; missing session -> early 502 `command_failed`/`unknown` with `messageID` and fixed
     message; no upstream body or sentinel template in the response or logs.
   - Post-window failure: upstream holds, route returns 202, then the upstream 500 is logged and not
     returned. Test the 30 min abort at the client-function level with a small `timeoutMs` and a
     never-ending upstream; assert the rejection is status 0 and no 202 reversal is attempted.
   - v2 cases only when phase 0 selects v2: list query form, `{name, text}` mapping, `204`,
     no `messageID` forwarded, known-absent send -> 502 before dispatch.
   - 500-per-list extras -> `command_dropped` (not the merged cap); merged cap route test: synthetic
     many entries -> serialized body <= 1 MiB, one `command_cap_reached`, Hanse entries present.

### Acceptance criteria

- Route dispatch reaches `handleCommands` for both paths and never falls into `isChat`.
- GET returns 200 for a known non-deleting app in every runtime state; the only non-200 responses are
  the documented 401/403/404/405/409 auth/unknown/deletion/method cases. A stopped app is not
  started.
- POST returns 202 only after a successful dispatch start; every tested pre-dispatch failure is
  `not_sent` and every tested in-window post-dispatch failure is `unknown` with the same `messageID`.
- No response or log contains a template, upstream body, expanded prompt, or `OpencodeHttpError`
  message/body excerpt.
- `messageID` is forwarded to v1 and absent from the v2 send body.

### Risks

- The 750 ms window makes a few tests wait; keep the count small and do not add an artificial
  configuration flag.
- Node keeps the background request alive after the response; tests must release or close the fake
  upstream and must not leave an unhandled rejection.
- A fake `manager.ensure` must also stub `isRunning`; forgetting it hides the no-start invariant.
- `cache-control: no-store` and the summary cache are easy to conflate; test both.

### Verification for this phase

```bash
npx vitest run test/slash-commands.test.ts
npm run typecheck
npm run lint
```

### Outcome

2026-10-23 - Phase 2 implemented `src/http/commands.ts` (GET list and detached POST, auth/Origin/
content-type ordering, deletion-first, 5 s endpoint summary cache, merged/capped response, fixed
messages, structured logging), wired `isCommandsRoute`/`handleCommands` before `isChat`, added
`HttpDeps.logger`, and wired `createLogger()` in the CLI. `test/slash-commands.test.ts` (41 tests)
passes; `npm run typecheck` and targeted Biome checks are clean. Deviation: the manager API exposes
`ensure(): Promise<string>` and `isRunning(): boolean`, so the `stopped` branch uses `isRunning`
(there is no ensure "stopped" result). Repository-wide lint remains blocked by the unrelated
untracked `src/skills/tool-projection.ts` formatting issue.

## Phase 3 - Client: pure helpers, palette, actions, confirmation, browser QA

### Boundaries

- New `assets/chat-commands.js`; `assets/chat.js`; `src/http/chat.ts`; `src/http/handler.ts` asset
  allowlist; `src/http/styles.css`; `test/chat-commands.test.ts`; `test/chat-page.test.ts`;
  `docs/design/chat-qa.mjs`; `docs/design/artifacts/chat/README.md`.
- No server route semantics beyond the `data-*` attributes and the confirm dialog markup.

### Invariants

- `assets/chat-commands.js` is pure (no DOM/network/timers), same style as `assets/chat-core.js`:
  plain objects/Maps, JSDoc types, importable by Vitest.
- The palette inserts; it never executes. Execution is the existing composer submit.
- The palette rebuilds on filter changes only and never replaces the feed; it opens in-flow and never
  covers the draft.
- The command branch in `sendPrompt` is placed **after** `acceptanceInFlight()`/`acceptanceUnknown()`
  and **before** the unconditional `activePromptEntries()` block, and `dispatchComposerDraft()`
  re-checks both.
- Palette-open Enter/Tab inserts and does not submit; form submit while open also inserts. Palette-
  closed Enter keeps today's submit behavior; Shift+Enter keeps the newline.
- A disabled row (`available:false`) stays visible with `aria-disabled="true"` and
  `aria-selected="false"`, is skipped by Arrow/Home/End, and is not activated by Enter/Tab.
- The shell badge is text plus an accessible description, not color alone.
- Untrusted command names/descriptions/hints are inserted with `textContent`, never `innerHTML`; no
  links are created from descriptions or hints.
- `shell: present|unknown` requires the reusable confirm dialog; a cancelled confirmation restores
  the draft and sends nothing.
- A stale-list `400 shell_confirmation_required` retries once with `confirmShell:true` and **reuses
  the existing optimistic row**; a second 400 is an error.
- Pre-dispatch failures remove the optimistic row and restore the draft; post-dispatch
  `502 command_failed`/`unknown` keeps the row, rekeys when possible, and enters the existing
  unknown-acceptance state.
- The pending-question lock blocks server commands and `new`/`compact`/`restart`; `help`/`editor`/
  `diff` remain available. The existing New session button is unchanged; only the `/new` command path
  is stricter.
- The master client disables `editor` and `diff`; `/restart` remains available with confirmation. The
  existing topbar/rail IDE link and New session button are unchanged.

### Work

1. `assets/chat-commands.js`:
   - `parseComposerCommand(text)` returning `{kind:"text", text}` or
     `{kind:"command", token, args}` using the trimmed text and
     `/^\/([^\s]+)(?:\s+([\s\S]*))?$/`; bare `/` and `//foo` are ordinary text with the unknown
     hint at the call site.
   - `matchCommand(commands, token)`: exact canonical/alias lookup with upstream shadowing.
   - `filterCommands(commands, query)`: case-insensitive substring over name, aliases, description.
   - `groupCommands(commands)`: Hanse group then `Application commands`.
   - `commandLine(name, args)`: `/${name}` plus a trailing space (or `/${name} ${args}` when
     provided).
   - `shellRequiresConfirmation(shell)`: true for `present`/`unknown`.
   - `commandBlockedByPending(entry, pending)`: true for opencode entries and
     `new`/`compact`/`restart`; false for `help`/`editor`/`diff`.
   - `resolveComposerCommand(commands, token, options)`: returns opencode/Hanse/unknown/disabled,
     applies the client `HANSE_ACTIONS` fallback when the list is unavailable, applies the master
     flag, reports the shadow hint, and maps an unknown action id to a disabled row ("Not available
     in this build").
   - `HANSE_ACTIONS`: canonical name, aliases, action id, one-line description, and master
     availability for the six entries.

2. `src/http/chat.ts`:
   - Add `data-ide-url`, `data-app-url`, and `data-master` (`"1"` only for the master) to
     `#chat-shell`.
   - Add the palette container and listbox directly above the composer, after `#chat-prompt-dock`
     and before `#chat-composer`: outer `#chat-command-palette` (hidden), `#chat-command-listbox`
     with `role="listbox"`, `#chat-command-status`, and the shadow footer.
   - Add the single `Commands` icon button to the composer row (`#chat-commands-button`).
   - Add the reusable confirm dialog `<dialog class="dialog" id="chat-command-confirm">` with a
     labelled title (`#chat-command-confirm-title`), body, confirm/cancel buttons, `aria-modal`,
     focus trap via `showModal()`, Escape close, and focus restoration.
   - Keep the existing textarea and Send button behavior; add `role="combobox"`,
     `aria-autocomplete="list"`, `aria-haspopup="listbox"`,
     `aria-controls="chat-command-listbox"`, and JS-managed `aria-expanded`/
     `aria-activedescendant` while the palette is open. The listbox is `role="listbox"`, rows are
     `role="option"`, and groups are `role="group"` with labels.

3. `src/http/handler.ts`: add `/assets/chat-commands.js` to `ASSETS` with the same
   `text/javascript; charset=utf-8` content type.

4. `assets/chat.js`:
   - Import the pure helpers; add state `commands`, `commandsStatus`, `commandsFetchedAt`,
     `commandsShadowed`, `paletteOpen`, `paletteFilter`, `paletteActive`, `paletteRows`.
   - Fetch `GET /commands` on first palette open and after `stream.ready`; cache 30 s; refetch after
     `404 command_not_found` and on app change; preserve the open palette/filter/active row when
     possible.
   - Render rows with `textContent`, badges `Hanse`/`MCP`/`Skill`/`Shell`/`Shell unknown`, disabled
     rows with reason, group headers, 200-row render cap + "Refine your search", and the empty
     states from design §7.2.
   - Add the `/` trigger when the composer is empty or the selection covers the whole draft, the
     Commands button, and the keyboard precedence in the existing keydown handler and form submit.
   - Insert the canonical `/name ` on Enter/Tab; Escape closes and focuses the composer; announce the
     result count and "No matching commands" through `#chat-announcer`.
   - Add `dispatchComposerDraft()` and the single early branch in `sendPrompt` at the placement above.
     Handled commands return; ordinary text falls through to the existing trimmed text path.
   - Implement `sendServerCommand(name, args, shell)` with the confirm dialog, optimistic row,
     POST, 202 rekey, stale-400 single retry, unknown-acceptance handling, and draft restoration
     rules.
   - Implement the six actions with existing functions: `startDraft({focus:true})`;
     palette open/focus; `window.open(data-ide-url)` with `location.assign` fallback; `window.open(
     data-app-url + "#changes-title")` with the same fallback; the `contextCompactReasonFor` ->
     `setContext` -> `openContextConfirm` -> re-read reason sequence plus `compactContext`; restart
     confirm -> `POST /api/apps/:app/restart?project=<PROJECT_ID>&async=1` with `409
     restart_in_progress` mapping. Use the design §7.3/§7.4 confirmation copy verbatim and the
     popup-blocked notice "Opened in this tab because the popup was blocked." Focus the existing
     compact confirm button when it opens.
   - Apply the pending lock, no-argument rejection inline hint, `/help [name]` filter, and
     direct-typed shadow hint (`showToast`) per design §7.3.
   - On 202, if the phase-0 probe says v1 honors `messageID`, rekey the optimistic row; if v2 (or the
     probe says `messageID` is ignored), do not insert an optimistic command row and hydrate from the
     next snapshot/SSE. On accepted-row absence after hydration, reuse the existing 5 s
     unknown-acceptance grace; never auto-drop.

5. `src/http/styles.css`: add only in-flow palette (never covers the draft), badge, disabled-row,
   confirm-dialog hook, 44 px touch rows below 768, and reduced-motion styles (opacity only) using
   existing chart-room tokens. Do not restyle chat.

6. `test/chat-commands.test.ts`: pure cases from the design §14 client parser row: `/name`,
   `/name args`, multi-line args, aliases, exact case sensitivity, leading whitespace, trimmed
   normal text, `//foo` literal with hint, bare `/`, unknown slash -> literal + hint, empty name,
   no-command fallback, palette filter, direct-typed shadow, `commandLine`, shell confirmation, and
   `commandBlockedByPending` for each action.

7. `test/chat-page.test.ts`: page HTML has the palette/listbox, Commands button, confirm dialog,
   `data-ide-url`, `data-app-url`, and master/non-master `data-master`; the asset allowlist serves
   `/assets/chat-commands.js`; `chat.js` source contains `dispatchComposerDraft`, the palette
   branch, and no template interpolation.

8. `docs/design/chat-qa.mjs`:
   - Extend `installRoutes` with a `commands` fixture (GET list with Hanse + opencode entries, one
     `shell:"present"`, one `shell:"unknown"`, one shadow, one disabled, and a POST state machine)
     and a `commands` cache counter.
   - Add deterministic scenarios and captures: `commands-palette` (open via `/` and the button,
     filter, keyboard, insert-vs-submit, disabled skip, ARIA/announcer), `commands-shell-confirm`,
     `commands-shell-unknown`, `commands-stale-400` (one optimistic row, reused and rekeyed),
     `commands-unknown-literal` (`//foo` and an unknown slash sent verbatim with the hint),
     `commands-master` (editor/diff disabled), `commands-popup` (same-tab fallback), and
     `commands-widths` (390/768/1440 dark/light, no horizontal overflow, 44 px rows).
   - Assert no console/page errors; filter only deliberate non-2xx resource logs.
   - Update `docs/design/artifacts/chat/README.md` with the new scenario names, captures, and the
     fixture description. Do not commit live-run artifacts.

### Acceptance criteria

- Typing `/` opens the palette; Arrow/Home/End skip disabled rows; Enter/Tab inserts and never
  executes; Escape closes and focuses the composer; composer Enter still submits.
- Selecting an opencode command posts `{name, arguments, confirmShell}` with the exact name and raw
  arguments; Hanse names are never posted.
- A `present`/`unknown` command requires the dialog before the POST; cancelling restores the draft and
  sends nothing.
- The stale-400 path creates exactly one optimistic row, retries once, and rekeys that row.
- The pending-question lock blocks the correct action set and leaves navigation actions available.
- Master `/editor` and `/diff` rows are visible, disabled, and carry the reason.
- No template, upstream body, or error text enters the DOM; all untrusted text is `textContent`.
- The deterministic QA report records every new scenario with zero console/page errors at 390/768/
  1440, dark and light.

### Risks

- `sendPrompt` is the most load-bearing chat path; the branch placement is specified above and the
  regression gate is both the existing chat tests and the full browser harness.
- The palette can regress focus/ARIA; use the existing `#chat-announcer`, a real combobox/listbox
  contract, and browser assertions rather than source-only checks.
- `window.open` may be blocked; the same-tab fallback must be exercised in `commands-popup`.
- A stale list can make the client ask for confirmation twice; the server's fresh-list decision is
  authoritative and the client retries only once.
- The browser harness fixture must model the 5 s/30 s caches without real waits; use per-scenario
  route counters.

### Verification for this phase

```bash
npx vitest run test/chat-commands.test.ts test/chat-page.test.ts
npm run build
node docs/design/chat-qa.mjs
npm run typecheck
npm run lint
```

### Outcome

2026-10-23 - Phase 3 shipped the pure `assets/chat-commands.js` (37 tests), the in-flow palette
markup in `src/http/chat.ts` (combobox/listbox, six actions, confirm dialog, `data-*` attributes),
`assets/chat.js` integration (30 s list cache, `/` + Commands button, insert-vs-submit, shell
confirmation, stale-400 single retry, optimistic/unknown handling, pending lock, master disables,
popup fallback), `src/http/styles.css`, the `assets/chat-commands.js` allowlist,
`test/chat-page.test.ts` page/source guards, and the new deterministic `chat-qa` scenarios and
captures. Focused vitest: 90 passed (37 + 53). `npm run typecheck`, `npm run build`, and
`node docs/design/chat-qa.mjs` passed: 22 scenarios, 429 assertions, 45 screenshots, zero
console/page errors. No server route semantics changed.

## Phase 4 - Integration, documentation, full gates, and live smoke

### Boundaries

- `docs/current-state.md` (chat section and asset allowlist), `docs/design/README.md` (status only).
- Verification runs only; no new feature code. Fixes must stay inside this plan's files and phases.

### Invariants

- Docs describe only what is implemented: one merged palette, six actions, 25 skips, two deferrals,
  the version branch actually selected, and the accepted limits.
- The design index status changes from "plan pending" to implemented/verified only after the gates
  and live smoke pass.
- Live evidence is not committed; only sanitized deterministic artifacts and reports are tracked.

### Work

1. Update `docs/current-state.md`:
   - Chat section: the palette, the six actions, the two routes, human-only/JSON/Origin rules, shell
     confirmation, the 202/unknown boundary, the 25 skips/2 deferrals, the v1/v2/hanse-only outcome.
   - Web UI asset allowlist: add `/assets/chat-commands.js`.
   - Known limitations: no template expansion, no `/model`/`/stop`, `/diff` is worktree-wide, no
     session-scoped aggregate diff, `/editor`/`/diff` disabled for the master.

2. Update `docs/design/README.md`: slash-commands status to implemented and verified, pointing at
   journal 0025 (written in phase 5). Do not rewrite the design body.

3. Run the full gates and browser QA:

   ```bash
   npm run lint
   npm run typecheck
   npm test
   npm run build
   node docs/design/chat-qa.mjs
   npm run check:sensitive
   ```

4. Run the live real-agent smoke on a test application at the pinned version. Use placeholders in any
   record; do not commit the report or screenshots:

   ```bash
   CHAT_QA_URL=<COORDINATOR_URL> CHAT_QA_TOKEN=<OPERATOR_TOKEN> \
   CHAT_QA_APP=<APP_KEY> CHAT_QA_PROJECT=<PROJECT_ID> \
   CHAT_QA_LIVE_SESSION=<SESSION_ID> \
   node docs/design/chat-qa.mjs --live
   ```

   Also verify manually: create a synthetic `.opencode/command/<probe>.md`, confirm it appears with no
   `template` in `GET /commands`, run it with an argument and see the expanded prompt plus response
   over SSE; add an inline shell-block command and an argument-injected command and confirm the gate;
   run `/new`, `/help`, `/editor`, `/diff`, `/compact`, `/restart`; confirm an agent principal gets
   403; confirm a stopped app lists Hanse-only and refetches after start; confirm the master disables
   `/editor` and `/diff`.

### Acceptance criteria

- The four project gates are green with no skipped tests.
- The deterministic chat QA report is `PASS` with the new command scenarios, the required viewports,
  and zero console/page errors.
- The live smoke passes every listed check, or a blocked prerequisite is recorded explicitly; a live
  miss is not reported as a pass.
- `docs/current-state.md` and the design index match the implemented behavior and the phase-0 branch.
- `npm run check:sensitive` passes; no live artifact or host-specific data is tracked.

### Risks

- Browser QA needs a built `dist/`; run `npm run build` before `chat-qa`.
- The live smoke can be blocked by credentials, a stopped runtime, or a missing test app; record the
  blocker instead of weakening the gate.
- `docs/current-state.md` has unrelated uncommitted work in the tree; stage only the hunks this plan
  owns and verify the cached diff.

### Verification for this phase

```bash
npm run lint && npm run typecheck && npm test && npm run build
node docs/design/chat-qa.mjs
npm run check:sensitive
```

### Outcome

2026-10-23 - `docs/current-state.md` now documents the palette, the two routes, the six actions, the
shell confirmation, the 202/unknown boundary, the 25 skips/2 deferrals, and the v1 decision; the
asset allowlist includes `/assets/chat-commands.js`. The design index points at journal 0025. Full
gates passed with the concurrent app-skill changes present: `npm run lint`, `npm run typecheck`,
`npm test` (107 files, 1,844 tests), `npm run build`, `node docs/design/chat-qa.mjs` (22 scenarios,
429 assertions, 45 screenshots, zero console/page errors), and `npm run check:sensitive`. The live
real-agent smoke is **blocked**: no coordinator URL, operator token, test app, or session is available
in this environment; no live result is claimed. The v1 branch was implemented; v2 and Hanse-only
remain documented contingencies only.

## Phase 5 - Stage record

### Boundaries

- `docs/journal/0025-slash-commands.md`, `docs/journal/README.md`, and the plan index status line.
- No code, tests, design body, or owner record changes.

### Invariants

- The record is evidence, not a rewrite of the design.
- It states the phase-0 decision and the probe evidence path, the exact test/QA counts, and every
  deviation or accepted risk.
- It does not name the deployment host, real apps/projects/sessions, or live artifacts.

### Work

1. Write `docs/journal/0025-slash-commands.md` with:
   - the phase-0 branch (`v1`/`v2`/`hanse-only`), the evidence path, and any blocked probe row;
   - what shipped: one catalog, two routes, one palette, six actions, the shell gate, the detached
     202 boundary;
   - decisions retained: upstream-wins collision, never-return-template, fresh-list POST, GET-only
     summary cache, 25 skips/2 deferrals;
   - verification evidence: unit/HTTP counts, deterministic browser report, live smoke result, gate
     results;
   - deviations and accepted risks: the 30 min abort semantics, `confirmShell` is not proof of human
     confirmation, same-tenant loopback access, optimistic-row unknown handling after a coordinator
     restart, worktree-wide `/diff`, master disables;
   - rollback notes (additive routes/palette, no migration) and the commit/deploy state.
2. Add the line to `docs/journal/README.md`.
3. Update the `docs/plans/README.md` entry status to implemented and verified with the journal
   reference.
4. Commit only after explicit owner authorization, as one coherent Conventional Commit covering the
   code, tests, docs, and record; never stage `docs/deploy/` or live artifacts.

### Acceptance criteria

- The journal record contains the phase-0 decision, evidence paths, counts, deviations, and accepted
  risks, and is linked from the index.
- The plan index has one entry for `0021-slash-commands` with the final status.
- `git diff --cached --name-only` contains only this stage's files and no secrets/host specifics.
- The commit message follows Conventional Commits and the commit is created only with owner
  authorization.

### Verification for this phase

```bash
npm run check:sensitive
git status --short
git diff --cached --name-only
```

### Outcome

2026-10-23 - Wrote journal 0025, updated the journal index, the plan index status, the design index
status (`implemented and verified (journal 0025); commit pending`), and the plan header. No code,
tests, design body, or owner record changed in this phase. The stage is ready for one coherent
commit once the owner authorizes it; nothing was committed.

## Requirements traceability

| Requirement | Plan phase |
| --- | --- |
| R1 palette lists both sources, grouped and filtered | 1 (metadata), 3 (palette), 4 (QA) |
| R2 exact name + raw arguments, no expansion | 1 (client functions), 2 (forwarding), 3 (parser) |
| R3 six actions reuse existing behavior; shell confirmation | 2 (gate), 3 (actions/dialog) |
| R4 display-only metadata, never `template`, bounded | 1 (whitelist/caps), 2 (DTO/route), 3 (render) |
| R5 human-only, JSON-only, same-origin | 2 (auth/Origin), 2 (tests) |
| R6 detached 202, early window, unknown outcome | 2 (dispatch), 3 (optimistic/unknown), 4 (live) |
| R7 normal/unknown/bare `/` text path unchanged | 1 (parser), 3 (send branch), 4 (regression) |
| R8 v1 primary, v2 contingency, Hanse-only degrade | 0 (probe/gate), 1 (branch), 2 (mapping) |
| R9 no migration/dependency/framework/bundler | all phases; verified in 4 by gates and diff |
| R10 lint/typecheck/test/build plus unit/HTTP/browser/live | 1-4, record in 5 |
| Design §9 scope: 5 TUI-local + `/restart`, 25 skips, 2 deferrals | 1 (registry), 3 (actions), 4 (docs) |

## Risk register

| Risk | Mitigation |
| --- | --- |
| 1.19.3 route/shape drift | Phase 0 gate; `/doc` + live presence; whitelist tolerates field differences; degrade to `unavailable`/Hanse-only. |
| Blocking/disconnect and the 30 min cap | Detached 202 after 750 ms; background fetch with a 30 min abort; log `commands.send.timeout`; no 202 reversal; accepted. |
| MCP `template` Promise serialization | `detectShell` returns `unknown` for any non-string; GET never template; unit + live probe. |
| Argument-injected shell blocks | Scan `arguments` with the exact pattern before dispatch; require `confirmShell`; HTTP test. |
| Coordinator restart after 202 | Transcript authoritative; accepted-row 5 s absence -> existing unknown state with Check again/Remove; no recovery marker. |
| Master app | Server marks `editor`/`diff` unavailable with reasons; client fallback checks `data-master`; `/restart` allowed with confirmation. |
| ARIA/popup blockers | Combobox/listbox contract, announcer, focus trap/restoration, same-tab fallback; browser assertions. |
| Test-fixture complexity | Local fixture modeled on `context-http.test.ts`; fake upstream handler modeled on `chat-page.test.ts`; no new test dependency. |
| Merged 1 MiB cap | Explicit serialized-byte loop; one `command_cap_reached`; Hanse entries preserved; route test. |
| New dependency or migration | Forbidden; no schema change; no bundler/framework; diff review in phase 4. |
| Template/error leakage | Whitelist, fixed messages, no upstream body in responses/logs, sentinel-leak tests. |
| Concurrent writes / stale list | POST ignores the summary cache; fresh list twice on a name miss; client retries once and reuses the row. |

## Rollback

- Remove the two route registrations and `src/http/commands.ts`; the chat page falls back to text
  send because the palette branch is additive.
- Remove the palette markup/module import and the `chat-commands.js` asset entry; ordinary text and
  SSE are untouched.
- No database migration or durable state exists, so there is no data rollback.
- No feature flag is introduced; rollback is a revert of the additive stage commit.

## Verification matrix

| Area | Command / evidence |
| --- | --- |
| Pure registry/merge/shell/caps | `npx vitest run test/commands-registry.test.ts` |
| HTTP routes and error mapping | `npx vitest run test/slash-commands.test.ts` |
| Pure client helpers | `npx vitest run test/chat-commands.test.ts` |
| Page markup, asset allowlist, source guards | `npx vitest run test/chat-page.test.ts` |
| Existing chat/context regressions | `npx vitest run test/chat-page.test.ts test/context-http.test.ts` |
| Full suite | `npm test` |
| Static gates | `npm run lint`, `npm run typecheck`, `npm run build` |
| Browser QA | `node docs/design/chat-qa.mjs` |
| Live smoke | `CHAT_QA_URL=<COORDINATOR_URL> CHAT_QA_TOKEN=<OPERATOR_TOKEN> CHAT_QA_APP=<APP_KEY> CHAT_QA_PROJECT=<PROJECT_ID> CHAT_QA_LIVE_SESSION=<SESSION_ID> node docs/design/chat-qa.mjs --live` |
| Sensitive data | `npm run check:sensitive` |

## Plan review record

`momus` reviewed this plan on 2026-10-23 and returned **OKAY**: every phase has a concrete starting
point, no blocking contradiction was found, the referenced design/owner/source/test/QA artifacts
exist, and the phase-level verification plus acceptance criteria are executable. No findings required
changes. The design and owner records were not reopened. Implementation is cleared to start with
Phase 0; the version decision remains gated by the Phase 0 probe.
