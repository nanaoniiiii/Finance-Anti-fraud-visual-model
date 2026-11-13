#!/bin/sh
# Run from an extracted, complete RK3566 release bundle as root.
set -eu
PACKAGE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=/userdata/poseguard
SERVICE=/etc/init.d/S99poseguard
[ "$(id -u)" = 0 ] || { echo 'Run this installer as root' >&2; exit 1; }
[ "$(uname -m)" = aarch64 ] || { echo 'This bundle requires AArch64 Linux' >&2; exit 1; }
cd "$PACKAGE"
sha256sum -c SHA256SUMS
chmod 755 bin/poseguard-rk3566 bin/poseguard-run service/S99poseguard
# Test NPU compatibility before stopping an installed service or replacing files.
bin/poseguard-run --model-smoke "$PACKAGE/models/poseguard-yolo11n-pose-320-int8.rknn"
if [ -f "$SERVICE" ]; then
    "$SERVICE" stop
fi
mkdir -p "$ROOT/bin" "$ROOT/lib" "$ROOT/models" "$ROOT/config" \
    "$ROOT/runs" "$ROOT/logs" "$ROOT/media" "$ROOT/service" "$ROOT/backup"
backup="$ROOT/backup/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$backup"
for relative in bin/poseguard-rk3566 bin/poseguard-run lib/librknnrt.so \
    models/poseguard-yolo11n-pose-320-int8.rknn service/S99poseguard; do
    target="$ROOT/$relative"
    if [ -f "$target" ]; then
        mkdir -p "$backup/$(dirname "$relative")"
        cp -p "$target" "$backup/$relative"
    fi
    cp "$PACKAGE/$relative" "$target.new"
    mv "$target.new" "$target"
done
chmod 755 "$ROOT/bin/poseguard-rk3566" "$ROOT/bin/poseguard-run" "$ROOT/service/S99poseguard"
if [ ! -f "$ROOT/config/poseguard.conf" ]; then
    cp "$PACKAGE/config/poseguard.conf" "$ROOT/config/poseguard.conf"
fi
cp "$PACKAGE/config/poseguard.conf" "$ROOT/config/poseguard.conf.example"
cp "$PACKAGE/SHA256SUMS" "$ROOT/package-SHA256SUMS"
cp "$PACKAGE/manifest.json" "$ROOT/manifest.json"
if [ -f "$SERVICE" ]; then cp -p "$SERVICE" "$backup/S99poseguard.installed"; fi
cp "$ROOT/service/S99poseguard" "$SERVICE.new"
chmod 755 "$SERVICE.new"
mv "$SERVICE.new" "$SERVICE"
sync
"$SERVICE" start
"$SERVICE" status
echo "Installed in $ROOT. Existing configuration preserved."
echo 'Web preview: http://<board-ip>:8081/ (or use ADB forwarding).'
