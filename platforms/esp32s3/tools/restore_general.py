"""Recover general-scene behaviour after compact domain distillation.

Uses separate deterministic COCO train/hold-out images, local-video frames
and synthetic blank negatives. A small subset is functional regression
evidence rather than a full COCO benchmark or a banking accuracy certificate.
"""
import argparse,copy,hashlib,json,math,random,time
from pathlib import Path
import cv2,numpy as np,torch
from torch.nn import functional as F
from ultralytics import YOLO
from compact_pose import C2fSplit,raw_pose_forward
from distill_pose import tensors,resize_teacher,save
from quantize_pose import letterbox,decode,phone,iou

def objective(outputs,targets):
    result=outputs[0].new_zeros(())
    for stage in range(3):
        box,score,key=outputs[2*stage],outputs[2*stage+1],outputs[stage+6]
        tbox,tscore,tkey=targets[2*stage],targets[2*stage+1],targets[stage+6]
        probability=tscore.sigmoid().detach()
        weight=probability.square()
        bce=F.binary_cross_entropy_with_logits(score,probability,reduction='none')
        positive=(bce*weight).sum()/weight.sum().clamp_min(.1)
        # An average over every cell hides high-confidence background errors.
        # Keep the hardest negatives in each image/scale visible to the loss.
        negatives=(bce*(1-probability).square()).flatten(1)
        negative=negatives.topk(min(32,negatives.shape[1]),dim=1).values.mean()
        result+=2*(positive+negative)
        b,_,h,w=box.shape
        distribution=F.kl_div(F.log_softmax(box.view(b,4,16,h,w),2),
            F.softmax(tbox.view(b,4,16,h,w),2),reduction='none').sum(2)
        result+=(distribution*weight).sum()/(weight.sum()*4).clamp_min(.1)
        pose,truth=key.view(b,17,3,h,w),tkey.view(b,17,3,h,w)
        visible=truth[:,:,2].sigmoid().detach()*weight
        coordinate=F.smooth_l1_loss(pose[:,:,:2],truth[:,:,:2],reduction='none').sum(2)
        result+=(coordinate*visible).sum()/(visible.sum()*2).clamp_min(.1)
        visibility=F.binary_cross_entropy_with_logits(pose[:,:,2],truth[:,:,2].sigmoid(),reduction='none')
        result+=(visibility*weight).sum()/(weight.sum()*17).clamp_min(.1)
    return result

