"""Re-estimate compact-model BN statistics on unaugmented training frames.

No model weights are trained here. The validation frames remain excluded from
BN accumulation; they still come from the same local videos, not an independent
population accuracy benchmark.
"""
import argparse
import json
from pathlib import Path
import torch
from ultralytics import YOLO
from compact_pose import raw_pose_forward, C2fSplit
from distill_pose import tensors, save
from quantize_pose import decode, phone


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights',type=Path,required=True)
    parser.add_argument('--teacher',type=Path,required=True)
    parser.add_argument('--videos',type=Path,nargs='+',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--size',type=int,required=True)
    parser.add_argument('--teacher-size',type=int,default=192)
    args=parser.parse_args();torch.set_num_threads(4);torch.manual_seed(42)
    train,held,ids=tensors(args.videos,args.size,'interleaved')
    _,reference_images,_=tensors(args.videos,args.teacher_size,'interleaved')
    model=YOLO(str(args.weights)).model.float().eval()
    teacher=YOLO(str(args.teacher)).model.float().eval()
    for current in (model,teacher):
        head=current.model[-1];head.forward=raw_pose_forward.__get__(head)
    with torch.inference_mode():
        references=[decode([v.numpy()for v in teacher(image[None])])for image in reference_images]
    def evaluate():
        agreement=recall=positives=count=0
        with torch.inference_mode():
            for image,reference in zip(held,references):
                actual=decode([v.numpy()for v in model(image[None])])
                agreement+=len(actual)==len(reference)
                positives+=any(map(phone,reference))
                recall+=bool(any(map(phone,reference))and any(map(phone,actual)))
                count+=len(actual)
        return {'people_count_agreement':agreement/len(held),'person_detections':count,
                'teacher_phone_frames':positives,'phone_recall':recall/max(1,positives)}
    before=evaluate()
    bns=[module for module in model.modules()if isinstance(module,torch.nn.BatchNorm2d)]
    momenta=[module.momentum for module in bns]
    for module in bns:
        module.reset_running_stats();module.momentum=None;module.train()
    with torch.no_grad():
        for _ in range(2):
            shuffled=train[torch.randperm(len(train))]
            for offset in range(0,len(shuffled),16):model(shuffled[offset:offset+16])
    for module,momentum in zip(bns,momenta):module.momentum=momentum
    model.eval();after=evaluate()
    report={'step':0,'kind':'bn_recalibration_only','training_frames':len(train),'held_out_frames':len(held),
            'logical_input':args.size,'teacher_input':args.teacher_size,'before':before,'after':after,
            'validation_scope':'Correlated frames from the same two local videos, no human-labelled accuracy claim'}
    save(model,args.output,report)
    args.output.with_suffix('.bn.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report),flush=True)


if __name__=='__main__':main()
