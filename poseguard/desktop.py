"""Portable desktop launcher; device secrets are created per installation."""
from __future__ import annotations
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import uuid

from poseguard.cloud.edge import atomic_json,enroll
from poseguard.config import default_config,load_config

VERSION='1.6.0'


def data_root():
    return Path(os.environ.get('POSEGUARD_HOME') or Path(os.environ.get('LOCALAPPDATA') or Path.home()/'.local/share')/'PoseGuard')


def models_root():
    return Path(os.environ.get('POSEGUARD_MODEL_DIR') or Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parents[1]))/'models')


def runtime_config(root,source=None):
    root.mkdir(parents=True,exist_ok=True);settings=root/'settings.json'
    if not settings.exists():atomic_json(settings,default_config())
    config=load_config(settings)
    if source is not None:config['source']=int(source)if str(source).isdecimal()else str(source)
    model_dir=models_root();config['models'].update(pose_path=str(model_dir/'yolo11n-pose.onnx'),phone_path=str(model_dir/'yolo11n.onnx'))
    for key in ('pose_path','phone_path'):
        if not Path(config['models'][key]).is_file():raise RuntimeError('模型文件缺失，请解压完整的 PoseGuard 发行包。')
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]
    session=root/'runs'/stamp;session.mkdir(parents=True)
    config['output']['directory']=str(session)
    destination=session/'runtime.json';atomic_json(destination,config)
    return destination,session


def self_test(output):
    import cv2,numpy as np,onnxruntime as ort
    from poseguard.backends.onnx_yolo import OnnxPoseBackend,OnnxPhoneBackend
    image=np.zeros((240,320,3),dtype=np.uint8);models=models_root()
    pose=OnnxPoseBackend(models/'yolo11n-pose.onnx');people=pose.infer(image)
    phone=OnnxPhoneBackend(models/'yolo11n.onnx');predictions,_=phone.run(image)
    report={'version':VERSION,'frozen':bool(getattr(sys,'frozen',False)),'python':sys.version.split()[0],'opencv':cv2.__version__,'onnxruntime':ort.__version__,'pose_people_on_black_image':len(people),'phone_output_channels':int(predictions.shape[1]),'models':{path.name:hashlib.sha256(path.read_bytes()).hexdigest()for path in models.glob('*.onnx')},'external_requests':False}
    output.mkdir(parents=True,exist_ok=True);atomic_json(output/'self-test.json',report)
    if people or predictions.shape[1]!=84:raise RuntimeError('Model smoke test failed')
    print(json.dumps(report,ensure_ascii=False));return 0


