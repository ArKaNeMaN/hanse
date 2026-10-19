# 7. Web tool drivers and transport

- Status: Accepted
- Date: 2026-10-19
- Stage: `0006-web-tools-and-settings`
- Design: [`docs/design/web-tools-and-settings.md`](../design/web-tools-and-settings.md)

## Context

The owner wants optional common `web_search`/`web_fetch` tools with per-provider drivers. DeepSeek
exposes standalone Search/Fetch APIs. Hanse already ships opencode/OMO web tools and a synchronous
handoff MCP server. The common tools must be invisible when not configured, and provider selection
must be a settings choice.

## Decision

1. Use a separate per-app `hanse_web` stdio MCP server for managed tools. Register it in
   `OPENCODE_CONFIG_CONTENT` only when at least one of search/fetch uses the managed DeepSeek driver.
2. Offer `builtin` and `deepseek` as per-tool driver choices. `builtin` search uses the OMO
   `websearch` MCP and `builtin` fetch uses opencode `webfetch`; `deepseek` uses the standalone
   Search/Fetch endpoints.
3. When a managed driver is selected, disable the corresponding built-in for that app. For search,
   add `websearch` to the per-app OMO profile's `disabled_mcps` and deny the `websearch` permission;
   for fetch, deny `webfetch`. When built-in is selected, leave the built-in enabled.
4. Require a per-tool provider credential from the reconciled per-instance `auth.json`; never put
   key material in `HANSE_WEB_CONFIG`, the overlay, or the settings API.
5. Expose only tools with a valid managed config and usable credential. Unknown/disabled tools are
   JSON-RPC errors; credential/driver failures are `isError` results with safe text.
6. Treat web content as untrusted: label it in the tool description, cap content and result count,
   validate query length and fetch URLs, and never log keys or full request bodies.
7. Keep the `hanse_web` server asynchronous; do not turn the synchronous handoff server into a
   network I/O server.

## Consequences

Positive:

- One common tool surface with per-provider drivers and a clear built-in fallback.
- Optional tools are absent from `tools/list` when disabled or unusable.
- The configured driver is authoritative because the corresponding built-in is disabled.
- The handoff MCP server remains small and stable.

Negative / residual:

- One extra process per app when a managed driver is enabled (and an empty server may exist when a
  managed driver has no credential).
- Adding a driver requires a code module and registry entry; the initial stage only implements
  DeepSeek.
- DeepSeek endpoint/pricing/rate-limit behavior can change; the driver tests pin the documented
  shape and a live call is optional.
- Built-in search depends on the OMO baseline; without OMO, built-in search warns and has no tool.
- OMO `disabled_mcps` is unioned, so a base config that already disables `websearch` cannot be
  re-enabled for `builtin`.
