#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${1:-${SCRIPT_DIR}/dist}"
EXTENSION_FFMPEG_DIR="${REPO_ROOT}/extension/ffmpeg"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker is required to build FFmpeg WASM." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Error: the Docker daemon is not running." >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

docker build \
  --file "${SCRIPT_DIR}/Dockerfile" \
  --target export \
  --output "type=local,dest=${OUTPUT_DIR}" \
  "${SCRIPT_DIR}"

test -s "${OUTPUT_DIR}/ffmpeg-to_mp4.js"
test -s "${OUTPUT_DIR}/ffmpeg-to_mp4.wasm"

echo "Built ${OUTPUT_DIR}/ffmpeg-to_mp4.js"
echo "Built ${OUTPUT_DIR}/ffmpeg-to_mp4.wasm"
ls -la "${OUTPUT_DIR}"

mkdir -p "${EXTENSION_FFMPEG_DIR}"
rm -f "${EXTENSION_FFMPEG_DIR}"/ffmpeg-to_mp4*
cp -f "${OUTPUT_DIR}/ffmpeg-to_mp4.js" "${EXTENSION_FFMPEG_DIR}/ffmpeg-to_mp4.js"
cp -f "${OUTPUT_DIR}/ffmpeg-to_mp4.wasm" "${EXTENSION_FFMPEG_DIR}/ffmpeg-to_mp4.wasm"
if compgen -G "${OUTPUT_DIR}/ffmpeg-to_mp4*.worker.js" > /dev/null; then
  cp -f "${OUTPUT_DIR}"/ffmpeg-to_mp4*.worker.js "${EXTENSION_FFMPEG_DIR}/"
fi
echo "Synced ${EXTENSION_FFMPEG_DIR}/"
ls -la "${EXTENSION_FFMPEG_DIR}"
