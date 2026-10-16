# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private security advisory
feature for this repository instead.

## Scope

`hanse` runs coding agents and handles repository credentials. Reports about credential handling,
sandbox isolation, the coordinator's cross-application messaging, or the web UI are especially
welcome.

## Practices

- Never commit secrets. Runtime credentials are expected to live in the coordinator's encrypted
  store or in an application's local `.env`, never in a managed repository.
- Credentials are injected at runtime (for example via `GIT_ASKPASS` or `GIT_SSH_COMMAND`), not
  written into repository configuration.