def gui():
    import tkinter as tk
    from tkinter import ttk,filedialog,messagebox
    root_path=data_root();root_path.mkdir(parents=True,exist_ok=True)
    (root_path/'runs').mkdir(exist_ok=True)
    settings=root_path/'settings.json'
    if not settings.exists():atomic_json(settings,default_config())
    saved=load_config(settings)
    window=tk.Tk();window.title('PoseGuard · 检测终端');window.geometry('740x580');window.minsize(650,540)
    window.configure(background='#f3f6f8');style=ttk.Style(window);style.theme_use('clam')
    style.configure('TFrame',background='#f3f6f8');style.configure('TLabel',background='#f3f6f8',foreground='#172b3b',font=('Microsoft YaHei UI',10))
    style.configure('TButton',font=('Microsoft YaHei UI',10),padding=(12,8));style.configure('Title.TLabel',font=('Microsoft YaHei UI',22,'bold'))
    frame=ttk.Frame(window,padding=28);frame.pack(fill='both',expand=True);frame.columnconfigure(0,weight=1)
    ttk.Label(frame,text='PoseGuard 检测终端',style='Title.TLabel').grid(row=0,column=0,columnspan=3,sticky='w')
    ttk.Label(frame,text='本地识别与记录，联网后同步到网页和 App。').grid(row=1,column=0,columnspan=3,sticky='w',pady=(8,22))
    source=tk.StringVar(value=str(saved.get('source',0)));server=tk.StringVar(value='https://poseguard.nanaoni.tech');code=tk.StringVar();direction=tk.StringVar(value='auto')
    status=tk.StringVar(value='就绪 · 选择摄像头或视频后开始检测');binding=tk.StringVar(value='尚未绑定；仍可保存本地记录')
    cloud=root_path/'cloud-device.private.json'
    if cloud.exists():
        cfg=json.loads(cloud.read_text(encoding='utf-8'));server.set(cfg['server_url']);binding.set('已绑定设备 · '+cfg['device_id'][:8])
    ttk.Label(frame,text='画面来源（摄像头编号或视频）').grid(row=2,column=0,columnspan=3,sticky='w')
    ttk.Entry(frame,textvariable=source).grid(row=3,column=0,sticky='ew',pady=7)
    ttk.Button(frame,text='摄像头 0',command=lambda:source.set('0')).grid(row=3,column=1,padx=6)
    def choose_video():
        name=filedialog.askopenfilename(title='选择测试视频',filetypes=[('视频','*.mp4 *.avi *.mov *.mkv'),('全部文件','*.*')])
        if name:source.set(name)
    ttk.Button(frame,text='选择视频',command=choose_video).grid(row=3,column=2)
    ttk.Label(frame,text='视频测试只保存本地记录，不发送真实告警。').grid(row=4,column=0,columnspan=3,sticky='w',pady=(0,14))
    controls=ttk.Frame(frame);controls.grid(row=5,column=0,columnspan=3,sticky='ew',pady=(0,18))
    ttk.Label(controls,text='离线安装方向').pack(side='left')
    ttk.Combobox(controls,textvariable=direction,values=('auto','0','90','180','270'),state='readonly',width=10).pack(side='left',padx=10)
    ttk.Label(controls,text='绑定后可在网页 / App 调整').pack(side='left')
    ttk.Separator(frame).grid(row=6,column=0,columnspan=3,sticky='ew',pady=(0,17))
    ttk.Label(frame,text='云端地址').grid(row=7,column=0,columnspan=3,sticky='w')
    ttk.Entry(frame,textvariable=server).grid(row=8,column=0,columnspan=3,sticky='ew',pady=7)
    ttk.Label(frame,text='一次性绑定码（网页“设备与绑定”中生成）').grid(row=9,column=0,columnspan=3,sticky='w')
    ttk.Entry(frame,textvariable=code).grid(row=10,column=0,sticky='ew',pady=7)
    messages=queue.Queue();process=None;log_file=None;stop_path=root_path/'detector.stop';closing=False
    def bind():
        if not code.get().strip():messagebox.showinfo('绑定设备','请先填写网页生成的一次性绑定码。');return
        url,value=server.get().strip(),code.get().strip();binding.set('正在绑定设备…');bind_button.configure(state='disabled')
        def worker():
            try:
                if cloud.exists():
                    backup=cloud.with_name('cloud-device-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.private.json');backup.write_bytes(cloud.read_bytes())
                result=enroll(url,value,'windows',cloud);messages.put(('bound','已绑定设备 · '+result['device_id'][:8]))
            except Exception as error:messages.put(('error','绑定失败：'+str(error)))
        threading.Thread(target=worker,daemon=True).start()
    bind_button=ttk.Button(frame,text='绑定这台电脑',command=bind);bind_button.grid(row=10,column=1,columnspan=2,padx=(6,0),sticky='ew')
    ttk.Label(frame,textvariable=binding).grid(row=11,column=0,columnspan=3,sticky='w',pady=(1,14))
    ttk.Label(frame,textvariable=status,wraplength=650).grid(row=12,column=0,columnspan=3,sticky='w')
    actions=ttk.Frame(frame);actions.grid(row=13,column=0,columnspan=3,sticky='ew',pady=(17,0))
    def start():
        nonlocal process,log_file
        if process and process.poll()is None:return
        try:
            selected=source.get().strip()
            if not selected:raise ValueError('请选择摄像头或视频。')
            configuration,session=runtime_config(root_path,selected)
            config=load_config(settings);config['source']=int(selected)if selected.isdecimal()else selected;atomic_json(settings,config)
            stop_path.unlink(missing_ok=True)
            command=[sys.executable]+([]if getattr(sys,'frozen',False)else['-m','poseguard.desktop'])+['--config',str(configuration),'--source',selected,'--camera-rotation',direction.get(),'--stop-file',str(stop_path),'--trace-file',str(session/'trace.jsonl')]
            if selected.isdecimal()and cloud.exists():command+=['--cloud-config',str(cloud)]
            else:command+=['--local-only']
            log_file=(session/'runtime.log').open('a',encoding='utf-8');process=subprocess.Popen(command,stdout=log_file,stderr=log_file,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            status.set('检测运行中 · 按 Q / Esc 或点击“停止检测”结束');start_button.configure(state='disabled')
        except Exception as error:messagebox.showerror('无法开始检测',str(error))
    def stop():
        if process and process.poll()is None:stop_path.touch();status.set('正在保存记录并停止…')
    start_button=ttk.Button(actions,text='开始检测',command=start);start_button.pack(side='left')
    ttk.Button(actions,text='停止检测',command=stop).pack(side='left',padx=8)
    ttk.Button(actions,text='本地记录',command=lambda:os.startfile(root_path/'runs')).pack(side='right')
    def open_settings():os.startfile(settings)
    ttk.Button(actions,text='检测规则',command=open_settings).pack(side='right',padx=8)
    def close():
        nonlocal closing
        closing=True;stop()
        if not process or process.poll()is not None:window.destroy()
    def poll():
        nonlocal log_file
        while not messages.empty():
            kind,text=messages.get();binding.set(text);bind_button.configure(state='normal')
            if kind=='bound':code.set('')
        if process and process.poll()is not None:
            if log_file:log_file.close();log_file=None;status.set('检测已停止，记录已保留。'if process.returncode==0 else'检测未正常结束，请打开本地记录查看 runtime.log。');start_button.configure(state='normal')
        if closing and (not process or process.poll()is not None):window.destroy();return
        window.after(200,poll)
    window.protocol('WM_DELETE_WINDOW',close);window.after(200,poll);window.mainloop();return 0


def main():
    root=data_root();root.mkdir(parents=True,exist_ok=True)
    if sys.stdout is None:sys.stdout=(root/'launcher.log').open('a',encoding='utf-8',buffering=1)
    if sys.stderr is None:sys.stderr=sys.stdout
    if '--self-test'in sys.argv:
        parser=argparse.ArgumentParser();parser.add_argument('--self-test',action='store_true');parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();return self_test(args.output)
    if '--version'in sys.argv:print(VERSION);return 0
    if '--bind-code'in sys.argv:
        parser=argparse.ArgumentParser(description='Bind this installation using a one-time Windows device code')
        parser.add_argument('--bind-code',required=True)
        parser.add_argument('--server',default='https://poseguard.nanaoni.tech')
        args=parser.parse_args()
        print(json.dumps(enroll(args.server,args.bind_code,'windows',root/'cloud-device.private.json'),ensure_ascii=False))
        return 0
    if len(sys.argv)>1:
        if '--config'not in sys.argv:
            config,_=runtime_config(root);sys.argv+=['--config',str(config)]
        from poseguard.app import main as detect
        return detect()
    return gui()


if __name__=='__main__':raise SystemExit(main())
