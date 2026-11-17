import os
from pathlib import Path
repo=Path(SPECPATH).resolve().parents[1]
model_dir=Path(os.environ['POSEGUARD_BUILD_MODELS'])
analysis=Analysis([str(repo/'platforms/windows/entry.py')],pathex=[str(repo)],binaries=[],datas=[(str(model_dir/'yolo11n-pose.onnx'),'models'),(str(model_dir/'yolo11n.onnx'),'models'),(str(repo/'licenses'),'licenses')],hiddenimports=['onnxruntime','tkinter','PIL.ImageFont','websocket'],hookspath=[],hooksconfig={},runtime_hooks=[],excludes=['torch','torchvision','ultralytics','pandas','scipy','matplotlib','pytest','IPython','notebook','esp_ppq'],noarchive=False,optimize=1)
pyz=PYZ(analysis.pure)
exe=EXE(pyz,analysis.scripts,analysis.binaries,analysis.datas,[],name='PoseGuard',debug=False,bootloader_ignore_signals=False,strip=False,upx=False,console=False,disable_windowed_traceback=False)
