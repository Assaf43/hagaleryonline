#!/usr/bin/env bash
# Deploys a built tag: env file -> images -> env check -> infrastructure -> migrate gate -> health gate -> state swap.
# Env: DEPLOY_COMPOSE_ARGS (default "-f docker-compose.prod.yml"), DEPLOY_ENV_FILE (default: the --env-file given in
# DEPLOY_COMPOSE_ARGS; one of the two is required), DEPLOY_INFRA_SERVICES (default "postgres"), DEPLOY_SETUP_SERVICES
# (one-shot services run once before migrate, default none), DEPLOY_STATE_DIR (default deploy/state).
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:-}"
if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Usage: deploy/deploy.sh <tag>   (tag: letters, digits, _ . -; at most 128 characters)" >&2
  exit 2
fi

compose_args="${DEPLOY_COMPOSE_ARGS:--f docker-compose.prod.yml}"
infra="${DEPLOY_INFRA_SERVICES:-postgres}"
setup="${DEPLOY_SETUP_SERVICES:-}"
state="${DEPLOY_STATE_DIR:-deploy/state}"

# 0. the env file (checked in step 1b by deploy/check-env.mjs, inside the image, before anything changes)
env_file="${DEPLOY_ENV_FILE:-}"
if [[ -z "$env_file" ]]; then
  read -ra words <<< "$compose_args"
  found=0
  for ((i = 0; i < ${#words[@]}; i++)); do
    case "${words[i]}" in
      --env-file) env_file="${words[i + 1]:-}"; found=$((found + 1)) ;;
      --env-file=*) env_file="${words[i]#--env-file=}"; found=$((found + 1)) ;;
    esac
  done
  if ((found > 1)); then
    echo "DEPLOY_COMPOSE_ARGS has several --env-file: set DEPLOY_ENV_FILE to the one to check" >&2
    exit 1
  fi
fi
if [[ -z "$env_file" ]]; then
  echo "No env file: set DEPLOY_ENV_FILE or pass --env-file in DEPLOY_COMPOSE_ARGS" >&2
  exit 1
fi
if [[ ! -f "$env_file" ]]; then
  # docker run -v would create a directory at a missing path, so it is checked here.
  echo "Env file not found (DEPLOY_ENV_FILE / --env-file)" >&2
  exit 1
fi
# An absolute host path for `docker run -v` (Git Bash: pwd -W gives C:/..., which Docker Desktop reads).
here="$(pwd -W 2>/dev/null || pwd)"
if [[ "$env_file" != /* && ! "$env_file" =~ ^[A-Za-z]: ]]; then env_file="$here/$env_file"; fi

mkdir -p "$state"
if ! mkdir "$state/.lock" 2>/dev/null; then
  echo "Another deploy or rollback is running (lock $state/.lock; if no deploy is running, a crashed one left it: rmdir it)" >&2
  exit 1
fi
trap 'rmdir "$state/.lock" 2>/dev/null || true' EXIT
write_state() { printf '%s\n' "$2" > "$state/.$1.tmp" && mv -f "$state/.$1.tmp" "$state/$1"; }
current="$(cat "$state/current" 2>/dev/null || true)"
running="${current:-none}"

# shellcheck disable=SC2086
dc() { local t="$1"; shift; IMAGE_TAG="$t" docker compose $compose_args "$@"; }

# 1. images
if ! docker image inspect "nesto-app:$tag" "nesto-caddy:$tag" "nesto-backup:$tag" >/dev/null; then
  echo "Images for $tag are missing; run deploy/build.sh $tag. Still running $running" >&2
  exit 1
fi

# 1b. env check: the hosts agree, TRUST_PROXY is the edge network, the Caddy mode fits APP_ENV / SEO_INDEXING.
# Names only in its output, never a value. It runs as the caller's uid (the env file is chmod 600), with no network,
# capabilities or writable root, and never pulls. MSYS_NO_PATHCONV keeps Git Bash from rewriting the container paths.
if ! MSYS_NO_PATHCONV=1 docker run --rm -i --pull never --network none --read-only --cap-drop ALL \
  --user "$(id -u):$(id -g)" \
  -v "$env_file:/env:ro" -v "$here/docker-compose.prod.yml:/compose.yml:ro" \
  "nesto-app:$tag" node - /env /compose.yml < deploy/check-env.mjs; then
  echo "The env file failed the checks above; still running $running" >&2
  exit 1
fi

# 2. infrastructure and one-shot setup (a one-shot service is run, never `up --wait`)
infra_ok() {
  # shellcheck disable=SC2086
  dc "$tag" up -d --wait $infra || return 1
  local svc
  for svc in $setup; do dc "$tag" run --rm "$svc" || return 1; done
}
if ! infra_ok; then
  echo "Infrastructure failed; still running $running" >&2
  exit 1
fi

# 3. migrate gate
if ! dc "$tag" --profile deploy run --rm migrate; then
  echo "Migration failed; still running $running" >&2
  # Prisma records a failed migration and refuses every later migrate (P3009) until it is resolved (rehearsal 9b).
  echo "Prisma does not wrap a migration in a transaction: first undo whatever the failed migration already applied, then mark it --rolled-back." >&2
  echo "Before the next deploy, fix the migration and mark the failed one: IMAGE_TAG=$tag docker compose ... --profile deploy run --rm --entrypoint sh migrate -c 'npx prisma migrate resolve --rolled-back <name> --config apps/api/prisma.config.ts'" >&2
  exit 1
fi

# 4. health gate
if ! dc "$tag" up -d --no-deps --wait --wait-timeout 120 api web caddy backup; then
  if [[ -z "$current" ]]; then
    echo "Health check failed; no previous version" >&2
    exit 1
  fi
  if ! docker image inspect "nesto-app:$current" "nesto-caddy:$current" "nesto-backup:$current" >/dev/null; then
    echo "Health check failed; images for $current are gone, cannot go back" >&2
    exit 1
  fi
  dc "$current" up -d --no-deps --wait --wait-timeout 120 api web caddy backup \
    || echo "Bringing $current back also failed; check the services by hand" >&2
  echo "Health check failed; back on $current" >&2
  exit 1
fi

# 5. state
if [[ -n "$current" ]]; then write_state previous "$current"; fi
write_state current "$tag"
echo "Deployed $tag (previous ${current:-none})"
