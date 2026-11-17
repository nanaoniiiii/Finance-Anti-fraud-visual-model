"""Evaluate model observations through the actual shipping C++ tracking core.

Build tests/observation_filter.cpp with platforms/rk3566/src/core.cpp first.
Three identical observations warm up confirmation only; not a tracking/FPS test.
"""
import argparse,hashlib,json,subprocess
from pathlib import Path
import cv2,numpy as np,torch
from ultralytics import YOLO
from compact_pose import C2fSplit,raw_pose_forward
from quantize_pose import decode,letterbox
from restore_general import matched

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ('model','dataset','output'):p.add_argument('--'+name,type=Path,required=True)
 p.add_argument('--size',type=int,default=128);p.add_argument('--confidence',type=float,default=.3)
 p.add_argument('--core-command',nargs='+',default=['wsl','--','/tmp/pg-observation-filter'])
 args=p.parse_args();torch.set_num_threads(4)
 model=YOLO(str(args.model)).model.eval();head=model.model[-1];head.forward=raw_pose_forward.__get__(head)
 files=json.loads((args.dataset/'split.json').read_text())['held'];batches=[];cases=[]
 with torch.inference_mode():
  for name in files:
   image=cv2.imread(str(args.dataset/'images/train2017'/name));h,w=image.shape[:2];scale=min(args.size/w,args.size/h)
   nw,nh=round(w*scale),round(h*scale);dx,dy=(args.size-nw)//2,(args.size-nh)//2
   actual=decode([v.numpy()for v in model(letterbox(image,args.size)[None])],args.confidence)[:8]
   fields=[nw,nh,len(actual)]
   for item in actual:
    box=item['bbox']-[dx,dy,dx,dy];box=np.clip(box,[0,0,0,0],[nw-1,nh-1,nw-1,nh-1])
    fields.extend([item['score'],*box])
    for k in item['keypoints']:
     x,y=k[:2]-[dx,dy];valid=k[2]>=.25 and 0<=x<nw and 0<=y<nh
     fields.extend([np.clip(x,0,nw-1),np.clip(y,0,nh-1),k[2],int(valid)])
   batches.append(' '.join(map(str,fields)))
   truth=[]
   for line in (args.dataset/'labels/train2017'/Path(name).with_suffix('.txt').name).read_text().splitlines():
    cls,x,y,bw,bh=map(float,line.split())
    if cls==0:truth.append(dict(bbox=np.array([(x-bw/2)*nw,(y-bh/2)*nh,(x+bw/2)*nw,(y+bh/2)*nh]),area=bw*bh))
   cases.append((name,truth))
 result=subprocess.run(args.core_command,input='\n'.join(batches)+'\n',capture_output=True,text=True,encoding='utf-8',errors='replace',check=True)
 lines=result.stdout.splitlines();assert len(lines)==len(cases)
 rows=[];allcounts=np.zeros(3,dtype=int);largecounts=np.zeros(3,dtype=int)
 for line,(name,truth)in zip(lines,cases):
  values=list(map(float,line.split()));count=int(values[0]);assert len(values)==1+4*count
  actual=[dict(score=1.,bbox=np.array(values[1+i*4:5+i*4]))for i in range(count)]
  allmatch=matched(actual,truth);allcounts+=allmatch
  large=[v for v in truth if v['area']>=.015]
  # Predictions correctly matching smaller labelled people remain true positives.
  tp,fp,fn=matched(actual,large);smallmatch=matched(actual,[v for v in truth if v['area']<.015])[0]
  largecounts+=np.array([tp,max(0,fp-smallmatch),fn])
  rows.append(dict(image=name,accepted_people=count,tp=allmatch[0],fp=allmatch[1],fn=allmatch[2]))
 def summary(values):
  tp,fp,fn=map(int,values);return dict(tp=tp,fp=fp,fn=fn,precision=tp/max(1,tp+fp),recall=tp/max(1,tp+fn))
 report=dict(model_sha256=hashlib.sha256(args.model.read_bytes()).hexdigest(),size=args.size,confidence=args.confidence,images=len(cases),
  scope='Small disjoint COCO subset, actual C++ filtering; repeated confirmation is not temporal validation',all_people=summary(allcounts),
  people_area_at_least_1_5_percent=summary(largecounts),rows=rows)
 args.output.write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps({k:v for k,v in report.items()if k!='rows'}))
if __name__=='__main__':main()
