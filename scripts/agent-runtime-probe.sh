#!/bin/sh
# B0 runtime probe. Run from the repository root on the Docker host:
#   scripts/agent-runtime-probe.sh b0
set -eu

mode=${1:-b0}
cd "$(dirname "$0")/.."
compose=${COMPOSE:-docker compose}
failures=0

pass() {
  printf 'PASS  %s\n' "$1"
}

fail() {
  failures=$((failures + 1))
  printf 'FAIL  %s\n' "$1"
}

check() {
  label=$1
  shift
  if "$@"; then
    pass "$label"
  else
    fail "$label"
  fi
}

agent_exec() {
  $compose exec -T agents "$@"
}

hanse_exec() {
  $compose exec -T hanse "$@"
}

ide_exec() {
  $compose exec -T ide "$@"
}

if [ "$mode" = "b1" ] || [ "$mode" = "b2" ]; then
  if ! $compose config >/dev/null; then
    fail "docker compose config"
    exit 1
  fi
  pass "docker compose config"

  running=$($compose ps --status running --services)
  for service in hanse ide runner; do
    if printf '%s\n' "$running" | grep -qx "$service"; then
      pass "$service is running"
    else
      fail "$service is running"
    fi
  done
  if [ -n "$(docker ps -aq --filter name=hanse-agents)" ]; then
    fail "B0 agents container is absent"
  else
    pass "B0 agents container is absent"
  fi

  check "coordinator health" hanse_exec node -e \
    "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
  check "runner health" $compose exec -T runner node -e \
    "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
  check "ide health" ide_exec curl -fsS http://127.0.0.1:8080/

  app=$(docker ps -q --filter label=hanse.managed=true | head -n 1)
  if [ -z "$app" ]; then
    printf 'SKIP  no running managed app container\n'
  else
    pass "managed app container is running"
    check "app runs as uid 1000" docker exec "$app" sh -c 'test "$(id -u)" = 1000'
    check "app root is read-only" sh -c \
      'test "$(docker inspect --format "{{.HostConfig.ReadonlyRootfs}}" "$1")" = true' sh "$app"
    check "app drops capabilities" sh -c \
      'docker inspect --format "{{json .HostConfig.CapDrop}}" "$1" | grep -q ALL' sh "$app"
    check "app has no coordinator state mount" sh -c \
      '! docker inspect --format "{{range .Mounts}}{{.Destination}} {{end}}" "$1" | grep -q /data/state' sh "$app"
    check "app has no Docker socket" docker exec "$app" sh -c 'test ! -e /var/run/docker.sock'
    check "app has no operator/runtime secret" sh -c \
      '! docker inspect --format "{{json .Config.Env}}" "$1" | grep -qE "HANSE_(OPERATOR|RUNTIME)_TOKEN|HANSE_DB"' sh "$app"
    check "app can write its workspace" docker exec "$app" sh -c \
      'touch .probe && rm -f .probe'
    check "app has core toolchains" docker exec "$app" sh -c \
      'command -v python3 node php uv mise opencode hanse git >/dev/null'

    app_net=$(docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$app" | tr ' ' '\n' | grep '^hanse-app-' | head -n 1)
    if [ -n "$app_net" ] && docker inspect hanse --format '{{json .NetworkSettings.Networks}}' | grep -q "$app_net"; then
      pass "coordinator is attached to the app network"
    else
      fail "coordinator is attached to the app network"
    fi
  fi

  if [ "$mode" = "b2" ]; then
    check "runner image usage rejects anonymous" $compose exec -T runner node -e \
      "fetch('http://127.0.0.1:8790/v1/images/usage').then((r) => process.exit(r.status === 401 ? 0 : 1)).catch(() => process.exit(1))"
    check "runner image usage" $compose exec -T runner node -e \
      "fetch('http://127.0.0.1:8790/v1/images/usage', {headers:{authorization:'Bearer '+process.env.HANSE_RUNTIME_TOKEN}}).then(async (r) => {const b=await r.json(); if (!r.ok || !['ok','warning','critical'].includes(b.level)) process.exit(1)}).catch(() => process.exit(1))"
    check "coordinator image usage auth" hanse_exec node -e \
      "fetch('http://127.0.0.1:8787/api/images/usage', {headers:{cookie:'hanse_token='+process.env.HANSE_OPERATOR_TOKEN}}).then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"
    check "docker system df" sh -c 'docker system df >/dev/null'
  fi

  if [ "$failures" -ne 0 ]; then
    printf '%s check(s) failed\n' "$failures" >&2
    exit 1
  fi
  printf 'All %s checks passed\n' "$mode"
  exit 0
fi

if ! $compose config >/dev/null; then
  fail "docker compose config"
  exit 1
fi
pass "docker compose config"

running=$($compose ps --status running --services)
for service in hanse ide agents; do
  if printf '%s\n' "$running" | grep -qx "$service"; then
    pass "$service is running"
  else
    fail "$service is running"
  fi
done

check "coordinator health" hanse_exec node -e \
  "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
check "agents health" agent_exec node -e \
  "fetch('http://127.0.0.1:8789/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
check "ide health" ide_exec curl -fsS http://127.0.0.1:8080/

check "agents run as uid 1000" agent_exec sh -c 'test "$(id -u)" = 1000'
check "agents root is read-only" agent_exec sh -c \
  'grep -Eq "^[^ ]+ / [^ ]+ ro([ ,]|$)" /proc/mounts'
check "agents /tmp is executable" agent_exec sh -c \
  'printf "#!/bin/sh\nexit 0\n" > /tmp/.probe && chmod +x /tmp/.probe && /tmp/.probe'
check "agents have no Docker socket" agent_exec sh -c 'test ! -e /var/run/docker.sock'
check "agents have no coordinator state" agent_exec sh -c \
  'test ! -e /data/state && test ! -e /data/state/hanse/secret.key && test ! -e /data/state/hanse/coordinator.db'
check "agents have no operator token" agent_exec sh -c \
  '! tr "\0" "\n" < /proc/1/environ | grep -q "^HANSE_OPERATOR_TOKEN="'
check "agents have no HANSE_DB" agent_exec sh -c \
  '! tr "\0" "\n" < /proc/1/environ | grep -q "^HANSE_DB="'
check "agents cannot resolve the front IDE" agent_exec node -e \
  "require('node:dns').lookup('ide', (error) => process.exit(error ? 0 : 1))"
check "agents can write /data/agents" agent_exec sh -c \
  'touch /data/agents/.probe && rm -f /data/agents/.probe'
check "agents can write /data/workspace" agent_exec sh -c \
  'touch /data/workspace/.probe && rm -f /data/workspace/.probe'

for tool in python3 node php uv mise opencode hanse git; do
  check "agents have $tool" agent_exec sh -c "command -v $tool >/dev/null"
done

if [ "$mode" = "b0" ]; then
  :
elif [ "$mode" = "b1" ] || [ "$mode" = "b2" ]; then
  printf 'SKIP  %s probe is implemented in a later stage\n' "$mode"
else
  printf 'Unknown probe mode: %s\n' "$mode" >&2
  exit 2
fi

if [ "$failures" -ne 0 ]; then
  printf '%s check(s) failed\n' "$failures" >&2
  exit 1
fi

printf 'All %s checks passed\n' "$mode"
