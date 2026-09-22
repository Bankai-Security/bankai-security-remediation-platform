#!/usr/bin/env sh
set -eu

IMAGE_REF="${1:?usage: container-security-gate.sh IMAGE_REF OUTPUT_DIR [SOURCE_DIR]}"
OUTPUT_DIR="${2:?usage: container-security-gate.sh IMAGE_REF OUTPUT_DIR [SOURCE_DIR]}"
SOURCE_DIR="${3:-.}"

case "$IMAGE_REF" in
  *:latest) echo "mutable :latest image references are forbidden" >&2; exit 2 ;;
esac

SYFT_IMAGE="anchore/syft@sha256:5999d209a342e55e9edf70bf8930fb5b86d8f2a783fa401178372c50e21b1d36"
TRIVY_IMAGE="aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"
GITLEAKS_IMAGE="zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"

docker image inspect "$IMAGE_REF" > "$OUTPUT_DIR/image-inspect.json"
docker image inspect "$IMAGE_REF" --format 'image_id={{.Id}} repo_digests={{json .RepoDigests}}'   > "$OUTPUT_DIR/image-digest.txt"

docker run --rm   -v /var/run/docker.sock:/var/run/docker.sock   -v "$OUTPUT_DIR:/output"   "$SYFT_IMAGE" "docker:$IMAGE_REF"   -o syft-json=/output/sbom.syft.json   -o cyclonedx-json=/output/sbom.cyclonedx.json

docker run --rm   -v /var/run/docker.sock:/var/run/docker.sock   -v trivy-cache:/root/.cache   -v "$OUTPUT_DIR:/output"   "$TRIVY_IMAGE" image --scanners vuln --ignore-unfixed   --severity HIGH,CRITICAL --format json --output /output/vulnerabilities.json "$IMAGE_REF"

docker run --rm   -v /var/run/docker.sock:/var/run/docker.sock   -v trivy-cache:/root/.cache   -v "$OUTPUT_DIR:/output"   "$TRIVY_IMAGE" image --scanners secret   --format json --output /output/image-secrets.json "$IMAGE_REF"

docker run --rm   -v "$SOURCE_DIR:/source:ro"   -v "$OUTPUT_DIR:/output"   "$GITLEAKS_IMAGE" git /source --config /source/.gitleaks.toml --redact --report-format json   --report-path /output/source-secrets.json --exit-code 1

# Enforce only after reports have been retained for review.
docker run --rm   -v /var/run/docker.sock:/var/run/docker.sock   -v trivy-cache:/root/.cache   "$TRIVY_IMAGE" image --scanners vuln --ignore-unfixed   --severity HIGH,CRITICAL --exit-code 1 "$IMAGE_REF"
docker run --rm   -v /var/run/docker.sock:/var/run/docker.sock   -v trivy-cache:/root/.cache   "$TRIVY_IMAGE" image --scanners secret --exit-code 1 "$IMAGE_REF"

echo "Container security gate passed for $IMAGE_REF"
