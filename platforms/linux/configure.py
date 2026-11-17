"""Create per-machine configuration; preserve existing rules and binding on upgrade."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import time
from poseguard.cloud.edge import atomic_json,enroll
from poseguard.config import default_config,load_config

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source');parser.add_argument('--server',default='https://poseguard.nanaoni.tech');parser.add_argument('--bind-code')
parser.add_argument('--trace',action='store_true');parser.add_argument('--max-frames',type=int);parser.add_argument('--allow-test-video-cloud',action='store_true')
args=parser.parse_args();root=Path('/opt/poseguard/current');data=Path('/var/lib/poseguard');settings=Path('/etc/poseguard/runtime.json')
config=load_config(settings)if settings.exists()else default_config()
if not settings.exists():config['tracking']['max_missing_seconds']=5.0
if args.source is not None:
    if args.source.isdecimal():config['source']=int(args.source)
    else:
        video=Path(args.source).resolve()
        if not video.is_file():raise RuntimeError('Video source is missing; use a camera index such as 0 or an existing video')
        inputs=data/'inputs';inputs.mkdir(exist_ok=True)
        digest=hashlib.sha256(video.read_bytes()).hexdigest()[:16];target=inputs/(digest+video.suffix)
        if video!=target:shutil.copyfile(video,target)
        config['source']=str(target)
config['models'].update(pose_path=str(root/'models/yolo11n-pose.onnx'),phone_path=str(root/'models/yolo11n.onnx'))
config['display']['enabled']=False;config['output']['directory']=str(data/'records')
service=config.setdefault('service',{})
if args.trace:service['trace_enabled']=True
if args.max_frames:service['max_frames']=args.max_frames
binding=data/'device.private.json'
if args.bind_code:
    if binding.exists():shutil.copy2(binding,binding.with_name('device.'+str(time.time_ns())+'.bak.private.json'))
    result=enroll(args.server,args.bind_code,'linux',binding)
    print('Bound unique Linux device',result['device_id'])
else:print('Existing device binding preserved'if binding.exists()else'Local recording enabled; bind later using a one-time code from the website')
if args.allow_test_video_cloud:
    bound=json.loads(binding.read_text())if binding.exists()else{}
    if bound.get('is_test')is not True:
        raise RuntimeError('Video cloud QA requires a binding created as a test device')
    service['allow_test_video_cloud']=True
if settings.exists():shutil.copyfile(settings,settings.with_name('runtime.'+str(time.time_ns())+'.bak.json'))
atomic_json(settings,config,private=True)
print('Runtime configuration saved:',settings)
