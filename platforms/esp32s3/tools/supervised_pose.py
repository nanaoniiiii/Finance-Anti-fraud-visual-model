"""Fine-tune a structurally pruned pose model without rebuilding its channels.

COCO images use original human box/keypoint annotations. Private video frames
use original-model pseudo labels and remain local. The explicit general-image
split is disjoint; the interleaved video split is correlated regression only.
"""
import argparse,copy,hashlib,json,math,random,time
from pathlib import Path
import cv2,numpy as np,torch
from torch.nn import functional as F
from ultralytics import YOLO
from ultralytics.cfg import get_cfg
from ultralytics.utils.torch_utils import ModelEMA
from compact_pose import C2fSplit,raw_pose_forward
from distill_pose import tensors
from quantize_pose import letterbox,decode,phone
from restore_general import matched

FLIP=[0,2,1,4,3,6,5,8,7,10,9,12,11,14,13,16,15]

def labels_to_record(boxes,points):
    boxes=torch.tensor(np.asarray(boxes),dtype=torch.float32).reshape(-1,4)
    points=torch.tensor(np.asarray(points),dtype=torch.float32).reshape(-1,17,3)
    return boxes,points

def pseudo(model,images,size):
    records=[];references=[]
    with torch.inference_mode():
        for image in images:
            actual=decode([v.numpy()for v in model(image[None])]);references.append(actual)
            boxes=[];points=[]
            for item in actual:
                xyxy=np.clip(item['bbox']/size,0,1)
                if (xyxy[2:]-xyxy[:2]).min()<=0:continue
                boxes.append(np.r_[(xyxy[:2]+xyxy[2:])/2,xyxy[2:]-xyxy[:2]])
                key=item['keypoints'].copy();key[:,:2]=np.clip(key[:,:2]/size,0,1);key[:,2]=np.where(key[:,2]>=.3,2,0)
                points.append(key)
            records.append(labels_to_record(boxes,points))
    return records,references

def checkpoint(model,path,report):
    saved=copy.deepcopy(model).eval().cpu()
    if hasattr(saved,'criterion'):del saved.criterion
    if 'forward'in saved.model[-1].__dict__:del saved.model[-1].forward
    torch.save(dict(model=saved,train_args={'task':'pose'},epoch=report['step'],poseguard_supervision=report),path)

