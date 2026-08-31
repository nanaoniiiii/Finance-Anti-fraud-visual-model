#!/usr/bin/env python3
"""Convert the verified pose ONNX graph to an RK3566 INT8 RKNN model."""

from __future__ import annotations

import argparse
from pathlib import Path

from platforms.rk3566.tools.export_pose_onnx import inspect_onnx_output


def require_success(code: int, operation: str) -> None:
    if code != 0:
        raise RuntimeError(f"RKNN {operation} failed with code {code}")


def convert_model(onnx_path: Path, dataset_path: Path, output_path: Path) -> None:
    from rknn.api import RKNN

    inspect_onnx_output(onnx_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    converter = RKNN(verbose=False)
    try:
        require_success(
            converter.config(
                target_platform="rk3566",
                mean_values=[[0, 0, 0]],
                std_values=[[255, 255, 255]],
                optimization_level=3,
                quantized_dtype="asymmetric_quantized-8",
            ),
            "configuration",
        )
        require_success(converter.load_onnx(model=str(onnx_path)), "ONNX load")
        require_success(
            converter.build(do_quantization=True, dataset=str(dataset_path)),
            "INT8 build",
        )
        require_success(converter.export_rknn(str(output_path)), "export")
    finally:
        converter.release()
    print(output_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--onnx", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    convert_model(args.onnx, args.dataset, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
