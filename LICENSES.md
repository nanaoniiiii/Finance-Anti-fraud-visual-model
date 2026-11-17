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

## Preview transport dependencies (1.3.0)

- `github.com/coder/websocket` v1.8.15: ISC license, https://github.com/coder/websocket . Its license is supplied with relay bundles.
- `websocket-client` 1.9.0: Apache-2.0, https://github.com/websocket-client/websocket-client . Used by Windows/MaixCAM preview adapters.
- OkHttp 5.3.2, Okio and Kotlin runtime: Apache-2.0, https://github.com/square/okhttp . Android uses the Gradle-pinned dependency and default certificate verification.
- ArduinoWebsockets 0.5.4: GPL-3.0, https://github.com/gilmaimon/ArduinoWebsockets . The Sense firmware bundle supplies the license, library source and matching application source/build instructions.
- `ws` 8.21.0: MIT, https://github.com/websockets/ws . Used by protocol and real-cloud verification tools, not bundled in device firmware.

## Project-owned implementation

The following are original project components: backend-neutral records, lightweight track association, pose geometry, temporal risk state machine, event transition logic, privacy-preserving JSONL schema, runtime configuration, and overlay composition.

## Portable CPU and ESP32-S3 releases (1.6.0)

- The portable pose ONNX and five ESP-DL INT8 variants derive from the same upstream `yolo11n-pose.pt` cited above. The optional portable phone-object model derives from `yolo11n.pt` from the same Ultralytics assets release. The aggregate distribution includes AGPL-3.0 model components; matching application source, original weights, ONNX exports, conversion scripts and the AGPL text are supplied or linked with the release. The authors do not claim original training of these pretrained weights.
- Windows executable runtime versions are recorded in `licenses/windows-runtime/VERSIONS.txt`. The included Python, Tcl/Tk, NumPy and its bundled libraries, OpenCV and FFmpeg notices, ONNX Runtime and ThirdPartyNotices, Pillow, websocket-client and collected transitive dependency license texts accompany the executable. PyInstaller's GPL text includes its bootloader exception. Source packaging excludes per-user configuration and device keys.
- Linux installs the CPU packages pinned in `platforms/linux/requirements.txt` from their original package registries, and obtains the hash-verified uv bootstrap from `https://github.com/astral-sh/uv/releases/tag/0.13.8`. Its runtime dependency versions and Python version can be read from the installed virtual environment. The bundle also includes the model and runtime license collection; Windows-specific notices do not imply shipping Windows binaries in the Linux package.
- ESP-DL 3.3.14: Apache-2.0, `https://github.com/espressif/esp-dl/tree/v3.3.14`; ESP-IDF 5.5.1: Apache-2.0 plus its per-component notices, `https://github.com/espressif/esp-idf/tree/v5.5.1`.
- Arduino core 3.3.2: LGPL-2.1, `https://github.com/espressif/arduino-esp32/tree/3.3.2`; camera 2.1.3 and WebSocket client 1.8.0: their upstream Espressif component licenses. ArduinoJson 7.4.2: MIT, `https://github.com/bblanchon/ArduinoJson/tree/v7.4.2`. The release supplies the selected library sources/build instructions and upstream notices; modifications to vendor originals are avoided by staging the build separately.
- MaixCAM uses the installed Sipeed MaixPy 4 runtime and Sipeed's preinstalled YOLO11n Pose CVI model. The project package contains the PoseGuard adapter, installer and Mozilla CA bundle from certifi 2026.06.17, under MPL-2.0. The matching notice is in `licenses/Certifi-MPL-2.0.txt`. See [Sipeed model documentation](https://wiki.sipeed.com/maixpy/doc/en/vision/body_key_points.html) and [certifi](https://github.com/certifi/python-certifi).
- Calibration frames, identifiable camera screenshots, test videos, full flash/NVS backups, Wi-Fi details, SMTP/OAuth material and device credentials are excluded from all public release assets. Public validation contains aggregate measurements, not images of people.
