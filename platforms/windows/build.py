"""Build the CPU-only portable executable in a prepared Windows environment."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--models', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if sys.platform != 'win32':
    raise SystemExit('Build this executable on Windows')
root = Path(__file__).resolve().parents[2]
for name in ('yolo11n-pose.onnx', 'yolo11n.onnx'):
    if not (args.models / name).is_file():
        raise SystemExit('Missing exported ONNX model: ' + name)
environment = {**os.environ, 'POSEGUARD_BUILD_MODELS': str(args.models.resolve())}
subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
                '--distpath', str(args.output.resolve() / 'dist'),
                '--workpath', str(args.output.resolve() / 'build'),
                str(root / 'platforms/windows/PoseGuard.spec')],
               cwd=root, env=environment, check=True)
