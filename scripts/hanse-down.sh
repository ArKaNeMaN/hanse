#!/bin/sh
# Stop managed app containers through the runner, then remove the static Compose stack.
set -eu

cd "$(dirname "$0")/.."

if docker compose ps --status running --services 2>/dev/null | grep -qx runner; then
  if ! docker compose exec -T runner node -e '
    fetch("http://127.0.0.1:8790/v1/stop-all", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.HANSE_RUNTIME_TOKEN}` },
    }).then(async (response) => {
      if (!response.ok) {
        process.stderr.write(await response.text());
        process.exit(1);
      }
    }).catch((error) => {
      process.stderr.write(String(error));
      process.exit(1);
    });
  '; then
    printf 'warning: runner stop-all failed; removing managed containers directly\n' >&2
  fi
fi

docker compose down "$@"

apps=$(docker ps -aq --filter label=hanse.managed=true)
if [ -n "$apps" ]; then
  # shellcheck disable=SC2086
  docker rm -f $apps >/dev/null
fi

networks=$(docker network ls -q --filter label=hanse.managed=true)
if [ -n "$networks" ]; then
  # shellcheck disable=SC2086
  docker network rm $networks >/dev/null 2>&1 || true
fi
