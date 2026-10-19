# 6. Hierarchical settings and encrypted provider keys

- Status: Accepted
- Date: 2026-10-19
- Stage: `0006-web-tools-and-settings`
- Design: [`docs/design/web-tools-and-settings.md`](../design/web-tools-and-settings.md)

## Context

Hanse had no operator-editable settings surface. The coordinator injected a fixed
`OPENCODE_CONFIG_CONTENT` overlay and copied the host opencode `auth.json` into each instance. The
owner needs global, project, and application settings with explicit overrides, a selectable model,
provider API keys, and optional web tools. Model selection must also reach OMO subagents, whose
image-baked config pins every agent/category.

## Decision

1. Store non-secret settings in the coordinator SQLite database in a `settings` table keyed by
   `(scope, project_id, app_key, key)`. Valid scopes are `global`, `project`, and `app`.
2. Use three-state semantics: an absent row inherits, a row with JSON `null` is an explicit empty
   override, and a value is applied. The key registry declares `replace` or `append` per key and
   whether the key is clearable.
3. Store model-provider API keys in a separate `provider_keys` table encrypted with the existing
   AES-256-GCM key. A clear writes a tombstone with null ciphertext; an inherit deletes the row.
   Provider keys are never returned by the settings API. A settings key overrides the host auth
   entry; a cleared key suppresses it; otherwise the host `HANSE_AUTH_FILE` entry is used.
4. Expose settings only through human-only routes. The API returns statuses and effective/scoped
   values, never key material.
5. Make `llm.model` a non-clearable scalar with the default `deepseek/deepseek-flash`. The explicit
   empty-override requirement applies to `web.search` and `web.fetch`.
6. Apply changes only on an explicit restart. Running instances record the settings/auth/profile
   snapshot hash and an `appliedProfile` flag; the UI shows a pending marker and a restart action.
7. Persist a per-app OMO profile with `OMO_PROFILE` so the selected model reaches OMO agents and
   categories. The profile path is the image-managed `~/.omo/omo.jsonc`; writes are serialized and
   atomic.

## Consequences

Positive:

- One settings surface and one source of truth; no settings are written into managed repositories.
- Explicit empty overrides work for web tools, and provider keys are encrypted at rest.
- The selected model is deterministic for new sessions and OMO subagents, without changing HOME.
- Settings changes are visible and safe: nothing is auto-restarted.

Negative / residual:

- Settings do not travel with a cloned project; they live in the coordinator state directory.
- Agents run as the same uid and can read the per-instance `auth.json` and coordinator state; this
  does not change the existing trust model.
- Provider-key ciphertext is not AAD-bound to scope/provider, and key rotation is not implemented.
- Clearing a provider key is logical: `secure_delete` plus a WAL checkpoint removes the previous page
  in normal operation, but physical media/backups may retain old pages. It is not a hard erasure
  guarantee.
- Existing opencode sessions may retain their session model after a restart.
- OMO's shared config file and project `.omo` layers can affect profile application; the design
  records the warning/verification strategy and residual risk.
- The internal `settings`/`provider_keys` schema is forward-only; rollback must remove the v3
  `schema_migrations` row as well as the tables.
