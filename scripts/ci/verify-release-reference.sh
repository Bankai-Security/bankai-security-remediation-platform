#!/usr/bin/env sh
set -eu

for image_ref in "$@"; do
  case "$image_ref" in
    *@sha256:[0-9a-f][0-9a-f]*) ;;
    *) echo "release reference must be registry/repository@sha256:digest: $image_ref" >&2; exit 1 ;;
  esac
done

test "$#" -gt 0 || { echo "provide at least one release image reference" >&2; exit 2; }
echo "All release image references are immutable digests."
