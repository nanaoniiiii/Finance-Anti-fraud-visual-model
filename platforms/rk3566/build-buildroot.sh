#!/bin/sh
# Debian/Ubuntu host or WSL; the sysroot is a read-only copy of /lib and /usr/lib.
set -eu
: "${BOARD_SYSROOT:?Set BOARD_SYSROOT to the copied target rootfs}"
: "${RKNN_ROOT:?Set RKNN_ROOT to a matching RKNN header/runtime directory}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cmake -S "$ROOT/platforms/rk3566" -B "$ROOT/build/rk3566-native" -G Ninja \
    -DPOSEGUARD_BUILD_TESTS=ON -DPOSEGUARD_ENABLE_BOARD=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build "$ROOT/build/rk3566-native" -j4
(cd "$ROOT/build/rk3566-native" && ctest --output-on-failure)
cmake -S "$ROOT/platforms/rk3566" -B "$ROOT/build/rk3566-aarch64" -G Ninja \
    -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
    -DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++ -DCMAKE_BUILD_TYPE=Release \
    -DPOSEGUARD_BOARD_SYSROOT="$BOARD_SYSROOT" -DPOSEGUARD_ENABLE_BOARD=ON \
    -DPOSEGUARD_BUILD_TESTS=OFF
cmake --build "$ROOT/build/rk3566-aarch64" -j4
aarch64-linux-gnu-readelf -h "$ROOT/build/rk3566-aarch64/poseguard-rk3566"
