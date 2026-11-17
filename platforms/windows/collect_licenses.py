"""Collect installed wheel notices and Python/Tcl/Tk licenses for redistribution."""
import argparse
import importlib.metadata as metadata
from pathlib import Path
import shutil
import sys
import tkinter
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
options = parser.parse_args()
options.output.mkdir(parents=True, exist_ok=True)
index = []
for package in ('numpy', 'opencv-python', 'onnxruntime', 'Pillow', 'websocket-client',
                'coloredlogs', 'flatbuffers', 'humanfriendly', 'mpmath',
                'packaging', 'protobuf', 'pyreadline3', 'sympy', 'pyinstaller'):
    distribution = metadata.distribution(package)
    copied = []
    for entry in distribution.files or ():
        if not any(part in entry.name.lower() for part in ('license', 'notice', 'copying', 'authors')):
            continue
        source = Path(distribution.locate_file(entry))
        if not source.is_file():
            continue
        destination = options.output / package / str(entry).replace('..', '_')
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            destination.chmod(0o644)
        shutil.copyfile(source, destination)
        copied.append(destination.relative_to(options.output).as_posix())
    if not copied and package == 'flatbuffers':
        url = f'https://raw.githubusercontent.com/google/flatbuffers/v{distribution.version}/LICENSE'
        with urllib.request.urlopen(url, timeout=30) as response:
            body = response.read()
        if b'Apache License' not in body:
            raise RuntimeError('Unexpected FlatBuffers license')
        destination = options.output / package / 'LICENSE'
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)
        copied.append(str(destination))
        index.append(url)
    if not copied:
        raise RuntimeError('No license found for ' + package)
    index.append(f'{package} {distribution.version}')
for relative in ('LICENSE.txt', 'tcl/tcl8.6/license.terms', 'tcl/tk8.6/license.terms'):
    source = Path(sys.base_prefix) / relative
    destination = options.output / 'python' / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_file():
        shutil.copyfile(source, destination)
    elif relative.startswith('tcl/'):
        version = str(tkinter.Tcl().call('info', 'patchlevel'))
        component = 'tcl' if '/tcl8.' in relative else 'tk'
        url = f'https://raw.githubusercontent.com/tcltk/{component}/core-{version.replace(".", "-")}/license.terms'
        with urllib.request.urlopen(url, timeout=30) as response:
            body = response.read()
        if b'copyrighted' not in body or len(body) < 1000:
            raise RuntimeError('Unexpected upstream license response')
        destination.write_bytes(body)
        index.append(f'{component} {version}: {url}')
    else:
        raise RuntimeError('Missing runtime notice ' + str(source))
(options.output / 'VERSIONS.txt').write_text('\n'.join(index) + '\n', encoding='utf-8')
print('Collected notices for', ', '.join(index))
