"""Package public firmware/model files from a clean source revision.

Never includes NVS, LittleFS images, event screenshots, Wi-Fi credentials or
device tokens. Upgrades write only the application; fresh boards explicitly
choose the full bootloader/partition/application command.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--model', type=Path, action='append', required=True)
    parser.add_argument('--default-model', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--qa', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    commit = subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
    if subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip() and not args.qa:
        raise SystemExit('Commit the final sources before public packaging')
    name = 'PoseGuard-ESP32S3-v1.6.0'
    stage = args.output / name
    if stage.exists(): raise SystemExit('Choose a fresh output directory')
    stage.mkdir(parents=True)
    flash = json.loads((args.build/'flasher_args.json').read_text())
    expected = {'0x0':'bootloader/bootloader.bin','0x8000':'partition_table/partition-table.bin',
                '0xe000':'ota_data_initial.bin','0x10000':'poseguard_s3.bin'}
    if flash['flash_files'] != expected: raise SystemExit('Unexpected flash layout')
    app = args.build/'poseguard_s3.bin'
    if app.stat().st_size > 0x200000: raise SystemExit('App exceeds the preserved 2MB partition')
    for relative in expected.values():
        target = stage/relative; target.parent.mkdir(exist_ok=True,parents=True)
        shutil.copyfile(args.build/relative,target)
    (stage/'flash_args.json').write_text(json.dumps(flash,indent=2)+'\n',encoding='utf-8')
    models = stage/'models'; models.mkdir()
    benchmarks = root/'docs/esp32s3-model-benchmarks.json'
    calibration_steps = {v['model_sha256']: v.get('calibration_steps')
                         for v in json.loads(benchmarks.read_text(encoding='utf-8'))['variants']}
    for path in args.model:
        if path.suffix != '.espdl' or path.read_bytes()[:4] != b'EDL2': raise SystemExit('Expected ESP-DL EDL2 model')
        if (models/path.name).exists(): raise SystemExit('Duplicate model filename')
        shutil.copyfile(path,models/path.name)
        metadata = path.with_suffix('.json')
        if metadata.exists():
            data = json.loads(metadata.read_text(encoding='utf-8'))
            data.pop('frames', None)
            measured_steps = calibration_steps.get(data.get('model_sha256'))
            if 'calibration_steps' not in data and measured_steps is not None and 'calibration_frames' in data:
                data['calibration_pool_frames']=data.pop('calibration_frames')
                data['calibration_steps']=measured_steps
            (models/metadata.name).write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
    if not (models/args.default_model).is_file(): raise SystemExit('Default model not packaged')
    (stage/'DEFAULT_MODEL.txt').write_text(args.default_model+'\n',encoding='utf-8')
    shutil.copytree(root/'platforms/esp32s3/tools',stage/'tools',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    shutil.copyfile(root/'docs/ESP32S3.zh-CN.md',stage/'README.zh-CN.md')
    shutil.copyfile(benchmarks,stage/'esp32s3-model-benchmarks.json')
    shutil.copyfile(root/'docs/esp32s3-fps-validation-2026-11-16.md',stage/'esp32s3-fps-validation-2026-11-16.md')
    shutil.copyfile(root/'LICENSES.md',stage/'LICENSES.md')
    (stage/'licenses').mkdir()
    shutil.copyfile(root/'licenses/Ultralytics-AGPL-3.0.txt',stage/'licenses/Ultralytics-AGPL-3.0.txt')
    (stage/'SOURCE_COMMIT.txt').write_text(commit+('-WORKTREE-QA'if args.qa else'')+'\n',encoding='utf-8')
    (stage/'VERSION').write_text('1.6.0\n',encoding='utf-8')
    (stage/'FILES.sha256').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(stage).as_posix()+'\n'
        for p in sorted(stage.rglob('*'))if p.is_file()),encoding='utf-8')
    target = args.output/(name+'.zip')
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED)as archive:
        for path in sorted(stage.rglob('*')):
            if path.is_file():archive.write(path,name+'/'+path.relative_to(stage).as_posix())
    print(json.dumps({'file':str(target),'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))


if __name__=='__main__':main()
