"""Package an offline RK3566 deployment with hashes and matching source metadata."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--rockchip-license', type=Path, required=True)
    parser.add_argument('--agpl-license', type=Path, required=True)
    parser.add_argument('--validation-report', type=Path)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--version', default='1.1.0')
    args = parser.parse_args()
    platform = Path(__file__).resolve().parents[1]
    repo = platform.parents[1]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True).strip())
    files = {
        'bin/poseguard-rk3566': args.binary,
        'bin/poseguard-run': platform / 'service/poseguard-run',
        'lib/librknnrt.so': args.runtime,
        'models/poseguard-yolo11n-pose-320-int8.rknn': args.model,
        'config/poseguard.conf': platform / 'config/poseguard.conf',
        'service/S99poseguard': platform / 'service/S99poseguard',
        'install.sh': platform / 'install.sh',
        'deploy-adb.ps1': platform / 'deploy-adb.ps1',
        'README.md': platform / 'QUICKSTART.zh-CN.md',
        'licenses/ROCKCHIP.txt': args.rockchip_license,
        'licenses/AGPL-3.0.txt': args.agpl_license,
        'licenses/THIRD-PARTY.md': repo / 'LICENSES.md',
    }
    if args.validation_report:
        files['validation.md'] = args.validation_report
    for source in files.values():
        if not source.is_file() or source.stat().st_size == 0:
            raise ValueError(f'Required release input is missing or empty: {source}')
    staging = repo / 'build/rk3566-package'
    staging.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=staging) as temporary:
        root = Path(temporary) / 'poseguard-rk3566'
        for relative, source in files.items():
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            data = source.read_bytes()
            if relative not in ('bin/poseguard-rk3566', 'lib/librknnrt.so') and not relative.startswith('models/'):
                data = data.replace(b'\r\n', b'\n')
            target.write_bytes(data)
            if relative.startswith('bin/') or relative.endswith('.sh') or relative.startswith('service/'):
                target.chmod(0o755)
            else:
                target.chmod(0o644)
        manifest = {
            'version': args.version, 'architecture': 'aarch64', 'target': 'rk3566',
            'source_commit': commit, 'source_dirty': dirty,
            'model': 'YOLO11n-Pose, 320x320, four output tensors, INT8',
            'rknn_toolkit': '2.3.2', 'default_source': 'USB camera (waits when disconnected)',
            'files': {relative: sha256(root / relative) for relative in sorted(files)},
        }
        (root / 'manifest.json').write_bytes((json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
        payload = sorted(p for p in root.rglob('*') if p.is_file())
        (root / 'SHA256SUMS').write_bytes(''.join(f'{sha256(p)}  {p.relative_to(root).as_posix()}\n' for p in payload).encode('utf-8'))
        archive = args.output_dir / f'PoseGuard-RK3566-v{args.version}-aarch64.tar.gz'
        with tarfile.open(archive, 'w:gz') as handle:
            handle.add(root, arcname='poseguard-rk3566')
    sums = archive.with_suffix('').with_suffix('.SHA256SUMS.txt')
    sums.write_text(f'{sha256(archive)}  {archive.name}\n', encoding='utf-8')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': sha256(archive), 'source_commit': commit, 'source_dirty': dirty}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
