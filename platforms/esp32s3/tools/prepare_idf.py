"""Stage the pinned Arduino/ESP-DL build without modifying vendor originals."""
import argparse
from pathlib import Path
import shutil

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--arduino-core',type=Path,required=True)
parser.add_argument('--libraries',type=Path,required=True)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
target=args.output.resolve()
target.mkdir(parents=True,exist_ok=True)
for folder in ('idf','PoseGuardCloud'):
    shutil.copytree(root/folder,target/folder,dirs_exist_ok=True)
shutil.copytree(root.parent/'rk3566/include',target.parent/'rk3566/include',dirs_exist_ok=True)
shutil.copytree(root.parent/'rk3566/src',target.parent/'rk3566/src',dirs_exist_ok=True)
components=target/'idf/components/arduino'
components.mkdir(parents=True,exist_ok=True)
for folder in ('cores','libraries','variants'):
    shutil.copytree(args.arduino_core/folder,components/folder,dirs_exist_ok=True)
for name in ('CMakeLists.txt','Kconfig.projbuild','LICENSE.md','package.json'):
    shutil.copyfile(args.arduino_core/name,components/name)
# Only the selected core libraries are built. Retain their actual dependencies;
# no RainMaker/Zigbee/BLE/Matter binaries are used or modified.
(components/'idf_component.yml').write_text('dependencies:\n  idf: ">=5.3,<5.6"\n  espressif/mdns: "^1.2.3"\n  joltwallet/littlefs: "^1.20.2"\n',encoding='utf-8')
for library in ('ArduinoJson','ArduinoWebsockets'):
    shutil.copytree(args.libraries/library,target/'idf/libraries'/library,dirs_exist_ok=True)
print('Prepared build project',target/'idf')
