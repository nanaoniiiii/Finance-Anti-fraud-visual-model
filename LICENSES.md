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

## Project-owned implementation

The following are original project components: backend-neutral records, lightweight track association, pose geometry, temporal risk state machine, event transition logic, privacy-preserving JSONL schema, runtime configuration, and overlay composition.
