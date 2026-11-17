"""Structured channel pruning experiment for the local ESP32-S3 pose model.

Requires torch-pruning 1.6.1. Removing channels changes actual tensor sizes;
this does not claim that zero weights make dense MCU kernels faster.
Candidate checkpoints require retraining and hardware/quality validation.
"""
from __future__ import annotations
import argparse
import copy
import json
from pathlib import Path
import torch
from torch import nn
from ultralytics import YOLO
from ultralytics.nn.modules import C2f, C2PSA


class C2fSplit(nn.Module):
    """Equivalent two-branch form without an implicit fixed-channel chunk."""
    def __init__(self, original):
        super().__init__()
        self.cv0 = self.branch(original.cv1, 0, original.c)
        self.cv1 = self.branch(original.cv1, original.c, original.c * 2)
        self.cv2, self.m = original.cv2, original.m
        for key in ('i', 'f', 'type', 'np'):
            if hasattr(original, key): setattr(self, key, getattr(original, key))

    @staticmethod
    def branch(conv, first, last):
        branch = copy.deepcopy(conv)
        branch.conv.out_channels = last - first
        branch.conv.weight = nn.Parameter(conv.conv.weight[first:last].clone())
        if conv.conv.bias is not None:
            branch.conv.bias = nn.Parameter(conv.conv.bias[first:last].clone())
        branch.bn.num_features = last - first
        branch.bn.weight = nn.Parameter(conv.bn.weight[first:last].clone())
        branch.bn.bias = nn.Parameter(conv.bn.bias[first:last].clone())
        branch.bn.running_mean = conv.bn.running_mean[first:last].clone()
        branch.bn.running_var = conv.bn.running_var[first:last].clone()
        return branch

    def forward(self, x):
        y = [self.cv0(x), self.cv1(x)]
        y.extend(module(y[-1]) for module in self.m)
        return self.cv2(torch.cat(y, 1))


def raw_pose_forward(self, inputs):
    out = []
    for i in range(3): out.extend((self.cv2[i](inputs[i]), self.cv3[i](inputs[i])))
    return tuple(out + [self.cv4[i](inputs[i]) for i in range(3)])


def replace_chunks(model):
    for name, child in list(model.named_children()):
        if isinstance(child, C2f):
            setattr(model, name, C2fSplit(child))
        else:
            replace_chunks(child)


def widen_pose_head(model, minimum=32):
    """Add trainable head capacity while preserving the current FP32 function."""
    def grow(module, in_channels, out_channels):
        old=module.conv
        if old.groups!=1: raise ValueError('Expected a dense pose-head convolution')
        new=nn.Conv2d(in_channels,out_channels,old.kernel_size,old.stride,old.padding,
                      old.dilation,bias=old.bias is not None,padding_mode=old.padding_mode)
        with torch.no_grad():
            new.weight[:old.out_channels].zero_()
            new.weight[:old.out_channels,:old.in_channels].copy_(old.weight)
            if old.bias is not None:new.bias[:old.out_channels].copy_(old.bias)
        previous=module.bn
        bn=nn.BatchNorm2d(out_channels,eps=previous.eps,momentum=previous.momentum)
        with torch.no_grad():
            n=previous.num_features
            for key in ('weight','bias','running_mean','running_var'):
                getattr(bn,key)[:n].copy_(getattr(previous,key))
            bn.num_batches_tracked.copy_(previous.num_batches_tracked)
        bn.train(previous.training)
        module.conv=new;module.bn=bn
    for branch in model.model[-1].cv4:
        width=max(minimum,branch[0].conv.out_channels,branch[1].conv.out_channels)
        sample=torch.randn(1,branch[0].conv.in_channels,8,8)
        with torch.no_grad(): expected=branch(sample).clone()
        grow(branch[0],branch[0].conv.in_channels,width)
        grow(branch[1],width,width)
        previous=branch[-1]
        output=nn.Conv2d(width,previous.out_channels,1,bias=previous.bias is not None)
        with torch.no_grad():
            output.weight.zero_();output.weight[:,:previous.in_channels].copy_(previous.weight)
            if previous.bias is not None:output.bias.copy_(previous.bias)
        branch[-1]=output
        with torch.no_grad():
            if not torch.allclose(expected,branch(sample),atol=1e-4,rtol=1e-4):
                raise RuntimeError('Pose-head expansion changed the initial function')


def prune(weights, ratio, size, relu=False, round_to=8, pose_head32=False):
    import torch_pruning as tp
    model = YOLO(str(weights)).model.eval()
    replace_chunks(model)
    for parameter in model.parameters(): parameter.requires_grad_(True)
    head = model.model[-1]
    head.forward = raw_pose_forward.__get__(head)
    ignored = [branch[-1] for branches in (head.cv2, head.cv3, head.cv4) for branch in branches] + [head.dfl]
    for module in model.modules():
        if isinstance(module, C2PSA): ignored.extend(list(module.modules()))
    example = torch.zeros(1, 3, size, size)
    before = tp.utils.count_ops_and_params(model, example)
    if ratio:
        pruner = tp.pruner.MagnitudePruner(model, example,
            importance=tp.importance.GroupMagnitudeImportance(p=2),
            pruning_ratio=ratio, ignored_layers=ignored, round_to=round_to)
        pruner.step()
    if relu:
        for module in model.modules():
            for name, child in list(module.named_children()):
                if isinstance(child, nn.SiLU): setattr(module, name, nn.ReLU(inplace=True))
    if pose_head32:widen_pose_head(model)
    with torch.no_grad(): model(example)
    after = tp.utils.count_ops_and_params(model, example)
    del head.forward
    return model, {'before_macs_parameters': before, 'after_macs_parameters': after, 'ratio': ratio, 'size': size, 'relu': relu, 'round_to': round_to,'pose_head32':pose_head32}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--ratio', type=float, default=.5)
    parser.add_argument('--size', type=int, default=192)
    parser.add_argument('--relu', action='store_true')
    parser.add_argument('--round-to', type=int,choices=(8,16),default=8)
    parser.add_argument('--pose-head32',action='store_true',help='Give the pose head at least 32 aligned hidden channels')
    args = parser.parse_args()
    if not 0 <= args.ratio < .9: parser.error('ratio must be between 0 and .9')
    torch.set_num_threads(4)
    model, report = prune(args.weights, args.ratio, args.size, args.relu,args.round_to,args.pose_head32)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save({'model': model, 'train_args': {'task': 'pose'}, 'epoch': -1}, args.output)
    args.output.with_suffix('.pruning.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    # Keep a stable module path in the checkpoint, including when run as a CLI.
    from compact_pose import main
    main()