def evaluate(model,pools,references,size):
    model.eval();head=model.model[-1];head.forward=raw_pose_forward.__get__(head)
    result={}
    try:
        with torch.inference_mode():
            for name,images,truth in zip(('domain','general','negative'),pools,references):
                tp=fp=fn=agreement=phones=phone_count=0
                for image,reference in zip(images,truth):
                    actual=decode([v.numpy()for v in model(image[None])]);a,b,c=matched(actual,reference);tp+=a;fp+=b;fn+=c
                    agreement+=len(actual)==len(reference)
                    if any(map(phone,reference)):phone_count+=1;phones+=any(map(phone,actual))
                result[name]=dict(tp=tp,fp=fp,fn=fn,precision=tp/max(1,tp+fp),recall=tp/max(1,tp+fn),
                    count_agreement=agreement/len(images),phone_recall=phones/max(1,phone_count),phone_frames=phone_count)
    finally:del head.forward
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('teacher','student','dataset','output'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--videos',type=Path,nargs='+',required=True)
    p.add_argument('--negative-images',type=Path,nargs='*',default=[])
    p.add_argument('--size',type=int,default=128);p.add_argument('--teacher-size',type=int,default=384)
    p.add_argument('--steps',type=int,default=6000);p.add_argument('--threads',type=int,default=4)
    p.add_argument('--general-batch',type=int,choices=(4,5,6),default=4)
    p.add_argument('--classification-gain',type=float,default=1.)
    p.add_argument('--pose-gain',type=float,default=12.)
    p.add_argument('--affine',action='store_true')
    args=p.parse_args();torch.set_num_threads(args.threads);torch.manual_seed(42);random.seed(42);np.random.seed(42)
    manifest=json.loads((args.dataset/'split.json').read_text());annotation=json.loads((args.dataset/'person_keypoints_val2017.json').read_text())
    byid={}
    for ann in annotation['annotations']:
        if not ann.get('iscrowd'):byid.setdefault(ann['image_id'],[]).append(ann)
    images_byname={v['file_name']:v for v in annotation['images']}
    general={};general_labels={}
    for part in ('train','held'):
        images=[];records=[]
        for name in manifest[part]:
            image=cv2.imread(str(args.dataset/'images/train2017'/name));h,w=image.shape[:2]
            scale=min(args.size/w,args.size/h);dx=(args.size-round(w*scale))//2;dy=(args.size-round(h*scale))//2
            boxes=[];points=[]
            for ann in byid.get(images_byname[name]['id'],[]):
                x,y,bw,bh=ann['bbox'];xyxy=np.array([x,y,x+bw,y+bh])*scale+np.array([dx,dy,dx,dy]);xyxy=np.clip(xyxy/args.size,0,1)
                if (xyxy[2:]-xyxy[:2]).min()<=0:continue
                boxes.append(np.r_[(xyxy[:2]+xyxy[2:])/2,xyxy[2:]-xyxy[:2]])
                key=np.asarray(ann['keypoints'],np.float32).reshape(17,3);key[:,:2]=(key[:,:2]*scale+[dx,dy])/args.size
                key[:,:2]=np.clip(key[:,:2],0,1);points.append(key)
            images.append(letterbox(image,args.size));records.append(labels_to_record(boxes,points))
        general[part]=torch.stack(images);general_labels[part]=records
    del annotation,byid
    teacher=YOLO(str(args.teacher)).model.eval();head=teacher.model[-1];head.forward=raw_pose_forward.__get__(head)
    domain,held,ids=tensors(args.videos,args.teacher_size,'interleaved')
    domain_labels,_=pseudo(teacher,domain,args.teacher_size);_,held_refs=pseudo(teacher,held,args.teacher_size)
    for reference in held_refs:
        for item in reference:item['bbox']*=args.size/args.teacher_size;item['keypoints'][:,:2]*=args.size/args.teacher_size
    domain=F.interpolate(domain,(args.size,args.size),mode='bilinear',align_corners=False)
    held=F.interpolate(held,(args.size,args.size),mode='bilinear',align_corners=False)
    negatives=[]
    for level in (0,8,16,32,64,114,200,255):
        negatives.append(letterbox(np.full((240,320,3),level,np.uint8),args.size))
        negatives.append(letterbox(np.random.normal(level,5,(240,320,3)).clip(0,255).astype(np.uint8),args.size))
    for color in ((0,80,0),(0,120,0)):
        negatives.append(letterbox((np.full((240,320,3),color,np.float32)+np.random.normal(0,8,(240,320,3))).clip(0,255).astype(np.uint8),args.size))
    negatives += [letterbox(cv2.imread(str(path)),args.size)for path in args.negative_images]
    negatives=torch.stack(negatives);empty=labels_to_record([],[])
    pools=[domain,general['train'],negatives];labels=[domain_labels,general_labels['train'],[empty]*len(negatives)]
    general_refs=[]
    for boxes,points in general_labels['held']:
        items=[]
        for box,key in zip(boxes.numpy(),points.numpy()):
            xyxy=np.r_[box[:2]-box[2:]/2,box[:2]+box[2:]/2]*args.size;k=key.copy();k[:,:2]*=args.size;k[:,2]=(k[:,2]>0).astype(np.float32)
            items.append(dict(bbox=xyxy,keypoints=k,score=1.))
        general_refs.append(items)
    del teacher
    student=YOLO(str(args.student)).model.float();student.args=get_cfg();student.args.cls=args.classification_gain;student.args.pose=args.pose_gain
    for parameter in student.parameters():parameter.requires_grad_(True)
    ema=ModelEMA(student);optimizer=torch.optim.AdamW(student.parameters(),lr=.0003,weight_decay=.0001)
    phoneids=[i for i,(boxes,key)in enumerate(domain_labels)if any(phone(dict(bbox=np.r_[b[:2]-b[2:]/2,b[:2]+b[2:]/2]*args.size,keypoints=np.c_[k[:,:2]*args.size,(k[:,2]>0).numpy()]))for b,k in zip(boxes.numpy(),key))]
    args.output.parent.mkdir(parents=True,exist_ok=True)
    provenance=dict(size=args.size,teacher_size=args.teacher_size,seed=42,loss='Ultralytics v8PoseLoss on human COCO annotations and private-video teacher pseudo labels',
        source_model_sha256=hashlib.sha256(args.student.read_bytes()).hexdigest(),teacher_sha256=hashlib.sha256(args.teacher.read_bytes()).hexdigest(),
        split_sha256=hashlib.sha256((args.dataset/'split.json').read_bytes()).hexdigest(),video_frame_ids=ids,
        general_train=len(general['train']),general_held=len(general['held']),domain_train=len(domain),domain_held=len(held),
        scope='Custom disjoint COCO subset; correlated video regression; not full COCO mAP or banking accuracy',
        batch=[7-args.general_batch,args.general_batch,1],ema=True,classification_gain=args.classification_gain,pose_gain=args.pose_gain,affine=args.affine)
    args.output.with_suffix('.data.json').write_text(json.dumps(provenance,indent=2),encoding='utf-8')
    best=-1;started=time.monotonic()
    with args.output.with_suffix('.training.jsonl').open('w',encoding='utf-8')as log:
        for step in range(1,args.steps+1):
            pieces=[];batch_idx=[];boxes=[];points=[];offset=0
            for pool,images,records,count in zip(range(3),pools,labels,(7-args.general_batch,args.general_batch,1)):
                chosen=torch.randint(len(images),(count,))
                if pool==0 and phoneids:chosen[0]=random.choice(phoneids)
                pieces.append(images[chosen])
                for index in chosen:
                    box,key=records[index];batch_idx.append(torch.full((len(box),),offset));boxes.append(box.clone());points.append(key.clone());offset+=1
            image=torch.cat(pieces);box=torch.cat(boxes);key=torch.cat(points)
            if random.random()<.5:image=image.flip(-1);box[:,0]=1-box[:,0];key[:,:,0]=1-key[:,:,0];key=key[:,FLIP]
            indices=torch.cat(batch_idx)
            if args.affine:
                zoom=random.uniform(.85,1.15);tx=random.uniform(-.08,.08);ty=random.uniform(-.08,.08)
                theta=image.new_tensor([[1/zoom,0,tx],[0,1/zoom,ty]])[None].repeat(len(image),1,1)
                grid=F.affine_grid(theta,image.shape,align_corners=False)
                image=(F.grid_sample(image-114/255,grid,align_corners=False)+114/255).clamp(0,1)
                box[:,:2]=(box[:,:2]-.5-box.new_tensor([tx,ty])/2)*zoom+.5;box[:,2:]*=zoom
                left=(box[:,:2]-box[:,2:]/2).clamp(0,1);right=(box[:,:2]+box[:,2:]/2).clamp(0,1)
                box=torch.cat(((left+right)/2,right-left),1)
                key[:,:,:2]=(key[:,:,:2]-.5-key.new_tensor([tx,ty])/2)*zoom+.5
                outside=((key[:,:,:2]<0)|(key[:,:,:2]>1)).any(2);key[:,:,2][outside]=0;key[:,:,:2].clamp_(0,1)
                keep=(box[:,2:]>.01).all(1);box=box[keep];key=key[keep];indices=indices[keep]
            image=(image*random.uniform(.8,1.2)+random.uniform(-.02,.02)).clamp(0,1)
            batch=dict(img=image,batch_idx=indices,cls=torch.zeros(len(box),1),bboxes=box,keypoints=key)
            student.train();value,parts=student.loss(batch);value=value.sum()/len(image)
            if not torch.isfinite(value):raise RuntimeError('Nonfinite supervised pose loss')
            optimizer.zero_grad(set_to_none=True);value.backward();torch.nn.utils.clip_grad_norm_(student.parameters(),10);optimizer.step();ema.update(student)
            for group in optimizer.param_groups:group['lr']=.00003+.00027*(1+math.cos(math.pi*step/args.steps))/2
            if step%50:continue
            row=dict(step=step,loss=value.item(),parts=parts.tolist(),elapsed_seconds=round(time.monotonic()-started,2))
            if step%500==0 or step==args.steps:
                row.update(evaluate(ema.ema,[held,general['held'],negatives],[held_refs,general_refs,[[]]*len(negatives)],args.size))
                score=row['domain']['count_agreement']+row['domain']['phone_recall']+row['general']['precision']+row['general']['recall']-min(1,row['negative']['fp']/5)
                checkpoint(ema.ema,args.output.with_name(args.output.stem+'-latest.pt'),row)
                if score>best:best=score;checkpoint(ema.ema,args.output,row)
            log.write(json.dumps(row)+'\n');log.flush();print(json.dumps(row),flush=True)
if __name__=='__main__':main()
