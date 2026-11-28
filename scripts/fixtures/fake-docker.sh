#!/usr/bin/env bash
# Fake `docker` for scripts/deploy.spec.mjs. Records "IMAGE_TAG=<tag> <args>" in $FAKE_DOCKER_LOG.
# The env check (`run --rm -i ... node - /env ...`) gets the script on stdin; it is read and dropped.
# FAKE_FAIL=image|check-env|infra|migrate|up makes the matching call fail ("up" only for IMAGE_TAG=$FAKE_FAIL_TAG).
set -u
echo "IMAGE_TAG=${IMAGE_TAG:-} $*" >> "${FAKE_DOCKER_LOG:?}"
args=" $* "
if [[ "$args" == *" run --rm -i "* ]]; then cat >/dev/null; fi
case "${FAKE_FAIL:-}" in
  image) [[ "$args" == *" image inspect "* ]] && exit 1 ;;
  check-env) [[ "$args" == *" run --rm -i "* ]] && exit 1 ;;
  migrate) [[ "$args" == *" run "* && "$args" == *" migrate "* ]] && exit 1 ;;
  infra) [[ "$args" == *" up "* && "$args" != *" --no-deps "* ]] && exit 1 ;;
  up) [[ "$args" == *" up "* && "$args" == *" --no-deps "* && "${IMAGE_TAG:-}" == "${FAKE_FAIL_TAG:-}" ]] && exit 1 ;;
esac
exit 0
