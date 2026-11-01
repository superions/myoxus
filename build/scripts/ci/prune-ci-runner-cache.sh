#!/usr/bin/env bash
# Reviews or prunes bounded CI runner cache directories. Defaults to dry-run.

set -euo pipefail

cache_root="${CI_RUNNER_CACHE:-/var/cache/ci-runner}"
days=14
apply=false
buildkit_all=false

while [ $# -gt 0 ]; do
  case "$1" in
    --cache-root)
      cache_root="$2"
      shift 2
      ;;
    --days)
      days="$2"
      shift 2
      ;;
    --apply)
      apply=true
      shift
      ;;
    --buildkit-all)
      buildkit_all=true
      shift
      ;;
    --dry-run)
      apply=false
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$cache_root" in
  /*) ;;
  *)
    echo "Cache root must be an absolute path: $cache_root" >&2
    exit 2
    ;;
esac

case "$cache_root" in
  /|/var|/var/cache)
    echo "Refusing unsafe cache root: $cache_root" >&2
    exit 2
    ;;
esac

case "$days" in
  ''|*[!0-9]*)
    echo "Retention days must be a non-negative integer: $days" >&2
    exit 2
    ;;
esac

if [ ! -d "$cache_root" ]; then
  echo "Cache root does not exist: $cache_root" >&2
  exit 0
fi

collect_candidates() {
  if [ -d "$cache_root/artifacts" ]; then
    find "$cache_root/artifacts" \
      -mindepth 4 -maxdepth 4 -type d -mtime +"$days" -print
  fi

  if [ -d "$cache_root/buildkit" ]; then
    for cache_name in \
      server server-new \
      web-frontend web-frontend-new \
      admin-frontend admin-frontend-new; do
      candidate="$cache_root/buildkit/$cache_name"
      [ -d "$candidate" ] || continue
      if $buildkit_all || find "$candidate" -maxdepth 0 -mtime +"$days" | grep -q .; then
        printf '%s\n' "$candidate"
      fi
    done
  fi
}

if $apply; then
  collect_candidates | while IFS= read -r candidate; do
    echo "Removing $candidate"
    rm -rf -- "$candidate"
  done
else
  if $buildkit_all; then
    echo "Dry-run: all BuildKit exports and artifacts older than $days days under $cache_root"
  else
    echo "Dry-run: directories older than $days days under $cache_root"
  fi
  collect_candidates
fi
