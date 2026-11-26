#!/usr/bin/env bash
# Builds the three images for a tag: nesto-{app,caddy,backup}:<tag>. In 9c the pipeline builds and pushes instead.
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:-}"
if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Usage: deploy/build.sh <tag>   (tag: letters, digits, _ . -; at most 128 characters)" >&2
  exit 2
fi

for target in app caddy backup; do
  docker build --target "$target" --build-arg "APP_VERSION=$tag" -t "nesto-$target:$tag" .
done
echo "Built nesto-{app,caddy,backup}:$tag"
