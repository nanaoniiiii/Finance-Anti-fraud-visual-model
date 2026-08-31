#!/usr/bin/env python3
"""Export a static YOLO11n-Pose graph and verify its output contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence


POSE_CHANNELS = 56
POSE_KEYPOINTS = 17
SPLIT_OUTPUT_NAMES = (
    "pose_boxes",
    "pose_scores",
    "pose_keypoints",
    "pose_keypoint_scores",
)


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
    shapes = []
    for output in graph.output:
        shape = []
        for dimension in output.type.tensor_type.shape.dim:
            if not dimension.HasField("dim_value"):
                raise ValueError("dynamic ONNX output is not supported")
            shape.append(int(dimension.dim_value))
        shapes.append(shape)

    if len(shapes) == 1:
        return normalize_output_shape(shapes[0])
    if len(shapes) != 4 or tuple(item.name for item in graph.output) != SPLIT_OUTPUT_NAMES:
        raise ValueError(f"expected one combined or four split pose outputs, got {shapes}")

    anchors = shapes[0][2] if len(shapes[0]) == 3 else -1
    expected = [
        [1, 4, anchors],
        [1, 1, anchors],
        [1, 51, anchors],
        [1, 17, anchors],
    ]
    if anchors <= 0 or shapes != expected:
        raise ValueError(f"invalid split pose output shapes: {shapes}")
    return {
        "layout": "SPLIT_BCN",
        "channels": POSE_CHANNELS,
        "anchors": anchors,
        "keypoints": POSE_KEYPOINTS,
        "outputs": 4,
    }


def split_pose_output_scales(
    source_path: Path, output_path: Path
) -> dict[str, int | str]:
    """Expose score tensors separately so RKNN assigns useful INT8 scales."""
    import onnx
    from onnx import TensorProto, helper

    model = onnx.load(str(source_path))
    graph = model.graph
    if len(graph.output) != 1:
        raise ValueError("source pose graph must have one combined output")
    contract = normalize_output_shape(
        [
            int(item.dim_value)
            for item in graph.output[0].type.tensor_type.shape.dim
        ]
    )
    if contract["layout"] != "BCN":
        raise ValueError("split output preparation requires BCN pose output")

    output_name = graph.output[0].name
    producers = [node for node in graph.node if output_name in node.output]
    if len(producers) != 1 or producers[0].op_type != "Concat":
        raise ValueError("combined pose output must be produced by one Concat node")
    producer = producers[0]
    axis = next(
        (
            int(helper.get_attribute_value(attribute))
            for attribute in producer.attribute
            if attribute.name == "axis"
        ),
        None,
    )
    if axis != 1 or len(producer.input) != 3:
        raise ValueError("pose output Concat must join boxes, scores and keypoints")

    anchors = int(contract["anchors"])
    boxes_input, scores_input, keypoints_input = producer.input
    score_indices_name = "poseguard_keypoint_score_indices"
    graph.initializer.append(
        helper.make_tensor(
            score_indices_name,
            TensorProto.INT64,
            [POSE_KEYPOINTS],
            [2 + point * 3 for point in range(POSE_KEYPOINTS)],
        )
    )
    graph.node.extend(
        [
            helper.make_node("Identity", [boxes_input], [SPLIT_OUTPUT_NAMES[0]]),
            helper.make_node("Identity", [scores_input], [SPLIT_OUTPUT_NAMES[1]]),
            helper.make_node(
                "Identity", [keypoints_input], [SPLIT_OUTPUT_NAMES[2]]
            ),
            helper.make_node(
                "Gather",
                [keypoints_input, score_indices_name],
                [SPLIT_OUTPUT_NAMES[3]],
                axis=1,
            ),
        ]
    )
    graph.node.remove(producer)
    del graph.output[:]
    graph.output.extend(
        [
            helper.make_tensor_value_info(
                SPLIT_OUTPUT_NAMES[0], TensorProto.FLOAT, [1, 4, anchors]
            ),
            helper.make_tensor_value_info(
                SPLIT_OUTPUT_NAMES[1], TensorProto.FLOAT, [1, 1, anchors]
            ),
            helper.make_tensor_value_info(
                SPLIT_OUTPUT_NAMES[2], TensorProto.FLOAT, [1, 51, anchors]
            ),
            helper.make_tensor_value_info(
                SPLIT_OUTPUT_NAMES[3], TensorProto.FLOAT, [1, 17, anchors]
            ),
        ]
    )
    onnx.checker.check_model(model)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(output_path))
    return inspect_onnx_output(output_path)


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
    contract = split_pose_output_scales(output_path, output_path)
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
