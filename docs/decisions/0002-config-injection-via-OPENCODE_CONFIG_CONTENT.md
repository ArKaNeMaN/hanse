# 2. Inject coordinator config via OPENCODE_CONFIG_CONTENT

- Status: Accepted
- Date: 2026-10-16

## Context

The coordinator must add its MCP server and project-shared instructions to each application's
opencode instance **without** modifying the application repository (applications must stay portable).

## Decision

Inject the overlay through the `OPENCODE_CONFIG_CONTENT` environment variable, the highest
non-managed opencode config layer.

Do not use:

- `OPENCODE_CONFIG` - project config overrides it;
- `OPENCODE_CONFIG_DIR` - on opencode v2 it replaces the global config directory.

## Consequences

- Application repositories stay clean and portable.
- The overlay can add a new MCP server name safely. Redefining an existing server name replaces it
  (v1 deep-merges; v2 last-definition-wins), so the coordinator uses its own name.
- `instructions` and `plugins` concatenate across sources.
