"""Create the matching public model/build sources without local device data."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile


def copy_sources(source,target,folders,files):
    omitted=shutil.ignore_patterns('.git','.github','.gitlab','.agents','.claude',
        '__pycache__','*.pyc','build','examples','test','tests','test_apps',
        '*.jpg','*.jpeg','*.png','*.gif','*.mp4')
    target.mkdir(parents=True,exist_ok=True)
    for folder in folders:
        if (source/folder).is_dir():shutil.copytree(source/folder,target/folder,ignore=omitted)
    for name in files:
        if (source/name).is_file():shutil.copyfile(source/name,target/name)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--file',type=Path,action='append',required=True,help='Explicit PT/ONNX/ESP-DL or model metadata file')
    parser.add_argument('--arduino',type=Path,required=True)
    parser.add_argument('--esp-dl',type=Path,required=True)
    parser.add_argument('--idf',type=Path,required=True)
    parser.add_argument('--libraries',type=Path,required=True)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    if subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip():
        raise SystemExit('Commit final sources before creating a public source package')
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
    name='PoseGuard-Model-Sources-v1.6.0';stage=args.output/name
    if stage.exists():raise SystemExit('Choose a fresh output directory')
    stage.mkdir(parents=True)
    subprocess.run(['git','archive','--format=zip','--output='+str(stage/'PoseGuard-source.zip'),commit],cwd=root,check=True)
    models=stage/'models';models.mkdir()
    for path in args.file:
        if path.suffix not in ('.pt','.onnx','.espdl','.info','.json'):
            raise SystemExit('Only explicitly selected model source files are allowed')
        if path.suffix=='.json':
            data=json.loads(path.read_text(encoding='utf-8'))
            if not any(key in data for key in ('model_sha256','weights_sha256','before_macs_parameters','kind')):
                raise SystemExit('Not a recognized model metadata file')
        if (models/path.name).exists():raise SystemExit('Duplicate model filename; use distinct source names')
        shutil.copyfile(path,models/path.name)
    vendor=stage/'vendor'
    copy_sources(args.arduino,vendor/'arduino-esp32-3.3.2',('cores','libraries','variants'),
        ('CMakeLists.txt','Kconfig.projbuild','LICENSE.md','package.json','idf_component.yml'))
    copy_sources(args.esp_dl,vendor/'esp-dl-3.3.14',('esp-dl',),('LICENSE','README.md'))
    copy_sources(args.idf,vendor/'esp-idf-5.5.1',('components','tools'),
        ('CMakeLists.txt','Kconfig','LICENSE','README.md','.gitmodules','export.sh','export.ps1','export.bat','install.sh','install.ps1','install.bat','version.txt'))
    for name in ('ArduinoJson','ArduinoWebsockets'):
        copy_sources(args.libraries/name,vendor/name,('src',),
            ('LICENSE','LICENSE.md','LICENSE.txt','library.properties','library.json','CMakeLists.txt','README.md'))
    sources={'commit':commit,'sources':[
        {'component':'Arduino core','version':'3.3.2','url':'https://github.com/espressif/arduino-esp32/tree/3.3.2'},
        {'component':'ESP-DL','version':'3.3.14','url':'https://github.com/espressif/esp-dl/tree/v3.3.14'},
        {'component':'ESP-IDF','version':'5.5.1','url':'https://github.com/espressif/esp-idf/tree/v5.5.1'},
        {'component':'ArduinoJson','version':'7.4.2','url':'https://github.com/bblanchon/ArduinoJson/tree/v7.4.2'},
        {'component':'ArduinoWebsockets','version':'0.5.4','url':'https://github.com/gilmaimon/ArduinoWebsockets/tree/0.5.4'},
        {'component':'Ultralytics model source','version':'8.4.103','url':'https://github.com/ultralytics/ultralytics/tree/v8.4.103'}],
        'scope':'Selected matching build sources; examples and vendor test images omitted. Private calibration videos, device credentials, flash/NVS images and signing keys are not included.'}
    (stage/'SOURCES.json').write_text(json.dumps(sources,indent=2)+'\n',encoding='utf-8')
    shutil.copyfile(root/'LICENSES.md',stage/'LICENSES.md')
    shutil.copytree(root/'licenses',stage/'licenses')
    (stage/'SOURCE_COMMIT.txt').write_text(commit+'\n',encoding='utf-8')
    (stage/'FILES.sha256').write_text(''.join(hashlib.sha256(path.read_bytes()).hexdigest()+'  '+path.relative_to(stage).as_posix()+'\n'
        for path in sorted(stage.rglob('*'))if path.is_file()),encoding='utf-8')
    target=args.output/(stage.name+'.zip')
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED)as archive:
        for path in sorted(stage.rglob('*')):
            if path.is_file():archive.write(path,stage.name+'/'+path.relative_to(stage).as_posix())
    print(json.dumps({'file':str(target),'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))


if __name__=='__main__':main()
