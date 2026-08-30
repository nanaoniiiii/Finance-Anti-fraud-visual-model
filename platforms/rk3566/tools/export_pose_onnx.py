#!/usr/bin/env python3
"""Export a static YOLO11n-Pose graph and verify its output contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence


POSE_CHANNELS = 56
POSE_KEYPOINTS = 17


def normalize_output_shape(shape: Sequence[int]) -> dict[str, int | str]:
    """Describe a static one-output YOLO pose tensor in BCN or BNC layout."""
    values = [int(value) for value in shape]
    if len(values) != 3 or values[0] != 1:
        raise ValueError(f"expected a static rank-3 batch-1 output, got {values}")

    if values[1] == POSE_CHANNELS:
        layout, anchors = "BCN", values[2]
    elif values[2] == POSE_CHANNELS:
        layout, anchors = "BNC", values[1]
    else:
        raise ValueError(
            f"expected exactly {POSE_CHANNELS} pose channels, got {values}"
        )
    if anchors <= 0:
        raise ValueError(f"anchor dimension must be positive, got {values}")
    return {
        "layout": layout,
        "channels": POSE_CHANNELS,
        "anchors": anchors,
        "keypoints": POSE_KEYPOINTS,
    }


def inspect_onnx_output(model_path: Path) -> dict[str, int | str]:
    import onnx

    graph = onnx.load(str(model_path)).graph
    if len(graph.output) != 1:
        raise ValueError(f"expected one ONNX output, got {len(graph.output)}")
    dimensions = graph.output[0].type.tensor_type.shape.dim
    shape: list[int] = []
    for dimension in dimensions:
        if not dimension.HasField("dim_value"):
            raise ValueError("dynamic ONNX output is not supported")
        shape.append(int(dimension.dim_value))
    return normalize_output_shape(shape)


def export_pose_model(source_model: Path, output_path: Path) -> dict[str, int | str]:
    from ultralytics import YOLO

    output_path.parent.mkdir(parents=True, exist_ok=True)
    exported = Path(
        YOLO(str(source_model)).export(
            format="onnx",
            imgsz=320,
            batch=1,
            dynamic=False,
            simplify=True,
            opset=12,
            nms=False,
        )
    )
    if exported.resolve() != output_path.resolve():
        output_path.write_bytes(exported.read_bytes())
    contract = inspect_onnx_output(output_path)
    print(json.dumps(contract, ensure_ascii=False))
    return contract


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    export_pose_model(args.model, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
