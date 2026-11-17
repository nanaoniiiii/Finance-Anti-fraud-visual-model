"""Maix launcher entry; settings and binding remain outside the application."""
import json
import os
import sys
import importlib.util
import time
import traceback

SETTINGS='/root/poseguard-data/maix/runtime.json'

def main():
    with open(SETTINGS,'r',encoding='utf-8')as stream:settings=json.load(stream)
    runtime=os.path.abspath(settings.get('runtime_directory','/root/poseguard-maix'))
    if not os.path.isdir(runtime):raise RuntimeError('PoseGuard runtime is not installed')
    directory=os.path.dirname(SETTINGS)
    log_path=os.path.join(directory,'runtime.log')
    if os.path.exists(log_path)and os.path.getsize(log_path)>2*1024*1024:
        os.replace(log_path,log_path+'.previous')
    descriptor=os.open(log_path,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
    os.dup2(descriptor,1);os.dup2(descriptor,2);os.close(descriptor)
    def state(value,**extra):
        path=os.path.join(directory,'runtime-state.json')
        with open(path+'.new','w',encoding='utf-8')as stream:
            json.dump(dict(state=value,pid=os.getpid(),recorded_unix=time.time(),**extra),stream)
        os.replace(path+'.new',path)
    state('starting',benchmark=bool(settings.get('benchmark',False)))
    sys.path.insert(0,runtime)
    try:
        spec=importlib.util.spec_from_file_location('poseguard_maix_runtime',os.path.join(runtime,'main.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        result=module.run(no_display=bool(settings.get('no_display',False)),
            benchmark=bool(settings.get('benchmark',False)),
            cloud_config=settings.get('cloud_config'),
            data_directory=settings.get('data_directory','/root/poseguard-data/maix'),
            on_ready=lambda details:state('running',benchmark=bool(settings.get('benchmark',False)),**details))
        state('stopped');return result
    except BaseException as error:
        traceback.print_exc();state('failed',error=type(error).__name__);raise

if __name__=='__main__':raise SystemExit(main())
