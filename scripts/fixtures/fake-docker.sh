#!/usr/bin/env bash
# Fake `docker` for scripts/deploy.spec.mjs. Records "IMAGE_TAG=<tag> <args>" in $FAKE_DOCKER_LOG.
# FAKE_FAIL=image|infra|migrate|up makes the matching call fail ("up" only for IMAGE_TAG=$FAKE_FAIL_TAG).
set -u
echo "IMAGE_TAG=${IMAGE_TAG:-} $*" >> "${FAKE_DOCKER_LOG:?}"
args=" $* "
case "${FAKE_FAIL:-}" in
  image) [[ "$args" == *" image inspect "* ]] && exit 1 ;;
  migrate) [[ "$args" == *" run "* && "$args" == *" migrate "* ]] && exit 1 ;;
  infra) [[ "$args" == *" up "* && "$args" != *" --no-deps "* ]] && exit 1 ;;
  up) [[ "$args" == *" up "* && "$args" == *" --no-deps "* && "${IMAGE_TAG:-}" == "${FAKE_FAIL_TAG:-}" ]] && exit 1 ;;
esac
exit 0
