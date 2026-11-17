"""Package a clean, committed source revision without copying private settings."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--platform', choices=('windows', 'linux'), required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--models', type=Path)
parser.add_argument('--exe', type=Path)
parser.add_argument('--qa', action='store_true', help='Explicitly mark an uncommitted QA build')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip()
if dirty and not args.qa:
    raise SystemExit('Commit the final sources before creating public packages')
version = '1.6.0'
name = f'PoseGuard-{args.platform.title()}-v{version}'
args.output.mkdir(parents=True, exist_ok=True)
stage = args.output / name
if stage.exists():
    raise SystemExit('Output directory already exists; choose a fresh output path')
stage.mkdir()
for name in ('licenses',):
    shutil.copytree(root / name, stage / name)
shutil.copyfile(root / 'LICENSES.md', stage / 'LICENSES.md')
shutil.copyfile(root / 'docs/PORTABLE.zh-CN.md', stage / 'README.zh-CN.md')
(stage / 'VERSION').write_bytes((version + '\n').encode())
(stage / 'SOURCE_COMMIT.txt').write_bytes((commit + ('-WORKTREE-QA' if args.qa else '') + '\n').encode())
if args.platform == 'windows':
    if not args.exe or not args.exe.is_file():
        raise SystemExit('--exe must name the verified Windows executable')
    shutil.copyfile(args.exe, stage / 'PoseGuard.exe')
else:
    if not args.models:
        raise SystemExit('--models is required for Linux')
    for name in ('poseguard', 'configs'):
        shutil.copytree(root / name, stage / name, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    (stage / 'platforms').mkdir()
    shutil.copyfile(root / 'platforms/__init__.py', stage / 'platforms/__init__.py')
    shutil.copytree(root / 'platforms/linux', stage / 'platforms/linux', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    (stage / 'models').mkdir()
    for name in ('yolo11n-pose.onnx', 'yolo11n.onnx'):
        shutil.copyfile(args.models / name, stage / 'models' / name)
    for path in stage.rglob('*.sh'):
        path.write_bytes(path.read_bytes().replace(b'\r\n', b'\n'))
manifest = ''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.relative_to(stage).as_posix() + '\n'
                   for path in sorted(stage.rglob('*')) if path.is_file())
(stage / 'FILES.sha256').write_bytes(manifest.encode())
target = args.output / (stage.name + ('.zip' if args.platform == 'windows' else '.tar.gz'))
if args.platform == 'windows':
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(stage.rglob('*')):
            if path.is_file():
                archive.write(path, stage.name + '/' + path.relative_to(stage).as_posix())
else:
    def permissions(info):
        info.uid = info.gid = 0
        info.uname = info.gname = 'root'
        info.mode = 0o755 if info.isdir() or info.name.endswith('.sh') else 0o644
        return info
    with tarfile.open(target, 'w:gz') as archive:
        archive.add(stage, arcname=stage.name, filter=permissions)
print(target, target.stat().st_size, hashlib.sha256(target.read_bytes()).hexdigest())
