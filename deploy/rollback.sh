#!/usr/bin/env bash
# Redeploys the previous tag without migrating (the schema is expand-only), then swaps the state.
# Same env as deploy.sh (no setup services are run).
set -euo pipefail
cd "$(dirname "$0")/.."

compose_args="${DEPLOY_COMPOSE_ARGS:--f docker-compose.prod.yml}"
infra="${DEPLOY_INFRA_SERVICES:-postgres}"
state="${DEPLOY_STATE_DIR:-deploy/state}"
mkdir -p "$state"
if ! mkdir "$state/.lock" 2>/dev/null; then
  echo "Another deploy or rollback is running (lock $state/.lock; if no deploy is running, a crashed one left it: rmdir it)" >&2
  exit 1
fi
trap 'rmdir "$state/.lock" 2>/dev/null || true' EXIT
write_state() { printf '%s\n' "$2" > "$state/.$1.tmp" && mv -f "$state/.$1.tmp" "$state/$1"; }
current="$(cat "$state/current" 2>/dev/null || true)"
previous="$(cat "$state/previous" 2>/dev/null || true)"

if [[ -z "$previous" ]]; then
  echo "No previous version to roll back to" >&2
  exit 1
fi

# shellcheck disable=SC2086
dc() { local t="$1"; shift; IMAGE_TAG="$t" docker compose $compose_args "$@"; }

if ! docker image inspect "nesto-app:$previous" "nesto-caddy:$previous" "nesto-backup:$previous" >/dev/null; then
  echo "Images for $previous are missing; still running ${current:-none}" >&2
  exit 1
fi
# shellcheck disable=SC2086
if ! dc "$previous" up -d --wait $infra; then
  echo "Infrastructure failed; still running ${current:-none}" >&2
  exit 1
fi
if ! dc "$previous" up -d --no-deps --wait --wait-timeout 120 api web caddy backup; then
  echo "Rollback failed; check the services by hand (wanted $previous)" >&2
  exit 1
fi

if [[ -n "$current" ]]; then write_state previous "$current"; else rm -f "$state/previous"; fi
write_state current "$previous"
echo "Rolled back to $previous (previous ${current:-none})"
