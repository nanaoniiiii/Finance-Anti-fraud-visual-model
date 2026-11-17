"""Export this project's YOLO11n-Pose weights and compare S3 PTQ candidates.

Calibration/evaluation images remain local. Metrics compare quantized output
against FP32 on held-out video frames, not against human-labelled COCO truth.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import DataLoader
from torch.nn import functional as F


OUTPUTS = ['box0', 'score0', 'box1', 'score1', 'box2', 'score2', 'kpt0', 'kpt1', 'kpt2']


def letterbox(image, size):
    height, width = image.shape[:2]
    scale = min(size / width, size / height)
    nw, nh = round(width * scale), round(height * scale)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    x, y = (size - nw) // 2, (size - nh) // 2
    canvas[y:y + nh, x:x + nw] = cv2.resize(image, (nw, nh))
    return torch.from_numpy(canvas[:, :, ::-1].copy()).permute(2, 0, 1).float() / 255


def extract_frames(videos, count=96):
    frames = []
    for video in videos:
        cap = cv2.VideoCapture(str(video))
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
        if not cap.isOpened():
            raise RuntimeError('Cannot open ' + str(video))
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        for index in np.linspace(0, max(0, total - 1), count, dtype=int):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(index))
            ok, image = cap.read()
            if ok:
                frames.append((str(video.name), int(index), image))
        cap.release()
    if len(frames) < 64:
        raise RuntimeError('At least 64 decoded calibration/evaluation frames required')
    return frames


def pack_rgb(tensor):
    unbatched = tensor.ndim == 3
    if unbatched: tensor = tensor.unsqueeze(0)
    batch, _, height, width = tensor.shape
    if height % 2 or width % 2: raise ValueError('RGB packing requires even dimensions')
    patches = F.unfold(tensor, kernel_size=3, padding=1, stride=2)
    patches = patches.view(batch,3,9,-1).permute(0,2,1,3).reshape(batch,27,height//2,width//2)
    result = F.pad(patches,(0,0,0,0,0,5))
    return result[0] if unbatched else result


def export_raw(weights, destination, size, packed=False):
    """Keep trained convolutions; decode DFL/keypoints in MCU postprocessing.

    The nine-output layout follows Espressif's YOLO11n-Pose deployment guide.
    No replacement/fabricated detections or additional training is performed.
    """
    from ultralytics import YOLO
    from ultralytics.nn.modules import Pose, Attention

    model = YOLO(str(weights)).model.eval().fuse()

    def pose_forward(self, inputs):
        out = []
        for i in range(3):
            out.extend((self.cv2[i](inputs[i]), self.cv3[i](inputs[i])))
        return tuple(out + [self.cv4[i](inputs[i]) for i in range(3)])

    def attention_forward(self, x):
        batch, channels, height, width = x.shape
        tokens = height * width
        q, k, v = self.qkv(x).view(batch, self.num_heads, self.key_dim * 2 + self.head_dim, tokens).split([self.key_dim, self.key_dim, self.head_dim], dim=2)
        attention = ((q.transpose(-2, -1) @ k) * self.scale).softmax(dim=-1)
        values = (v @ attention.transpose(-2, -1)).reshape(batch, channels, height, width)
        return self.proj(values + self.pe(v.reshape(batch, channels, height, width)))

    for module in model.modules():
        if isinstance(module, Pose):
            module.forward = pose_forward.__get__(module)
        elif isinstance(module, Attention):
            module.forward = attention_forward.__get__(module)
    shape = (1,3,size,size)
    if packed:
        original = model.model[0].conv
        if original.in_channels!=3 or original.kernel_size!=(3,3) or original.stride!=(2,2) or original.padding!=(1,1):
            raise RuntimeError('Expected the original first RGB 3x3 stride-2 convolution')
        aligned = torch.nn.Conv2d(32,original.out_channels,1,bias=original.bias is not None)
        with torch.no_grad():
            aligned.weight.zero_()
            aligned.weight[:,:27,0,0].copy_(original.weight.permute(0,2,3,1).reshape(original.out_channels,27))
            if original.bias is not None: aligned.bias.copy_(original.bias)
            sample=torch.rand(1,3,size,size)
            if not torch.allclose(original(sample),aligned(pack_rgb(sample)),atol=1e-4,rtol=1e-4):
                raise RuntimeError('RGB packing changed first-convolution FP32 outputs')
        model.model[0].conv = aligned
        shape = (1,32,size//2,size//2)
    with torch.no_grad():
        torch.onnx.export(model, torch.zeros(*shape), str(destination), input_names=['images'], output_names=OUTPUTS, opset_version=13, dynamo=False)
    import onnx
    from onnxsim import simplify
    simple, valid = simplify(onnx.load(destination))
    if not valid:
        raise RuntimeError('ONNX simplification failed verification')
    onnx.save(onnx.shape_inference.infer_shapes(simple), destination)


def decode(outputs, threshold=.3):
    """Decode raw NCHW outputs in network-image coordinates for comparison."""
    boxes, scores, points = [], [], []
    for stage, stride in enumerate((8, 16, 32)):
        box, score, kpt = (np.asarray(outputs[index]) for index in (stage * 2, stage * 2 + 1, stage + 6))
        _, _, height, width = box.shape
        confidences = 1 / (1 + np.exp(-np.clip(score[0, 0], -30, 30)))
        for y, x in zip(*np.where(confidences >= threshold)):
            logits = box[0, :, y, x].reshape(4, 16)
            probabilities = np.exp(logits - logits.max(axis=1, keepdims=True))
            distances = (probabilities / probabilities.sum(axis=1, keepdims=True) * np.arange(16)).sum(axis=1) * stride
            center = np.array([(x + .5) * stride, (y + .5) * stride])
            xyxy = np.r_[center - distances[:2], center + distances[2:]]
            raw = kpt[0, :, y, x].reshape(17, 3)
            pose = np.c_[(raw[:, :2] * 2 + [x, y]) * stride, 1 / (1 + np.exp(-np.clip(raw[:, 2], -30, 30)))]
            boxes.append(xyxy); scores.append(float(confidences[y, x])); points.append(pose)
    if not boxes:
        return []
    selected = cv2.dnn.NMSBoxes([[b[0], b[1], b[2] - b[0], b[3] - b[1]] for b in boxes], scores, threshold, .65)
    return [{'bbox': boxes[int(i)], 'score': scores[int(i)], 'keypoints': points[int(i)]} for i in np.asarray(selected).flatten()]


def iou(a, b):
    overlap = np.maximum(np.minimum(a[2:], b[2:]) - np.maximum(a[:2], b[:2]), 0).prod()
    return float(overlap / max(1, (a[2:] - a[:2]).prod() + (b[2:] - b[:2]).prod() - overlap))


def phone(person):
    p = person['keypoints']; height = person['bbox'][3] - person['bbox'][1]
    for ear, elbow, wrist in ((3, 7, 9), (4, 8, 10)):
        if min(p[[ear, elbow, wrist], 2]) >= .3 and p[wrist, 1] <= p[elbow, 1] + height * .06 and np.linalg.norm(p[wrist, :2] - p[ear, :2]) <= height * .28:
            return True
    return False


def evaluate(graph, model_path, frames, size, packed=False):
    import onnxruntime as ort
    from esp_ppq.executor import TorchExecutor
    session = ort.InferenceSession(str(model_path), providers=['CPUExecutionProvider'])
    executor = TorchExecutor(graph=graph, device='cpu')
    agreement, matched, misses, extras, errors, phone_agree = 0, 0, 0, 0, [], 0
    rows = []
    for name, index, image in frames:
        tensor = letterbox(image, size).unsqueeze(0)
        if packed: tensor = pack_rgb(tensor)
        reference = decode(session.run(OUTPUTS, {'images': tensor.numpy()}))
        with torch.no_grad():
            actual_values = executor.forward(tensor, output_names=OUTPUTS)
        actual = decode([value.detach().cpu().numpy() for value in actual_values])
        agreement += len(reference) == len(actual)
        phone_agree += any(map(phone, reference)) == any(map(phone, actual))
        remaining = list(range(len(actual)))
        for person in reference:
            if not remaining:
                misses += 1; continue
            best = max(remaining, key=lambda i: iou(person['bbox'], actual[i]['bbox']))
            if iou(person['bbox'], actual[best]['bbox']) < .5:
                misses += 1; continue
            remaining.remove(best); matched += 1
            p, q = person['keypoints'], actual[best]['keypoints']
            visible = (p[:, 2] >= .3) & (q[:, 2] >= .3)
            if visible.any():
                errors.extend((np.linalg.norm(p[visible, :2] - q[visible, :2], axis=1) / size).tolist())
        extras += len(remaining)
        rows.append({'video': name, 'frame': index, 'fp32_people': len(reference), 'int8_people': len(actual), 'fp32_phone_pose': any(map(phone, reference)), 'int8_phone_pose': any(map(phone, actual))})
    return {'held_out_frames': len(frames), 'fp32_person_detections': sum(row['fp32_people'] for row in rows), 'fp32_phone_positive_frames': sum(row['fp32_phone_pose'] for row in rows), 'fp32_multi_person_frames': sum(row['fp32_people'] >= 2 for row in rows), 'people_count_agreement': agreement / len(frames), 'phone_pose_agreement': phone_agree / len(frames), 'matched_iou50': matched, 'missed_vs_fp32': misses, 'extra_vs_fp32': extras, 'keypoint_mean_distance_over_input': float(np.mean(errors)) if errors else None, 'frames': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights', type=Path, required=True)
    parser.add_argument('--videos', type=Path, nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--size', type=int, choices=(96, 128, 160, 192, 224, 256, 320), default=320)
    parser.add_argument('--algorithm', choices=('minmax', 'percentile', 'kl'), default='percentile')
    parser.add_argument('--name-prefix', default='pose-s3')
    parser.add_argument('--pack-rgb', action='store_true',help='Exactly reparameterize the first convolution as aligned RGB patch32 input')
    parser.add_argument('--overwrite',action='store_true',help='Explicitly replace previously generated model outputs')
    parser.add_argument('--bias-correction',action='store_true',help='Correct layer bias using the complete calibration set')
    parser.add_argument('--lsq-steps',type=int,default=0,help='CPU blockwise learned quantization fine-tuning steps (0 disables)')
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    if not re.fullmatch(r'[A-Za-z0-9_-]+', args.name_prefix): parser.error('Invalid model name prefix')
    torch.set_num_threads(4)
    frames = extract_frames(args.videos)
    calibration_pool = [row for i, row in enumerate(frames) if i % 4 != 0]
    evaluation_pool = [row for i, row in enumerate(frames) if i % 4 == 0]
    calibration = [calibration_pool[i] for i in np.linspace(0, len(calibration_pool) - 1, 96, dtype=int)]
    held_out = [evaluation_pool[i] for i in np.linspace(0, len(evaluation_pool) - 1, 24, dtype=int)]
    name = f'{args.name_prefix}-{args.size}-{args.algorithm}'
    destination = args.output / (name + '.espdl')
    if destination.exists() and not args.overwrite:
        parser.error('Model output exists; use a fresh directory or explicitly --overwrite')
    onnx_path = args.output / f'pose-raw-{args.size}{"-rgbpack" if args.pack_rgb else ""}.onnx'
    # A previous export may come from a different training checkpoint.
    export_raw(args.weights, onnx_path, args.size, args.pack_rgb)
    from esp_ppq import QuantizationSettingFactory
    from esp_ppq.api import espdl_quantize_onnx
    setting = QuantizationSettingFactory.espdl_setting()
    setting.quantize_activation_setting.calib_algorithm = args.algorithm
    if args.bias_correction:
        setting.bias_correct=True
        setting.bias_correct_setting.steps=len(calibration)
        setting.bias_correct_setting.collecting_device='cpu'
    if args.lsq_steps:
        if not 1<=args.lsq_steps<=2000:parser.error('LSQ steps must be between 1 and 2000')
        setting.lsq_optimization=True
        setting.lsq_optimization_setting.steps=args.lsq_steps
        setting.lsq_optimization_setting.collecting_device='cpu'
    inputs = [letterbox(row[2], args.size) for row in calibration]
    if args.pack_rgb: inputs = [pack_rgb(tensor) for tensor in inputs]
    loader = DataLoader(inputs, batch_size=1, shuffle=False)
    started = time.monotonic()
    input_shape = [1,32,args.size//2,args.size//2] if args.pack_rgb else [1,3,args.size,args.size]
    from esp_ppq.log import NaiveLogger
    logger=NaiveLogger.get_logger('ESPDL')
    error_path=args.output/(name+'.conversion-errors.log')
    logger.register_handler(str(error_path),level='error')
    try:
        graph = espdl_quantize_onnx(onnx_import_file=str(onnx_path), espdl_export_file=str(destination), calib_dataloader=loader, calib_steps=len(inputs), input_shape=input_shape, target='esp32s3', quant_type='w8a8', setting=setting, collate_fn=lambda batch: batch, device='cpu', error_report=False, export_test_values=False, verbose=0)
    finally:
        logger.remove_handler(str(error_path))
    conversion_errors=error_path.read_text(encoding='utf-8').strip()
    if conversion_errors:
        if destination.exists(): destination.replace(destination.with_suffix('.espdl.invalid'))
        (args.output/(name+'.json')).write_text(json.dumps({'name':name,'deployment_valid':False,'errors':conversion_errors},indent=2),encoding='utf-8')
        raise RuntimeError('ESP-DL rejected deployment arithmetic; model quarantined as .espdl.invalid')
    metrics = evaluate(graph, onnx_path, held_out, args.size, args.pack_rgb)
    report = {'name': name, 'size': args.size, 'algorithm': args.algorithm, 'target': 'esp32s3', 'precision': 'w8a8', 'weights_sha256': hashlib.sha256(args.weights.read_bytes()).hexdigest(), 'model_sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'model_bytes': destination.stat().st_size, 'calibration_frames': len(calibration), 'elapsed_seconds': round(time.monotonic() - started, 2), 'metric_scope': 'Agreement with FP32 on held-out frames from two local videos, not labelled task accuracy', **metrics}
    report.update(input_layout='rgb_patch32' if args.pack_rgb else 'rgb',input_shape=input_shape,deployment_valid=True,calibration_steps=len(inputs),bias_correction=args.bias_correction,lsq_steps=args.lsq_steps)
    (args.output / (name + '.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'frames'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
