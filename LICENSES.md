# Third-party components and model provenance

This file records dependencies used by the Windows prototype. It is not legal advice.

## Ultralytics

- Purpose: Windows prototype adapter for YOLO11n-pose and optional COCO cell-phone detection.
- Project and documentation: https://docs.ultralytics.com/
- Licensing information: https://www.ultralytics.com/license
- Distribution note: review AGPL-3.0 obligations or obtain an appropriate enterprise license before proprietary commercial distribution.

## OpenCV

- Purpose: camera/video capture, frame resizing, drawing, and desktop display.
- Project: https://opencv.org/
- License: Apache License 2.0, as published by the OpenCV project.

## NumPy

- Purpose: array handling in tests and model adapters.
- Project: https://numpy.org/
- License: BSD 3-Clause.

## Pillow

- Purpose: render readable Chinese risk labels with an installed Unicode font.
- Project: https://python-pillow.github.io/
- Source: https://github.com/python-pillow/Pillow
- License: MIT-CMU, as published in the Pillow 12.2.0 project metadata and license file.

## RK3566 release components

- The INT8 RKNN and intermediate ONNX derive from Ultralytics `yolo11n-pose.pt`, obtained from https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n-pose.pt. Matching original weights, ONNX and transformation scripts are supplied in the model-sources release asset. The AGPL-3.0 text is included; the pretrained weights are not claimed as original training work.
- RKNN Toolkit2 2.3.2 is used for conversion. The unchanged AArch64 runtime is from https://github.com/airockchip/rknn-toolkit2/tree/v2.3.2/rknpu2/runtime/Linux/librknn_api. Its upstream Rockchip copyright statement is included. It is loaded from the application's private `lib` directory.
- GStreamer, GLib, MPP, the C/C++ runtime and Weston are dynamically used from the target firmware; they are not copied into this deployment bundle.
- Calibration frames, user-supplied regression videos and identifiable screenshots are excluded from the public release. Small functional regressions are not representative accuracy certification.

## Project-owned implementation

The following are original project components: backend-neutral records, lightweight track association, pose geometry, temporal risk state machine, event transition logic, privacy-preserving JSONL schema, runtime configuration, and overlay composition.