def matched(actual,reference):
    used=set();tp=0
    for item in sorted(actual,key=lambda v:v['score'],reverse=True):
        overlaps=[(iou(item['bbox'],r['bbox']),j)for j,r in enumerate(reference)if j not in used]
        if overlaps:
            overlap,j=max(overlaps)
            if overlap>=.5:used.add(j);tp+=1
    return tp,len(actual)-tp,len(reference)-tp

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('teacher','student','dataset','output'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--videos',type=Path,nargs='+',required=True)
    p.add_argument('--size',type=int,default=128);p.add_argument('--teacher-size',type=int,default=192)
    p.add_argument('--steps',type=int,default=2000);p.add_argument('--threads',type=int,default=4)
    p.add_argument('--freeze-bn',action='store_true',help='Keep old running statistics; default adapts BN to the mixed training pool')
    p.add_argument('--negative-images',type=Path,nargs='*',default=[],help='Confirmed empty/covered camera frames, kept outside the source repository')
    args=p.parse_args();torch.set_num_threads(args.threads);torch.manual_seed(42);random.seed(42);np.random.seed(42)
    teacher=YOLO(str(args.teacher)).model.eval();student=YOLO(str(args.student)).model.float().eval()
    for model in (teacher,student):
        head=model.model[-1];head.forward=raw_pose_forward.__get__(head)
    for parameter in teacher.parameters():parameter.requires_grad_(False)
    for parameter in student.parameters():parameter.requires_grad_(True)
    domain,domainheld,ids=tensors(args.videos,args.teacher_size,'interleaved')
    general=[];generalheld=[];generalids={'train':[],'held':[]}
    manifest=args.dataset/'split.json'
    explicit=json.loads(manifest.read_text()) if manifest.exists() else None
    for index,path in enumerate(sorted((args.dataset/'images/train2017').glob('*.jpg'))):
        held=path.name in explicit['held'] if explicit else index%5==0;part='held'if held else'train'
        if explicit and path.name not in explicit[part]:raise RuntimeError('Image is missing from the deterministic split')
        (generalheld if held else general).append(letterbox(cv2.imread(str(path)),args.teacher_size));generalids[part].append(path.name)
    negatives=[]
    for level in (0,4,8,16,32,64,96,114,160,200,240,255):
        negatives.append(letterbox(np.full((240,320,3),level,np.uint8),args.teacher_size))
        noise=np.random.normal(level,3,(240,320,3)).clip(0,255).astype(np.uint8)
        negatives.append(letterbox(noise,args.teacher_size))
    for path in args.negative_images:
        image=cv2.imread(str(path))
        if image is None:raise RuntimeError('Invalid confirmed negative image')
        negatives.append(letterbox(image,args.teacher_size))
    for color in ((0,80,0),(0,120,0),(32,32,32),(64,64,64)):
        image=np.full((240,320,3),color,np.float32)
        image=(image+np.random.normal(0,8,image.shape)).clip(0,255).astype(np.uint8)
        negatives.append(letterbox(image,args.teacher_size))
    pools=[domain,torch.stack(general),torch.stack(negatives)]
    def prepare(images):
        target=[[]for _ in range(9)]
        with torch.inference_mode():
            for image in images:
                for pool,value in zip(target,resize_teacher(teacher(image[None]),args.size/args.teacher_size)):pool.append(value)
        targets=tuple(torch.cat(pool)for pool in target)
        resized=F.interpolate(images,(args.size,args.size),mode='bilinear',align_corners=False)
        return resized,targets
    prepared=[prepare(images)for images in pools]
    validation=[prepare(domainheld),prepare(torch.stack(generalheld)),prepare(torch.stack(negatives))]
    refs=[[decode([v[i:i+1].numpy()for v in values])for i in range(len(images))]for images,values in validation]
    phoneids=[i for i in range(len(domain))if any(map(phone,decode([v[i:i+1].numpy()for v in prepared[0][1]])))]
    args.output.parent.mkdir(parents=True,exist_ok=True)
    scope=dict(teacher_sha256=hashlib.sha256(args.teacher.read_bytes()).hexdigest(),student_initial_sha256=hashlib.sha256(args.student.read_bytes()).hexdigest(),
        size=args.size,teacher_size=args.teacher_size,seed=42,video_frame_ids=ids,general_image_ids=generalids,
        scope='Small COCO subset and correlated video regression; not full COCO mAP or banking accuracy',
        dataset=args.dataset.name,dataset_split_sha256=hashlib.sha256(manifest.read_bytes()).hexdigest() if manifest.exists() else None,
        synthetic_negative_frames=len(negatives),loss='foreground-weighted KD and hard background negatives',batch=[3,4,1],freeze_bn=args.freeze_bn)
    args.output.with_suffix('.data.json').write_text(json.dumps(scope,indent=2),encoding='utf-8')
    optimizer=torch.optim.AdamW(student.parameters(),lr=.00015,weight_decay=.0001)
    best=-1;started=time.monotonic()
    with args.output.with_suffix('.training.jsonl').open('w',encoding='utf-8')as log:
        for step in range(1,args.steps+1):
            pieces=[];target=[[]for _ in range(9)]
            for pool,(images,values),count in zip(range(3),prepared,(3,4,1)):
                chosen=torch.randint(len(images),(count,))
                if pool==0 and phoneids:chosen[0]=random.choice(phoneids)
                pieces.append(images[chosen])
                for output,value in zip(target,values):output.append(value[chosen])
            images=torch.cat(pieces);targets=tuple(torch.cat(pool)for pool in target)
            student.eval() if args.freeze_bn else student.train()
            images=(images*random.uniform(.9,1.1)+random.uniform(-.015,.015)).clamp(0,1)
            loss=objective(student(images),targets)
            if not torch.isfinite(loss):raise RuntimeError('Nonfinite repair loss')
            optimizer.zero_grad(set_to_none=True);loss.backward();torch.nn.utils.clip_grad_norm_(student.parameters(),10);optimizer.step()
            for group in optimizer.param_groups:group['lr']=.000015+.000135*(1+math.cos(math.pi*step/args.steps))/2
            if step%50:continue
            row=dict(step=step,loss=loss.item(),elapsed_seconds=round(time.monotonic()-started,2))
            if step%200==0 or step==args.steps:
                student.eval()
                with torch.inference_mode():
                    for name,(images,_),references in zip(('domain','general','negative'),validation,refs):
                        tp=fp=fn=agreement=phones=phonecount=0
                        for image,reference in zip(images,references):
                            actual=decode([v.numpy()for v in student(image[None])]);a,b,c=matched(actual,reference);tp+=a;fp+=b;fn+=c
                            agreement+=len(actual)==len(reference)
                            if any(map(phone,reference)):phonecount+=1;phones+=any(map(phone,actual))
                        row[name]=dict(precision=tp/max(1,tp+fp),recall=tp/max(1,tp+fn),false_positives=fp,
                            count_agreement=agreement/len(images),phone_recall=phones/max(1,phonecount),phone_frames=phonecount)
                score=row['domain']['count_agreement']+row['domain']['phone_recall']+row['general']['precision']+row['general']['recall']-min(1,row['negative']['false_positives']/10)
                save(student,args.output.with_name(args.output.stem+'-latest.pt'),row)
                if score>best:best=score;save(student,args.output,row)
            log.write(json.dumps(row)+'\n');log.flush();print(json.dumps(row),flush=True)
if __name__=='__main__':main()
