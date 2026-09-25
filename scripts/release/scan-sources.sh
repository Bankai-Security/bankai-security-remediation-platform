#!/usr/bin/env bash
set -euo pipefail

repository=$(cd "${1:?usage: scan-sources.sh REPOSITORY REPORT_DIRECTORY}" && pwd)
reports=${2:?report directory is required}
mkdir -p "$reports"
reports=$(cd "$reports" && pwd)
test -f "$repository/.gitleaks.toml"
# Scan this repository's committed history, not a mixed build workspace that
# also contains another checkout, virtualenvs, generated reports and assets.
docker run --rm -v "$repository:/source:ro" -v "$reports:/output" \
  zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
  git /source --config /source/.gitleaks.toml --redact \
  --report-format json --report-path /output/source-secrets.json --exit-code 1
