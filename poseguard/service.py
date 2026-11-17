"""Linux service entry point; uses the same detector, queue and cloud client."""
import argparse
import json
from pathlib import Path
import signal
import time
from poseguard import app
from poseguard.cloud.edge import append_record
from poseguard.config import load_config


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',default='/etc/poseguard/runtime.json')
    parser.add_argument('--binding',default='/var/lib/poseguard/device.private.json')
    options=parser.parse_args();config=load_config(options.config)
    output=Path(config['output']['directory']);output.mkdir(parents=True,exist_ok=True)
    stop=output/'service.stop';stop.unlink(missing_ok=True)
    signal.signal(signal.SIGTERM,lambda *_:stop.touch());signal.signal(signal.SIGINT,lambda *_:stop.touch())
    boot_file=Path('/proc/sys/kernel/random/boot_id')
    append_record(output/'service-starts.jsonl',{'started_unix':time.time(),'boot_id':boot_file.read_text().strip()if boot_file.exists()else None,'source':config['source']})
    arguments=['--config',options.config,'--no-display','--stop-file',str(stop)]
    is_video=isinstance(config['source'],str) and not config['source'].isdecimal()
    binding_path=Path(options.binding)
    test_video_cloud=(config.get('service',{}).get('allow_test_video_cloud',False)
                      and binding_path.is_file()
                      and json.loads(binding_path.read_text()).get('is_test')is True)
    if binding_path.is_file()and(not is_video or test_video_cloud):
        arguments+=['--cloud-config',options.binding]
    else:arguments+=['--local-only']
    if config.get('service',{}).get('trace_enabled',False):arguments+=['--trace-file',str(output/'trace.jsonl')]
    maximum=config.get('service',{}).get('max_frames')
    if maximum:arguments+=['--max-frames',str(maximum)]
    return app.run(app.build_parser().parse_args(arguments))


if __name__=='__main__':raise SystemExit(main())
