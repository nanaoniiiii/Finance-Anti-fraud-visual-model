#!/usr/bin/env bash
set -euo pipefail
umask 022
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ "$(id -u)" -ne 0 ]; then echo 'Run with sudo: sudo ./platforms/linux/install.sh [--bind-code CODE]' >&2; exit 1; fi
if ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then echo 'This package requires a running systemd Linux. RK3566 Buildroot uses the separately published native package.' >&2; exit 1; fi
case "$(uname -m)" in
  x86_64) uv_arch=x86_64; uv_sha=5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91 ;;
  aarch64|arm64) uv_arch=aarch64; uv_sha=74f2f5c6024d397481db228db8fc25eed420db192243f88438c118e7e013e585 ;;
  *) echo 'Supported architectures: x86_64 and aarch64.' >&2; exit 1 ;;
esac
if ldd --version 2>&1 | head -1 | grep -qi musl; then echo 'This package requires glibc; Alpine/musl is not supported.' >&2; exit 1; fi
cd "$bundle_dir"
sha256sum --check FILES.sha256
if command -v apt-get >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar libstdc++6 libgomp1
elif ! command -v curl >/dev/null; then echo 'Install curl, tar, CA certificates and libstdc++ before running this installer.' >&2; exit 1; fi
version=$(tr -d '\r\n' < VERSION)
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo 'Invalid bundle version' >&2; exit 1; fi
install -d -m 755 /opt/poseguard /opt/poseguard/releases /opt/poseguard/python /opt/poseguard/bootstrap /var/cache/poseguard
getent group poseguard >/dev/null || groupadd --system poseguard
getent group video >/dev/null || groupadd --system video
id poseguard >/dev/null 2>&1 || useradd --system --gid poseguard --groups video --home-dir /var/lib/poseguard --shell /usr/sbin/nologin poseguard
install -d -m 750 -o poseguard -g poseguard /var/lib/poseguard /var/log/poseguard
install -d -m 750 -o root -g poseguard /etc/poseguard
work_tmp=$(mktemp -d /var/cache/poseguard/install.XXXXXXXX)
previous_release=$(readlink /opt/poseguard/current || true)
was_active=0; systemctl is-active --quiet poseguard.service && was_active=1
switched=0; success=0
cleanup() {
  rm -f -- "$work_tmp/uv.tar.gz"
  if [ "$success" -eq 0 ] && [ "$switched" -eq 1 ]; then
    if [ -n "$previous_release" ]; then ln -sfn "$previous_release" /opt/poseguard/current; fi
    if [ "$was_active" -eq 1 ]; then systemctl restart poseguard.service || true; fi
  fi
}
trap cleanup EXIT
curl --proto '=https' --tlsv1.2 -fL --retry 3 "https://github.com/astral-sh/uv/releases/download/0.13.8/uv-${uv_arch}-unknown-linux-gnu.tar.gz" -o "$work_tmp/uv.tar.gz"
printf '%s  %s\n' "$uv_sha" "$work_tmp/uv.tar.gz" | sha256sum --check
tar -xzf "$work_tmp/uv.tar.gz" -C "$work_tmp"
install -m 755 "$work_tmp/uv-${uv_arch}-unknown-linux-gnu/uv" /opt/poseguard/bootstrap/uv
export UV_PYTHON_INSTALL_DIR=/opt/poseguard/python UV_CACHE_DIR=/var/cache/poseguard/uv UV_LINK_MODE=copy
/opt/poseguard/bootstrap/uv python install 3.12
if [ ! -x /opt/poseguard/venv/bin/python ]; then /opt/poseguard/bootstrap/uv venv --python 3.12 /opt/poseguard/venv; fi
/opt/poseguard/bootstrap/uv pip install --python /opt/poseguard/venv/bin/python -r platforms/linux/requirements.txt
if ! /opt/poseguard/venv/bin/python -c 'import cv2, numpy, onnxruntime'; then
  echo 'The installed CPU runtime could not load. Check the CPU features exposed by this system or VM.' >&2
  exit 1
fi
bundle_id=$(sha256sum FILES.sha256 | cut -c 1-12)
release_dir="/opt/poseguard/releases/$version-$bundle_id"
if [ -L "$release_dir" ] || { [ -e /opt/poseguard/current ] && [ ! -L /opt/poseguard/current ]; }; then echo 'Existing nonstandard installation preserved; move it aside before installing.' >&2; exit 1; fi
install -d -m 755 "$release_dir"
cp -a poseguard platforms configs models licenses VERSION SOURCE_COMMIT.txt FILES.sha256 README.zh-CN.md LICENSES.md "$release_dir/"
systemctl stop poseguard.service 2>/dev/null || true
ln -sfn "$release_dir" /opt/poseguard/current
switched=1
cd /opt/poseguard/current
/opt/poseguard/venv/bin/python -m platforms.linux.configure "$@"
chown -R poseguard:poseguard /var/lib/poseguard /var/log/poseguard
chown root:poseguard /etc/poseguard/runtime.json
chmod 640 /etc/poseguard/runtime.json
if [ -f /etc/systemd/system/poseguard.service ]; then cp -p /etc/systemd/system/poseguard.service "/etc/systemd/system/poseguard.service.bak.$(date +%s)"; fi
install -m 644 platforms/linux/poseguard.service /etc/systemd/system/poseguard.service
systemctl daemon-reload
systemctl enable poseguard.service
systemctl restart poseguard.service
success=1
echo 'PoseGuard installed. Configuration: /etc/poseguard/runtime.json; records: /var/lib/poseguard/records'
echo 'View status: systemctl status poseguard; view logs: journalctl -u poseguard -f'
