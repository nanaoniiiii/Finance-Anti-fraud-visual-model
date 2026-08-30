#!/usr/bin/env python3
"""Prepare deterministic calibration images from a source video."""

from __future__ import annotations

import argparse
from pathlib import Path


def sample_indices(total_frames: int, sample_count: int) -> list[int]:
    if total_frames <= 0:
        raise ValueError("total_frames must be positive")
    if sample_count <= 0 or sample_count > total_frames:
        raise ValueError("sample_count must be in the available frame range")
    if sample_count == 1:
        return [0]
    last = total_frames - 1
    return [int(index * last / (sample_count - 1)) for index in range(sample_count)]


def letterbox(frame, size: int = 320):
    import cv2
    import numpy as np

    height, width = frame.shape[:2]
    scale = min(size / width, size / height)
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    resized = cv2.resize(frame, (resized_width, resized_height))
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    left = (size - resized_width) // 2
    top = (size - resized_height) // 2
    canvas[top : top + resized_height, left : left + resized_width] = resized
    return canvas


def prepare_calibration_images(
    video_path: Path, output_dir: Path, count: int = 40
) -> Path:
    import cv2

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"cannot open video: {video_path}")
    try:
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        indices = sample_indices(total_frames, count)
        output_dir.mkdir(parents=True, exist_ok=True)
        image_paths: list[Path] = []
        for order, frame_index in enumerate(indices):
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError(f"cannot read frame {frame_index}")
            image_path = output_dir / f"calibration-{order:03d}.jpg"
            if not cv2.imwrite(str(image_path), letterbox(frame)):
                raise RuntimeError(f"cannot write image: {image_path}")
            image_paths.append(image_path.resolve())
    finally:
        capture.release()

    dataset_path = output_dir / "dataset.txt"
    dataset_path.write_text(
        "".join(f"{path.as_posix()}\n" for path in image_paths), encoding="utf-8"
    )
    return dataset_path


def prepare_comparison_images(
    video_path: Path,
    output_dir: Path,
    excluded_indices: set[int],
    count: int = 3,
) -> list[Path]:
    import cv2

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"cannot open video: {video_path}")
    try:
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        candidates = sample_indices(total_frames, min(total_frames, count * 7))
        selected = [index for index in candidates if index not in excluded_indices][:count]
        if len(selected) != count:
            raise RuntimeError("not enough frames outside the calibration sample")
        output_dir.mkdir(parents=True, exist_ok=True)
        paths: list[Path] = []
        for order, frame_index in enumerate(selected):
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError(f"cannot read frame {frame_index}")
            path = output_dir / f"comparison-{order:02d}.jpg"
            if not cv2.imwrite(str(path), letterbox(frame)):
                raise RuntimeError(f"cannot write image: {path}")
            paths.append(path)
        return paths
    finally:
        capture.release()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--comparison-dir", type=Path)
    parser.add_argument("--count", type=int, default=40)
    args = parser.parse_args()
    dataset = prepare_calibration_images(args.video, args.output_dir, args.count)
    if args.comparison_dir:
        import cv2

        capture = cv2.VideoCapture(str(args.video))
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        capture.release()
        excluded = set(sample_indices(total_frames, args.count))
        prepare_comparison_images(args.video, args.comparison_dir, excluded)
    print(dataset)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
