"""Report model-runtime and camera readiness without opening a GUI window."""

from __future__ import annotations

import argparse
import platform
import sys
import time

import cv2
import numpy
import torch
import ultralytics


def parse_source(value: str):
    return int(value) if value.isdecimal() else value


def open_source(source):
    if isinstance(source, int) and sys.platform.startswith("win"):
        capture = cv2.VideoCapture(source, cv2.CAP_DSHOW)
        if not capture.isOpened():
            capture.release()
            capture = cv2.VideoCapture(source)
    else:
        capture = cv2.VideoCapture(source)
    return capture


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="0")
    args = parser.parse_args()
    source = parse_source(args.source)

    print(f"Python: {platform.python_version()}")
    print(f"OpenCV: {cv2.__version__}")
    print(f"NumPy: {numpy.__version__}")
    print(f"Torch: {torch.__version__}")
    print(f"Ultralytics: {ultralytics.__version__}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"CUDA device: {torch.cuda.get_device_name(0)}")

    capture = open_source(source)
    if not capture.isOpened():
        print(f"Camera/source open: false ({source})")
        return 1
    try:
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        capture.set(cv2.CAP_PROP_FPS, 30)
        started = time.perf_counter()
        frames = 0
        shape = None
        for _ in range(12):
            ok, frame = capture.read()
            if ok:
                frames += 1
                shape = frame.shape
        elapsed = time.perf_counter() - started
        print("Camera/source open: true")
        if shape is not None:
            print(f"Negotiated frame: {shape[1]}x{shape[0]}")
        print(f"Driver FPS property: {capture.get(cv2.CAP_PROP_FPS):.2f}")
        print(f"Read sample: {frames}/12 frames in {elapsed:.3f}s")
        return 0 if frames else 2
    finally:
        capture.release()


if __name__ == "__main__":
    raise SystemExit(main())
