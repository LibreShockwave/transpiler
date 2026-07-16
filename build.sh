#!/usr/bin/env bash
# Build the LibreShockwave TypeScript transpiler (libreshockwave_export_ts).
#
# This repo vendors LibreShockwave as a submodule at external/LibreShockwave; the build
# compiles our local ExportTsProbe.cpp against the LibreShockwave library. Tests for the
# library itself are skipped (BUILD_TESTING=OFF) to keep the build light — run them in the
# LibreShockwave checkout if you need them.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
BUILD_TYPE="Release"
JOBS=""

usage() {
  cat <<'EOF'
Usage: ./build.sh [options]

Build the libreshockwave_export_ts probe.

Options:
  --debug           Debug build (default is Release).
  --release         Release build (default).
  --build-dir DIR   Use a custom build directory.
  --jobs N          Parallel job count passed to cmake --build.
  -h, --help        Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) BUILD_TYPE="Debug"; shift ;;
    --release) BUILD_TYPE="Release"; shift ;;
    --build-dir) BUILD_DIR="${2:?--build-dir requires a value}"; shift 2 ;;
    --jobs|-j) JOBS="${2:?--jobs requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Ensure the LibreShockwave submodule is present.
if [[ ! -f "${ROOT_DIR}/external/LibreShockwave/CMakeLists.txt" ]]; then
  echo "LibreShockwave submodule missing; running: git submodule update --init --recursive" >&2
  git -C "${ROOT_DIR}" submodule update --init --recursive
fi

configure_cmd=(cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}"
  "-DCMAKE_BUILD_TYPE=${BUILD_TYPE}"
  -DBUILD_TESTING=OFF)
build_cmd=(cmake --build "${BUILD_DIR}" --target libreshockwave_export_ts)
if [[ -n "${JOBS}" ]]; then
  build_cmd+=(--parallel "${JOBS}")
else
  build_cmd+=(--parallel)
fi

echo "+ ${configure_cmd[*]}"
"${configure_cmd[@]}"

echo "+ ${build_cmd[*]}"
"${build_cmd[@]}"

echo
echo "Built: ${BUILD_DIR}/bin/libreshockwave_export_ts"
echo "Run:   ${BUILD_DIR}/bin/libreshockwave_export_ts <movie> --out exported-movie"