# 0009 - Coordinator-hosted SSH host access

- Status: accepted
- Date: 2026-10-21
- Stage: `0011-ssh-host-access`
- Supersedes: none

## Context

Agents need controlled access to operator-managed servers for deploys and configuration. The host
private keys must not enter the app container, and each application needs its own allowlist. The
alternatives were:

1. Materialize host keys into the app HOME (like per-app git credentials).
2. Run a keyless MCP shim in the app container and execute SSH in the coordinator.
3. Add a separate `ssh-gateway` service.
4. Run SSH in the runner.

## Decision

Execute SSH/SFTP in the **coordinator** behind a narrow `SshService`, reached through the existing
per-app stdio-to-HTTP MCP bridge. The app container gets only a keyless shim; every call is
authorized against `app_ssh_hosts`, approval grants, and the DB. Host keys are encrypted with the
coordinator `secret.key` and decrypted only for the operation.

## Consequences

- No new component, network, image, or credential store. The coordinator is already attached to every
  app network and holds the database, secret key, operator UI, and audit.
- The coordinator becomes an SSH client and holds plaintext host keys in memory during a connection.
  This is the same trust class as the existing provider keys, DB, and operator token; a coordinator
  compromise already exposes the deployment.
- A gateway only improves compartmentalization if it owns its key material and authenticates the app
  itself. Behind the coordinator, a coordinator compromise can impersonate any app. That complexity is
  deferred until there is a multi-operator or key-compartmentalization requirement.
- The runner is not suitable: it is root-equivalent through the Docker socket, has no database, and is
  not attached to app networks.

## Alternatives rejected

- **App HOME materialization:** the agent could read every host key.
- **In-app MCP with keys:** same leak.
- **Separate gateway:** operational cost and a second authorization system without a matching
  security gain for a single-operator, trusted-LAN deployment.
