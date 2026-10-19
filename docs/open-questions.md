# Open questions

> Stage: `0006-web-tools-and-settings`. Owner decisions were collected before the plan was written.
> This file is the record required by `docs/process.md`; there are no open items for this stage.

## Resolved owner decisions

1. **Settings storage** — store global/project/application settings in the coordinator SQLite
   database, not in `.hanse` manifests. Rationale: WebUI-first, no repo writes, one source of truth.
2. **Web tool transport** — use a separate per-app `hanse_web` stdio MCP server, registered only when
   at least one of search/fetch uses a managed driver. Rationale: asynchronous from day one,
   independent from the handoff server, conditional process.
3. **Provider credentials** — edit model-provider API keys in the settings UI. Store them encrypted
   with the existing AES-256-GCM secret key; never return key material from the API. Reuse the same
   provider key for the DeepSeek web driver unless the driver names another provider.
4. **Built-in web tools** — expose the existing OMO/opencode web tools as the `builtin` driver
   option. When a managed driver is selected, disable the corresponding built-in (OMO `websearch`
   via `disabled_mcps`; opencode `webfetch` via permission). `null` disables the tool entirely.
5. **Driver fields** — render fields from the driver registry. `builtin` has no fields; `deepseek`
   exposes provider selection and request options (count, need_content, timeout, content cap).
6. **Applying changes** — never auto-restart. Save settings, show a pending marker, and provide an
   explicit restart action. Sessions survive a restart; the next message starts the new process.
7. **Model clear semantics** — `llm.model` is a scalar with a default and is not clearable. The UI
   offers Inherit/Set; the API rejects Clear. The explicit-empty-override requirement applies to the
   web tool settings (search/fetch), which are clearable.

## Deliberate non-goals

- Model provider discovery / a model picker (the model remains a string in this stage).
- Additional web drivers beyond built-in and DeepSeek.
- Per-instance isolation of all OMO state (only the config profile selection is isolated).
- Hard secret isolation from same-uid agents; this remains a known trust-model limitation.
