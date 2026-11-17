"""Restore a compact model using local video frames and the original pose model.

This is teacher distillation, not human-labelled accuracy validation. Source
videos and cached images remain local. Hold-out frame IDs are recorded so the
nearby-frame/domain limitations can be reported with hardware benchmarks.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import math
import random
import time
from pathlib import Path
import cv2
import numpy as np
import torch
from torch.nn import functional as F
from ultralytics import YOLO
from compact_pose import raw_pose_forward, C2fSplit
from quantize_pose import letterbox, decode, phone


def tensors(videos, size, split='temporal'):
    train, held = [], []
    ids = {'train': [], 'held_out': []}
    for video in videos:
        capture = cv2.VideoCapture(str(video))
        capture.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
        if not capture.isOpened(): raise RuntimeError('Video failed to open')
        index = 0
        while True:
            ok, image = capture.read()
            if not ok: break
            current = index; index += 1
            # Separate temporal blocks, with a one-second exclusion margin.
            # Opening/phone regression frames are held out as complete blocks.
            validation = current < 30 or 390 <= current < 480 or current % 300 >= 270
            margin = 30 <= current < 60 or 384 <= current < 390 or 480 <= current < 498 or 252 <= current % 300 < 270
            if current % 6: continue
            if split == 'interleaved':
                validation = current % 12 == 0
                margin = False
            if margin: continue
            part = 'held_out' if validation else 'train'
            (held if validation else train).append(letterbox(image, size))
            ids[part].append({'video': video.name, 'frame': current})
        capture.release()
    if len(train) < 32 or len(held) < 16: raise RuntimeError('Not enough separated video frames')
    return torch.stack(train), torch.stack(held), ids


def loss(outputs, targets):
    result = outputs[0].new_zeros(())
    for stage in range(3):
        box, score, key = outputs[2 * stage], outputs[2 * stage + 1], outputs[stage + 6]
        tbox, tscore, tkey = targets[2 * stage], targets[2 * stage + 1], targets[stage + 6]
        probability = tscore.sigmoid()
        weight = probability.detach() + .002
        classification = F.binary_cross_entropy_with_logits(score, probability, reduction='none')
        result = result + (classification * (.1 + probability * 10)).mean()
        b, _, h, w = box.shape
        distribution = F.kl_div(F.log_softmax(box.view(b, 4, 16, h, w), 2),
                                F.softmax(tbox.view(b, 4, 16, h, w), 2), reduction='none').sum(2)
        result = result + (distribution * weight).sum() / (weight.sum() * 4)
        pose, truth = key.view(b, 17, 3, h, w), tkey.view(b, 17, 3, h, w)
        visible = truth[:, :, 2].sigmoid().detach() * weight
        coordinate = F.smooth_l1_loss(pose[:, :, :2], truth[:, :, :2], reduction='none').sum(2)
        result = result + (coordinate * visible).sum() / (visible.sum() * 2).clamp_min(1e-6)
        visibility = F.binary_cross_entropy_with_logits(pose[:, :, 2], truth[:, :, 2].sigmoid(), reduction='none')
        result = result + (visibility * weight).sum() / (weight.sum() * 17)
    return result


def resize_teacher(outputs, scale):
    """Transfer higher-resolution teacher geometry to a smaller student grid.

    Choose the strongest teacher anchor covering each student cell, then move
    its physical box/keypoints to the student's coordinates. Raw offsets alone
    cannot be resized because they are relative to a different cell centre.
    """
    if scale == 1: return outputs
    boxes, keys, scores = [], [], []
    for stage in range(3):
        box, score, key = outputs[stage*2], outputs[stage*2+1], outputs[stage+6]
        batch, _, height, width = score.shape
        nh, nw = round(height*scale), round(width*scale)
        gy,gx = torch.meshgrid(torch.arange(nh,device=score.device),torch.arange(nw,device=score.device),indexing='ij')
        _,selected=F.adaptive_max_pool2d(score,(nh,nw),return_indices=True)
        selected=selected.flatten(1)
        def gather(value):
            return value.flatten(2).gather(2,selected[:,None].expand(-1,value.shape[1],-1))
        oldx=(selected%width).float(); oldy=(selected//width).float()
        nx=gx.flatten()[None]; ny=gy.flatten()[None]
        delta_x=(nx+.5)-(oldx+.5)*scale; delta_y=(ny+.5)-(oldy+.5)*scale
        probability=gather(box).reshape(batch,4,16,-1).softmax(2)
        distances=(probability*torch.arange(16,device=box.device)[None,None,:,None]).sum(2)*scale
        offsets=torch.stack((delta_x,delta_y,-delta_x,-delta_y),1)
        distances=(distances+offsets).clamp(0,15)
        low=distances.floor().long(); high=(low+1).clamp_max(15)
        fraction=distances-low
        distribution=box.new_zeros(batch,4,16,nh*nw)
        distribution.scatter_add_(2,low[:,:,None],(1-fraction)[:,:,None])
        distribution.scatter_add_(2,high[:,:,None],fraction[:,:,None])
        boxes.append(distribution.clamp_min(1e-8).log().reshape(batch,64,nh,nw))
        pose=gather(key).reshape(batch,17,3,-1).clone()
        pose[:,:,0]=((pose[:,:,0]*2+oldx[:,None])*scale-nx[:,None])/2
        pose[:,:,1]=((pose[:,:,1]*2+oldy[:,None])*scale-ny[:,None])/2
        keys.append(pose.reshape(batch,51,nh,nw))
        scores.append(gather(score).reshape(batch,1,nh,nw))
    return tuple(item for pair in zip(boxes,scores) for item in pair)+tuple(keys)


def save(model, destination, report):
    saved = copy.deepcopy(model).eval().cpu()
    del saved.model[-1].forward
    torch.save({'model': saved, 'train_args': {'task': 'pose'}, 'epoch': report['step'],
                'poseguard_distillation': report}, destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--teacher', type=Path, required=True)
    parser.add_argument('--student', type=Path, required=True)
    parser.add_argument('--videos', type=Path, nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--size', type=int, default=192)
    parser.add_argument('--teacher-size', type=int,help='Use a larger teacher input and transfer its box/keypoint coordinates')
    parser.add_argument('--steps', type=int, default=2000)
    parser.add_argument('--batch', type=int, default=8)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--balanced-phone', action='store_true', help='Balance teacher-positive phone poses within the training split only')
    parser.add_argument('--split', choices=('temporal','interleaved'), default='temporal', help='Interleaved frames are correlated domain tuning, not independent validation')
    parser.add_argument('--affine', action='store_true', help='Apply small scale/translation augmentation before obtaining teacher targets')
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    torch.manual_seed(42); np.random.seed(42); random.seed(42)
    teacher_size=args.teacher_size or args.size
    if args.size%32 or teacher_size%32 or args.size>teacher_size: parser.error('Input sizes must be multiples of 32; teacher must be at least as large')
    scale=args.size/teacher_size
    train, held, ids = tensors(args.videos, teacher_size, args.split)
    teacher = YOLO(str(args.teacher)).model.eval()
    student = YOLO(str(args.student)).model.float()
    for parameter in teacher.parameters(): parameter.requires_grad_(False)
    for parameter in student.parameters(): parameter.requires_grad_(True)
    for model in (teacher, student):
        head = model.model[-1]; head.forward = raw_pose_forward.__get__(head)
    teacher.eval(); student.train()
    phone_indices = []
    if args.balanced_phone:
        with torch.inference_mode():
            for index, image in enumerate(train):
                if any(map(phone, decode([v.numpy() for v in teacher(image[None])]))):
                    phone_indices.append(index)
        if not phone_indices: raise RuntimeError('Training split has no teacher-positive phone examples')
        print(json.dumps({'training_phone_frames': len(phone_indices), 'training_frames': len(train)}), flush=True)
    optimizer = torch.optim.AdamW(student.parameters(), lr=.0004, weight_decay=.0001)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    scope = {'teacher_sha256': hashlib.sha256(args.teacher.read_bytes()).hexdigest(),
             'student_initial_sha256': hashlib.sha256(args.student.read_bytes()).hexdigest(),
             'size': args.size, 'scope': 'Local-video teacher distillation; no human-labelled task accuracy claim',
             'train_frames': len(train), 'held_out_frames': len(held), 'frame_ids': ids, 'seed': 42, 'device': 'cpu',
             'balanced_phone': args.balanced_phone, 'training_phone_frames': len(phone_indices) if args.balanced_phone else None}
    scope.update(split=args.split, affine=args.affine, validation_limit='Frames from the same two videos are correlated; functional regression only')
    scope.update(teacher_size=teacher_size)
    args.output.with_suffix('.data.json').write_text(json.dumps(scope, indent=2), encoding='utf-8')
    with torch.inference_mode():
        references = []
        for image in held:
            values = teacher(image[None])
            references.append(decode([v.numpy() for v in values]))
    best = -1.; started = time.monotonic()
    with args.output.with_suffix('.training.jsonl').open('w', encoding='utf-8') as log:
        for step in range(1, args.steps + 1):
            chosen = torch.randint(len(train), (args.batch,))
            if phone_indices:
                for i in range(args.batch // 2): chosen[i] = random.choice(phone_indices)
            images = train[chosen].clone()
            if random.random() < .5: images = images.flip(-1)
            if args.affine:
                zoom = random.uniform(.7, 1.15)
                transform = images.new_tensor([[1/zoom,0,random.uniform(-.08,.08)],
                                                [0,1/zoom,random.uniform(-.08,.08)]])[None].repeat(len(images),1,1)
                grid = F.affine_grid(transform, images.shape, align_corners=False)
                images = (F.grid_sample(images-114/255, grid, align_corners=False)+114/255).clamp(0,1)
            images = (images * random.uniform(.85, 1.15) + random.uniform(-.025, .025)).clamp(0, 1)
            with torch.no_grad(): targets = resize_teacher(teacher(images),scale)
            student_images=images if scale==1 else F.interpolate(images,(args.size,args.size),mode='bilinear',align_corners=False)
            outputs = student(student_images); value = loss(outputs, targets)
            if not torch.isfinite(value): raise RuntimeError('Nonfinite distillation loss')
            optimizer.zero_grad(set_to_none=True); value.backward()
            torch.nn.utils.clip_grad_norm_(student.parameters(), 10)
            optimizer.step()
            for group in optimizer.param_groups:
                group['lr'] = .00004 + .00036 * (1 + math.cos(math.pi * step / args.steps)) / 2
            if step % 50: continue
            row = {'step': step, 'loss': value.item(), 'elapsed_seconds': round(time.monotonic()-started, 2)}
            if step % 200 == 0 or step == args.steps:
                student.eval(); agreement = person_recall = reference_count = phone_recall = phone_count = 0
                with torch.inference_mode():
                    for image, reference in zip(held, references):
                        resized=image[None] if scale==1 else F.interpolate(image[None],(args.size,args.size),mode='bilinear',align_corners=False)
                        actual = decode([v.numpy() for v in student(resized)])
                        agreement += len(actual) == len(reference)
                        reference_count += len(reference); person_recall += min(len(actual), len(reference))
                        if any(map(phone, reference)):
                            phone_count += 1; phone_recall += any(map(phone, actual))
                row.update(count_agreement=agreement/len(held), count_recall=person_recall/max(1,reference_count),
                           teacher_phone_frames=phone_count, phone_recall=phone_recall/max(1,phone_count))
                save(student, args.output.with_name(args.output.stem+'-latest.pt'), row)
                quality = row['count_agreement'] + row['phone_recall']
                if quality > best:
                    best = quality; save(student, args.output, row)
                student.train()
            log.write(json.dumps(row)+'\n'); log.flush(); print(json.dumps(row), flush=True)


if __name__ == '__main__': main()
