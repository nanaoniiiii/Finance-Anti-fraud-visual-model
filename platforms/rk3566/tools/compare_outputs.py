#!/usr/bin/env python3
"""Compare ONNX and RKNN pose outputs on three held-out frames."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from platforms.rk3566.tools.convert_pose_rknn import require_success
from platforms.rk3566.tools.export_pose_onnx import normalize_output_shape
from platforms.rk3566.tools.prepare_inputs import letterbox


def as_rows(output):
    import numpy as np

    tensor = np.asarray(output)
    contract = normalize_output_shape(tensor.shape)
    if contract["layout"] == "BCN":
        tensor = tensor.transpose(0, 2, 1)
    return tensor[0].astype(np.float32, copy=False)


def _as_bcn(output, channels: int):
    import numpy as np

    tensor = np.asarray(output)
    if tensor.ndim != 3 or tensor.shape[0] != 1:
        raise ValueError(f"expected rank-3 batch-1 output, got {tensor.shape}")
    if tensor.shape[1] == channels:
        return tensor.astype(np.float32, copy=False)
    if tensor.shape[2] == channels:
        return tensor.transpose(0, 2, 1).astype(np.float32, copy=False)
    raise ValueError(f"expected {channels} output channels, got {tensor.shape}")


def combine_model_outputs(outputs):
    """Restore the standard [1, 56, anchors] tensor from split RKNN outputs."""
    import numpy as np

    if len(outputs) == 1:
        tensor = np.asarray(outputs[0])
        contract = normalize_output_shape(tensor.shape)
        return tensor if contract["layout"] == "BCN" else tensor.transpose(0, 2, 1)
    if len(outputs) != 4:
        raise ValueError(f"expected one combined or four split outputs, got {len(outputs)}")

    boxes = _as_bcn(outputs[0], 4)
    scores = _as_bcn(outputs[1], 1)
    keypoints = _as_bcn(outputs[2], 51)
    keypoint_scores = _as_bcn(outputs[3], 17)
    anchors = boxes.shape[2]
    if any(item.shape[2] != anchors for item in (scores, keypoints, keypoint_scores)):
        raise ValueError("split pose outputs use different anchor counts")

    combined = np.empty((1, 56, anchors), dtype=np.float32)
    combined[:, :4] = boxes
    combined[:, 4:5] = scores
    combined[:, 5:] = keypoints
    for point in range(17):
        combined[:, 7 + point * 3] = keypoint_scores[:, point]
    return combined


def box_iou(lhs, rhs) -> float:
    left = max(float(lhs[0]), float(rhs[0]))
    top = max(float(lhs[1]), float(rhs[1]))
    right = min(float(lhs[2]), float(rhs[2]))
    bottom = min(float(lhs[3]), float(rhs[3]))
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    lhs_area = max(0.0, float(lhs[2] - lhs[0])) * max(
        0.0, float(lhs[3] - lhs[1])
    )
    rhs_area = max(0.0, float(rhs[2] - rhs[0])) * max(
        0.0, float(rhs[3] - rhs[1])
    )
    union = lhs_area + rhs_area - intersection
    return intersection / union if union > 0.0 else 0.0


def decode(output, score_threshold: float = 0.35, nms_threshold: float = 0.45):
    import numpy as np

    rows = as_rows(output)
    rows = rows[rows[:, 4] >= score_threshold]
    if not len(rows):
        return []
    boxes = np.empty((len(rows), 4), dtype=np.float32)
    boxes[:, 0] = rows[:, 0] - rows[:, 2] * 0.5
    boxes[:, 1] = rows[:, 1] - rows[:, 3] * 0.5
    boxes[:, 2] = rows[:, 0] + rows[:, 2] * 0.5
    boxes[:, 3] = rows[:, 1] + rows[:, 3] * 0.5
    order = np.argsort(rows[:, 4])[::-1]
    kept: list[dict] = []
    for index in order:
        if any(box_iou(boxes[index], item["bbox"]) > nms_threshold for item in kept):
            continue
        kept.append(
            {
                "bbox": boxes[index],
                "score": float(rows[index, 4]),
                "keypoints": rows[index, 5:].reshape(17, 3),
            }
        )
    return kept


def peak_score(output) -> float:
    rows = as_rows(output)
    return float(rows[:, 4].max()) if len(rows) else 0.0


def compare_person(reference: dict, candidate: dict) -> tuple[float, float]:
    import numpy as np

    overlap = box_iou(reference["bbox"], candidate["bbox"])
    valid = (reference["keypoints"][:, 2] >= 0.25) & (
        candidate["keypoints"][:, 2] >= 0.25
    )
    if not valid.any():
        return overlap, float("inf")
    error = np.linalg.norm(
        reference["keypoints"][valid, :2] - candidate["keypoints"][valid, :2],
        axis=1,
    ).mean()
    body_height = max(1.0, float(reference["bbox"][3] - reference["bbox"][1]))
    return overlap, float(error / body_height)


def initialize_quantized_simulator(runner, onnx_path: Path, dataset_path: Path) -> None:
    """Build the INT8 graph in-process because exported RKNN files need hardware."""
    require_success(
        runner.config(
            target_platform="rk3566",
            mean_values=[[0, 0, 0]],
            std_values=[[255, 255, 255]],
            optimization_level=3,
            quantized_dtype="asymmetric_quantized-8",
        ),
        "simulator configuration",
    )
    require_success(runner.load_onnx(model=str(onnx_path)), "simulator ONNX load")
    require_success(
        runner.build(do_quantization=True, dataset=str(dataset_path)),
        "simulator INT8 build",
    )
    require_success(runner.init_runtime(), "simulator runtime initialization")


def compare_models(
    onnx_path: Path,
    rknn_path: Path,
    dataset_path: Path,
    image_dir: Path,
    report_path: Path,
    score_threshold: float = 0.35,
) -> bool:
    import cv2
    import numpy as np
    import onnxruntime as ort
    from rknn.api import RKNN

    images = sorted(image_dir.glob("*.jpg"))[:3]
    if len(images) != 3:
        raise RuntimeError(f"expected three comparison images in {image_dir}")
    if not rknn_path.is_file():
        raise RuntimeError(f"RKNN deployment artifact does not exist: {rknn_path}")

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    runner = RKNN(verbose=False)
    try:
        initialize_quantized_simulator(runner, onnx_path, dataset_path)
    except Exception:
        runner.release()
        raise

    frames = []
    try:
        for image_path in images:
            bgr = cv2.imread(str(image_path))
            if bgr is None:
                raise RuntimeError(f"cannot read {image_path}")
            rgb = cv2.cvtColor(letterbox(bgr), cv2.COLOR_BGR2RGB)
            nchw = rgb.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
            reference_output = combine_model_outputs(
                session.run(None, {input_name: nchw})
            )
            candidate_output = combine_model_outputs(
                runner.inference(inputs=[rgb])
            )
            reference = decode(reference_output, score_threshold=score_threshold)
            candidate = decode(candidate_output, score_threshold=score_threshold)
            result = {
                "image": image_path.name,
                "onnx_people": len(reference),
                "rknn_people": len(candidate),
                "onnx_peak_score": peak_score(reference_output),
                "rknn_peak_score": peak_score(candidate_output),
                "bbox_iou": 0.0,
                "keypoint_error_ratio": None,
                "passed": False,
            }
            if reference and candidate:
                overlap, keypoint_error = compare_person(reference[0], candidate[0])
                result["bbox_iou"] = overlap
                result["keypoint_error_ratio"] = keypoint_error
                result["passed"] = (
                    len(reference) == len(candidate)
                    and overlap >= 0.70
                    and keypoint_error <= 0.07
                )
            frames.append(result)
    finally:
        runner.release()

    report = {
        "passed": all(frame["passed"] for frame in frames),
        "rknn_model": rknn_path.name,
        "rknn_sha256": hashlib.sha256(rknn_path.read_bytes()).hexdigest(),
        "frames": frames,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return bool(report["passed"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--onnx", type=Path, required=True)
    parser.add_argument("--rknn", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--score-threshold", type=float, default=0.35)
    args = parser.parse_args()
    return (
        0
        if compare_models(
            args.onnx,
            args.rknn,
            args.dataset,
            args.images,
            args.report,
            args.score_threshold,
        )
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
