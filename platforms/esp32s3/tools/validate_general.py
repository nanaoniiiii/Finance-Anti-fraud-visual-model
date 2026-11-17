"""Small COCO/person and unusable-image sanity checks, not full COCO mAP.

COCO128 overlaps teacher pretraining. An explicit split.json can instead
select disjoint images for a bounded custom subset. These measurements do
not establish a full-dataset or banking-scene accuracy certificate.
No images, private video frames or device credentials are written to reports.
"""
import argparse
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
import torch
from ultralytics import YOLO
from compact_pose import C2fSplit, raw_pose_forward
from quantize_pose import letterbox, decode

def iou(a,b):
    left=np.maximum(a[:2],b[:2]);right=np.minimum(a[2:],b[2:])
    intersection=np.maximum(right-left,0).prod()
    return intersection/max(1e-9,(a[2:]-a[:2]).prod()+(b[2:]-b[:2]).prod()-intersection)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model',type=Path,required=True)
    p.add_argument('--size',type=int,required=True)
    p.add_argument('--dataset',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--extra-negative',type=Path,nargs='*',default=[])
    p.add_argument('--split',choices=('all','train','held'),default='all')
    p.add_argument('--confidence',type=float,default=.3)
    args=p.parse_args();torch.set_num_threads(4)
    model=YOLO(str(args.model)).model.eval();head=model.model[-1];head.forward=raw_pose_forward.__get__(head)
    rows=[];total=np.zeros(3,dtype=int)
    manifest=args.dataset/'split.json'
    explicit=json.loads(manifest.read_text()) if manifest.exists() else None
    with torch.inference_mode():
        for index,path in enumerate(sorted((args.dataset/'images/train2017').glob('*.jpg'))):
            if explicit:
                if args.split!='all'and path.name not in explicit[args.split]:continue
            elif args.split=='train'and index%5==0 or args.split=='held'and index%5!=0:continue
            image=cv2.imread(str(path));h,w=image.shape[:2];scale=min(args.size/w,args.size/h)
            dx=(args.size-round(w*scale))//2;dy=(args.size-round(h*scale))//2
            truth=[]
            label=args.dataset/'labels/train2017'/path.with_suffix('.txt').name
            for line in label.read_text().splitlines() if label.exists() else []:
                cls,x,y,bw,bh=map(float,line.split())
                if cls==0:truth.append(np.array([(x-bw/2)*w*scale+dx,(y-bh/2)*h*scale+dy,(x+bw/2)*w*scale+dx,(y+bh/2)*h*scale+dy]))
            actual=decode([v.numpy()for v in model(letterbox(image,args.size)[None])],args.confidence);used=set();tp=0
            for item in sorted(actual,key=lambda a:a['score'],reverse=True):
                options=[(iou(item['bbox'],box),i)for i,box in enumerate(truth)if i not in used]
                if options:
                    overlap,chosen=max(options)
                    if overlap>=.5:used.add(chosen);tp+=1
            fp,fn=len(actual)-tp,len(truth)-tp;total+=np.array([tp,fp,fn])
            rows.append(dict(image=path.name,truth=len(truth),predicted=len(actual),tp=tp,fp=fp,fn=fn))
        negative=[]
        images=[(f'uniform_{level}',np.full((240,320,3),level,np.uint8))for level in (0,8,16,64,114,255)]
        images += [(path.name,cv2.imread(str(path)))for path in args.extra_negative]
        for name,image in images:
            if image is None:raise RuntimeError('Invalid negative input')
            actual=decode([v.numpy()for v in model(letterbox(image,args.size)[None])],args.confidence)
            negative.append(dict(image=name,people=len(actual),max_confidence=max((v['score']for v in actual),default=0)))
    tp,fp,fn=map(int,total)
    result=dict(model_sha256=hashlib.sha256(args.model.read_bytes()).hexdigest(),size=args.size,split=args.split,
                scope='Small custom COCO subset check; not full COCO mAP' if explicit else 'COCO128 sanity check; overlaps teacher pretraining; not independent accuracy or mAP',
                images=len(rows),confidence=args.confidence,iou=.5,tp=tp,fp=fp,fn=fn,precision=tp/max(1,tp+fp),recall=tp/max(1,tp+fn),negative=negative,rows=rows)
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items()if k!='rows'}),flush=True)
if __name__=='__main__':main()
