#!/usr/bin/env bash
# Reject deployment-specific data in tracked files. Runbooks and live evidence stay in docs/deploy/.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
scan() {
  local label="$1" pattern="$2"
  shift 2
  local output
  if output=$(git grep -nIP -e "$pattern" -- "$@" 2>/dev/null); then
    printf '\n%s\n%s\n' "$label" "$output"
    fail=1
  fi
}

# Private network addresses; test fixtures and documentation examples are excluded.
scan "private network address in tracked files" \
  '(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])' \
  ':!test/**' ':!docs/design/ssh-host-access.md' ':!src/http/ssh.ts'

# Short host aliases with a numeric suffix.
scan "deployment host alias in tracked files" \
  '\bsrv[0-9]+\b'

# Absolute personal home paths; container users used by the project are allowed.
scan "absolute home path in tracked files" \
  '(?<![\w.-])(/home|/Users)/(?!coder\b|node\b|you\b|user\b|app\b|agent\b)[A-Za-z0-9_][A-Za-z0-9._-]*' \
  ':!test/**'

# Common credential formats.
scan "credential-like literal in tracked files" \
  '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})'

# Real-looking bearer/cookie values rather than shell variables.
scan "bearer or cookie token in tracked files" \
  '(hanse_token|Authorization: Bearer|HANSE_(OPERATOR|RUNTIME)_TOKEN=)[[:space:]]*[A-Za-z0-9._~+/=-]{24,}'

if ((fail)); then
  echo
  echo "Sensitive-data check failed. Move deployment details to the untracked docs/deploy/ runbook and use placeholders in tracked files." >&2
  exit 1
fi

echo "Sensitive-data check passed."
