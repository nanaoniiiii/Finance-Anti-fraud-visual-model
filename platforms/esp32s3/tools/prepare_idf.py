"""Stage the pinned Arduino/ESP-DL build without modifying vendor originals."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import ssl
from urllib.parse import urlsplit

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--arduino-core',type=Path,required=True)
parser.add_argument('--libraries',type=Path,required=True)
parser.add_argument('--station-origin', help='HTTPS origin of a local PoseGuard station')
parser.add_argument('--station-ca', type=Path, help='PEM CA trusted by that station')
args=parser.parse_args()
if bool(args.station_origin) != bool(args.station_ca):
    parser.error('--station-origin and --station-ca must be supplied together')

station_header = None
if args.station_origin:
    try:
        origin = urlsplit(args.station_origin)
        port = origin.port
    except ValueError as error:
        parser.error(str(error))
    if (origin.scheme != 'https' or origin.username is not None or origin.password is not None
            or origin.path not in ('', '/') or origin.query or origin.fragment or port == 0
            or not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', origin.hostname or '')):
        parser.error('Provide an HTTPS DNS origin with an optional port and no path')
    host = origin.hostname
    authority = f'{host}:{port}' if port not in (None, 443) else host
    address = 'https://' + authority
    if address == 'https://poseguard.nanaoni.tech':
        parser.error('Omit station arguments to build for the existing PoseGuard cloud')
    certificate = args.station_ca.read_text(encoding='ascii').strip()
    if not re.fullmatch(
        r'(?:-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+',
        certificate,
    ):
        parser.error('--station-ca must contain PEM certificates')
    ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_verify_locations(cadata=certificate)
    namespace = 'pg-' + hashlib.sha256(address.encode()).hexdigest()[:12]
    station_header = (
        '#pragma once\n'
        f'static constexpr char POSEGUARD_ORIGIN[] = "{address}";\n'
        f'static constexpr char POSEGUARD_STORAGE[] = "{namespace}";\n'
        f'static const char POSEGUARD_TRUSTED_CA[] = R"PG_CA({certificate}\n)PG_CA";\n'
    )
root=Path(__file__).resolve().parents[1]
target=args.output.resolve()
target.mkdir(parents=True,exist_ok=True)
for folder in ('idf','PoseGuardCloud'):
    shutil.copytree(root/folder,target/folder,dirs_exist_ok=True)
header = target / 'PoseGuardCloud' / 'StationTarget.h'
if station_header:
    header.write_text(station_header, encoding='ascii')
else:
    header.unlink(missing_ok=True)
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
