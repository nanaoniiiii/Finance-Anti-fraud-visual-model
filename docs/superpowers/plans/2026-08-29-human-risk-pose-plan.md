# Human Risk Pose Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-first, real-time multi-person pose tracking prototype that highlights confirmed suspicious behavior in red and keeps model-specific code replaceable for RK3566, MaixCAM Pro, and ESP32-S3 integration.

**Architecture:** A capture loop feeds a YOLO11n-pose adapter, which emits a backend-neutral person record. An original track manager assigns stable IDs and smooths short-term motion. A separate risk engine applies geometry, proximity, and temporal hysteresis rules; the renderer and JSONL event logger consume only risk results. Phone detection is an optional, conditional backend invoked for hand-near-ear candidates.

**Tech Stack:** Python 3.11, OpenCV, Ultralytics YOLO11n-pose/YOLO11n during Windows prototyping, NumPy, pytest, JSON configuration, JSONL event logging.

---

## File map

Create the following focused modules under `C:/Users/31919/Desktop/poseguard/`:

- `poseguard/__init__.py`: package marker and version string.
- `poseguard/types.py`: immutable backend-neutral records for boxes, keypoints, detections, tracks, phones, and risk results.
- `poseguard/config.py`: default configuration, JSON loading, validation, and command-line override helpers.
- `poseguard/backends/base.py`: `PoseBackend` and `PhoneBackend` protocols.
- `poseguard/backends/yolo_pose.py`: YOLO11n-pose adapter; no risk logic.
- `poseguard/backends/yolo_phone.py`: conditional COCO cell-phone adapter; no risk logic.
- `poseguard/tracking/person_tracks.py`: original stable-ID association, missed-frame retention, and smoothing.
- `poseguard/risk/geometry.py`: normalized distances, regions, pose posture, and person proximity calculations.
- `poseguard/risk/risk_engine.py`: candidate/alert state machine for the three approved behaviors.
- `poseguard/ui/overlay.py`: yellow/orange/red boxes, labels, skeleton, status panel, and FPS.
- `poseguard/io/event_log.py`: privacy-preserving JSONL event output.
- `poseguard/app.py`: source opening, inference loop, keyboard handling, shutdown, and wiring.
- `configs/windows.json`: concrete Windows defaults.
- `README.md`: installation, model placement, run commands, controls, limitations, and license notice.
- `LICENSES.md`: dependency and model provenance record.
- `tests/conftest.py`: reusable synthetic keypoint and track builders.
- `tests/test_package_smoke.py`: package import and type smoke test.
- `tests/test_config.py`: configuration behavior.
- `tests/test_geometry.py`: deterministic geometric predicates.
- `tests/test_tracking.py`: stable IDs, smoothing, and missed detections.
- `tests/test_risk_engine.py`: all approved risk transitions and false-positive guards.
- `tests/test_event_log.py`: JSONL schema and no-frame-data guarantee.
- `tests/test_overlay.py`: renderer shape, immutability, and key handling smoke tests.

## Task 1: Package skeleton and test harness

**Files:**
- Create: `poseguard/__init__.py`
- Create: `poseguard/types.py`
- Create: `tests/conftest.py`
- Create: `tests/test_package_smoke.py`
- Create: `pyproject.toml`

- [ ] **Step 1: Write the failing import test**

```python
from poseguard import __version__
from poseguard.types import Keypoint, PersonObservation


def test_package_exposes_version_and_observation_types():
    point = Keypoint(x=10.0, y=20.0, confidence=0.9)
    observation = PersonObservation(
        detection_index=0,
        bbox=(0.0, 0.0, 50.0, 100.0),
        confidence=0.9,
        keypoints=(point,) * 17,
    )
    assert __version__
    assert len(observation.keypoints) == 17
```

- [ ] **Step 2: Run the test and confirm the expected missing-package failure**

Run from `C:/Users/31919/Desktop/poseguard`:

```powershell
python -m pytest tests/test_package_smoke.py -q
```

Expected: FAIL because the `poseguard` package and types do not exist.

- [ ] **Step 3: Implement the minimal package and typed records**

`types.py` must define `Keypoint`, `PersonObservation`, `PersonTrack`, `PhoneObservation`, `RiskKind`, `RiskState`, and `RiskDecision` using dataclasses or enums. Coordinates use image pixels; confidence is `[0, 1]`; a missing keypoint is represented by `None` in the keypoint tuple. `PersonObservation` must preserve the 17 COCO keypoint order.

- [ ] **Step 4: Add pytest configuration and rerun**

Create `pyproject.toml` with pytest discovery rooted at `tests`. Run the same command and expect one passing test.

- [ ] **Step 5: Commit**

```powershell
git add pyproject.toml poseguard tests
git -c user.name='Codex' -c user.email='codex@local' commit -m "chore: scaffold poseguard package"
```

## Task 2: Configuration and command-line contract

**Files:**
- Create: `poseguard/config.py`
- Create: `configs/windows.json`
- Create: `tests/test_config.py`

- [ ] **Step 1: Write failing configuration tests**

Cover these exact behaviors:

```python
from poseguard.config import default_config, load_config, validate_config


def test_default_config_uses_approved_risk_thresholds():
    config = default_config()
    assert config["risk"]["lingering_seconds"] == 20.0
    assert config["risk"]["multi_person_seconds"] == 1.5
    assert config["risk"]["phone_confirm_seconds"] == 1.0


def test_invalid_threshold_is_rejected(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text('{"risk": {"lingering_seconds": -1}}', encoding="utf-8")
    try:
        load_config(path)
    except ValueError as exc:
        assert "lingering_seconds" in str(exc)
    else:
        raise AssertionError("negative lingering threshold must be rejected")


def test_missing_phone_model_is_allowed_when_optional():
    config = default_config()
    config["models"]["phone_path"] = ""
    assert validate_config(config) == []
```

- [ ] **Step 2: Run tests and confirm they fail because configuration functions are absent**

```powershell
python -m pytest tests/test_config.py -q
```

- [ ] **Step 3: Implement configuration**

Use the following concrete defaults in `configs/windows.json`: source `0`, display enabled, input max width `960`, pose path `models/yolo11n-pose.pt`, phone path `models/yolo11n.pt`, pose confidence `0.35`, phone confidence `0.30`, minimum track confidence `0.35`, missing-frame retention `8`, region `(0.05, 0.05, 0.95, 0.95)`, lingering `20.0`, multi-person `1.5`, phone confirmation `1.0`, alert release `0.8`, phone class `67`, and event directory `runs`.

Implement `default_config()`, `load_config(path)`, `validate_config(config)`, and `apply_cli_overrides(config, args)`. Validation must reject negative durations, confidence outside `[0, 1]`, malformed region bounds, and duplicate model path requirements only when the phone feature is enabled.

- [ ] **Step 4: Run all configuration tests and commit**

```powershell
python -m pytest tests/test_config.py -q
git add poseguard/config.py configs/windows.json tests/test_config.py
git -c user.name='Codex' -c user.email='codex@local' commit -m "feat: add validated runtime configuration"
```

## Task 3: Geometry primitives and backend protocols

**Files:**
- Create: `poseguard/backends/base.py`
- Create: `poseguard/risk/geometry.py`
- Create: `tests/test_geometry.py`

- [ ] **Step 1: Write failing geometry tests**

Test normalized wrist-ear distance, wrist-near-ear candidate detection, standing posture, region membership, person proximity, and phone association. Synthetic coordinates must include both left and right side examples and a no-phone case.

```python
def test_hand_near_ear_is_scale_normalized():
    assert hand_near_ear(wrist=(48, 42), ear=(50, 40), body_height=100, ratio=0.08)
    assert not hand_near_ear(wrist=(48, 42), ear=(70, 40), body_height=100, ratio=0.08)
```

- [ ] **Step 2: Run the geometry tests and confirm the expected missing-function failure**

```powershell
python -m pytest tests/test_geometry.py -q
```

- [ ] **Step 3: Implement pure geometry functions**

Use COCO indices `left_ear=3`, `right_ear=4`, `left_shoulder=5`, `right_shoulder=6`, `left_elbow=7`, `right_elbow=8`, `left_wrist=9`, `right_wrist=10`, `left_hip=11`, `right_hip=12`, `left_ankle=15`, and `right_ankle=16`. `candidate_phone_side()` must return one or both candidate sides; `is_standing()` must require torso and leg evidence but return false for missing leg points; `inside_region()` must use normalized frame coordinates; `nearby_people()` must compare centers using the larger body height as scale. Define `PoseBackend.infer(frame)` and `PhoneBackend.find(frame, regions)` protocols with backend-neutral return types.

- [ ] **Step 4: Run tests, inspect edge cases, and commit**

```powershell
python -m pytest tests/test_geometry.py -q
git add poseguard/backends/base.py poseguard/risk/geometry.py tests/test_geometry.py
git -c user.name='Codex' -c user.email='codex@local' commit -m "feat: add normalized pose geometry"
```

## Task 4: Stable person tracking

**Files:**
- Create: `poseguard/tracking/__init__.py`
- Create: `poseguard/tracking/person_tracks.py`
- Create: `tests/test_tracking.py`

- [ ] **Step 1: Write failing tracking tests**

Cover one person retaining an ID after small motion, two people receiving different IDs, a brief missing detection retaining the track, and a long absence removing it. Include a smoothing assertion that a noisy center changes less than the raw center.

- [ ] **Step 2: Run tests and confirm failure because `PersonTrackManager` is absent**

```powershell
python -m pytest tests/test_tracking.py -q
```

- [ ] **Step 3: Implement the original association manager**

Implement `PersonTrackManager.update(observations, timestamp, frame_size) -> tuple[PersonTrack, ...]`. Match candidates using a weighted score of normalized center distance, box-area ratio, and visible-keypoint distance. Use a greedy lowest-cost assignment for the small expected number of people; do not import an external tracker. New tracks receive monotonic IDs. Keep an unmatched track for exactly `max_missing_frames`, mark it predicted, and then remove it. Smooth center and keypoints with configurable alpha. Track records must retain `entered_at`, `last_seen`, `missing_frames`, `inside_since`, and `path_length` for the risk engine.

- [ ] **Step 4: Run tracking tests and commit**

```powershell
python -m pytest tests/test_tracking.py -q
git add poseguard/tracking tests/test_tracking.py
git -c user.name='Codex' -c user.email='codex@local' commit -m "feat: add stable lightweight person tracks"
```

## Task 5: Risk state machine

**Files:**
- Create: `poseguard/risk/__init__.py`
- Create: `poseguard/risk/risk_engine.py`
- Modify: `poseguard/types.py`
- Create: `tests/test_risk_engine.py`

- [ ] **Step 1: Write failing risk tests**

Use a fake clock so timing is deterministic. Required cases:

```python
def test_phone_candidate_stays_amber_without_phone(): ...
def test_phone_match_turns_amber_candidate_red_after_one_second(): ...
def test_two_people_inside_region_turn_red_after_one_point_five_seconds(): ...
def test_single_person_lingering_turns_red_after_twenty_seconds(): ...
def test_short_linger_and_distant_background_person_stay_normal(): ...
def test_alert_releases_only_after_release_window(): ...
```

Assertions must check risk kind, state, color, reason, and stable track ID. Test that a hand near the ear without a phone never becomes a confirmed phone alert.

- [ ] **Step 2: Run tests and confirm the expected missing-engine failure**

```powershell
python -m pytest tests/test_risk_engine.py -q
```

- [ ] **Step 3: Implement the state machine**

Implement `RiskRuleEngine.evaluate(tracks, phones, frame_size, timestamp) -> tuple[RiskDecision, ...]`. Keep independent per-track timers for phone candidate and lingering, and a system timer for multi-person presence. Return `NORMAL`, `CANDIDATE`, or `ALERT`; `CANDIDATE` maps to orange, `ALERT` maps to red, and normal maps to yellow. Phone confirmation requires a matching phone box plus a valid side candidate for `phone_confirm_seconds`. Lingering requires continuous region membership and low-motion evidence. Multi-person requires at least two stable tracks in the region for `multi_person_seconds`. Apply `alert_release_seconds` before clearing an active alert. No rule may infer identity, gender, intent, or criminal status; labels must use “疑似风险行为”.

- [ ] **Step 4: Run risk tests, then all pure-Python tests**

```powershell
python -m pytest tests/test_geometry.py tests/test_tracking.py tests/test_risk_engine.py -q
```

- [ ] **Step 5: Commit**

```powershell
git add poseguard/types.py poseguard/risk tests/test_risk_engine.py
git -c user.name='Codex' -c user.email='codex@local' commit -m "feat: add temporal risk behavior engine"
```

## Task 6: YOLO adapters and event logging

**Files:**
- Create: `poseguard/backends/yolo_pose.py`
- Create: `poseguard/backends/yolo_phone.py`
- Create: `poseguard/io/__init__.py`
- Create: `poseguard/io/event_log.py`
- Create: `tests/test_event_log.py`

- [ ] **Step 1: Write failing adapter contract and event-log tests**

Test that a fake result converts to the exact 17-keypoint order, that no-phone mode returns an empty tuple without loading a model, and that a logged event contains timestamp, track ID, risk kind, reason, confidence, and geometry but no image bytes or raw frame field.

- [ ] **Step 2: Run tests and confirm failure because adapters and logger are absent**

```powershell
python -m pytest tests/test_event_log.py -q
```

- [ ] **Step 3: Implement model adapters**

`YoloPoseBackend` loads `YOLO(model_path)` lazily on first `infer()` call and uses `model.predict(source=frame, conf=..., verbose=False)`. It converts `boxes.xyxy`, `boxes.conf`, `keypoints.xy`, and `keypoints.conf` into `PersonObservation` and never assigns track IDs. `YoloPhoneBackend` loads only when enabled, calls `model.predict(..., classes=[67])`, and returns `PhoneObservation`; it may be called with candidate regions to reduce work. Model import errors must become readable `RuntimeError` messages.

- [ ] **Step 4: Implement event logging**

`EventLogger.write(decision)` appends one UTF-8 JSON object per line using atomic flush per event. Fields are `timestamp`, `track_id`, `risk_kind`, `state`, `reason`, `confidence`, `bbox`, and `duration_seconds`. Never serialize frames, keypoints, face data, or file paths containing raw media.

- [ ] **Step 5: Run adapter-independent tests and commit**

```powershell
python -m pytest tests/test_event_log.py -q
git add poseguard/backends poseguard/io tests/test_event_log.py
git -c user.name='Codex' -c user.email='codex@local' commit -m "feat: add replaceable YOLO backends and private event log"
```

## Task 7: Windows overlay and application loop

**Files:**
- Create: `poseguard/ui/__init__.py`
- Create: `poseguard/ui/overlay.py`
- Create: `poseguard/app.py`
- Create: `README.md`
- Create: `LICENSES.md`
- Modify: `configs/windows.json`

- [ ] **Step 1: Write failing renderer smoke tests**

Test a black `640x480` frame with one normal track and one alert decision. Assert the renderer returns the same shape, does not mutate the input array, and can render Chinese/ASCII risk labels without raising. Test that `q` and ESC are recognized by the input helper.

- [ ] **Step 2: Run the smoke tests and confirm failure because the renderer/app are absent**

```powershell
python -m pytest tests/test_overlay.py -q
```

- [ ] **Step 3: Implement the overlay**

Draw skeleton lines from the COCO adjacency list, normal boxes in yellow `(0, 220, 255)`, candidate boxes in orange `(0, 165, 255)`, alerts in red `(0, 0, 255)`. Draw `ID`, “疑似风险行为”, reason, duration, FPS, inference time, and active person count. Keep all drawing in `OverlayRenderer.render(frame, tracks, decisions, metrics)`.

- [ ] **Step 4: Implement the application loop**

`app.py` must parse `--source`, `--config`, `--pose-model`, `--phone-model`, `--disable-phone`, `--no-display`, and `--output-dir`. Open integer source `0` with DirectShow on Windows when available, set `CAP_PROP_BUFFERSIZE` to `1`, request `1280x720` at `30` FPS, then verify the actual frame shape and continue even if the camera negotiates another supported mode. For every frame: infer pose, update tracks, call phone backend only for candidates, evaluate risks, render, log transitions, and display. On `q`/ESC, capture failure, or exception, release camera, destroy windows, close the logger, and return a nonzero exit code only for startup failure.

- [ ] **Step 5: Write README and license record**

Document the exact Windows commands:

```powershell
cd C:\Users\31919\Desktop\poseguard
python -m pip install -r requirements.txt
python -m poseguard.app --source 0 --config configs/windows.json
python -m poseguard.app --source C:\path\to\test.mp4 --config configs/windows.json --disable-phone
```

Explain that YOLO11n-pose and the optional YOLO11n phone backend are replaceable third-party components, list Ultralytics and OpenCV references, and require license review before closed-source commercial distribution. State that red boxes indicate “疑似风险行为” and are not a legal or identity conclusion.

- [ ] **Step 6: Run unit tests and Python compilation**

```powershell
python -m pytest -q
python -m compileall -q poseguard
```

- [ ] **Step 7: Commit**

```powershell
git add poseguard/ui poseguard/app.py configs/windows.json README.md LICENSES.md tests
git -c user.name='Codex' -c user.email='codex@local' commit -m "feat: add Windows realtime risk pose application"
```

## Task 8: Windows model and camera validation

**Files:**
- Create: `requirements.txt`
- Create: `scripts/check_windows.py`
- Create: `runs/.gitkeep`
- Modify: `README.md`

- [ ] **Step 1: Add pinned runtime requirements**

List `numpy`, `opencv-python`, `ultralytics`, and `pytest` without hard-coding a CUDA-only torch wheel. The check script must print Python, OpenCV, Torch, Ultralytics, CUDA availability, camera open status, negotiated resolution, and FPS.

- [ ] **Step 2: Run the environment check**

```powershell
python scripts/check_windows.py --source 0
```

Expected: a readable report showing whether the HD webcam opens and which actual resolution/FPS it negotiates. If the camera is unavailable, use an MP4 source for application validation and record the camera limitation instead of changing risk logic.

- [ ] **Step 3: Download or place model files and run a short video smoke test**

Use `models/yolo11n-pose.pt` and, when phone confirmation is enabled, `models/yolo11n.pt`. Run for at least 120 frames on a local video and verify that `runs/events.jsonl` is created, the process exits on `q`, and no raw frames are written.

- [ ] **Step 4: Run the Windows camera test**

```powershell
python -m poseguard.app --source 0 --config configs/windows.json --output-dir runs/windows-test
```

Record observed FPS, median inference time, startup time, ID stability during a brief occlusion, and examples of normal/candidate/alert colors. Do not claim the PPT accuracy or false-positive targets without a labeled evaluation set.

- [ ] **Step 5: Commit validation tooling and final test evidence**

```powershell
python -m pytest -q
python -m compileall -q poseguard scripts
git add requirements.txt scripts runs/.gitkeep README.md
git -c user.name='Codex' -c user.email='codex@local' commit -m "test: add Windows environment and camera validation"
```

## Task 9: Embedded portability handoff

**Files:**
- Create: `docs/embedded-portability.md`
- Modify: `README.md`

- [ ] **Step 1: Document the backend portability contract**

Specify that embedded adapters only implement `PoseBackend.infer()` and optional `PhoneBackend.find()`, while `types.py`, geometry, track manager, risk engine, event schema, and rule tests remain shared. Document the expected RKNN tensor-to-keypoint conversion and that the app must accept a frame without relying on a desktop display.

- [ ] **Step 2: Document platform-specific deployment tiers**

Record the first target as RK3566 with a quantized lightweight pose model and conditional phone inference; MaixCAM Pro as a separate adapter; ESP32-S3 Sense as capture/trigger frontend unless a separately validated tiny landmark model is available. Include memory, latency, and thermal measurements as required fields for the next test phase.

- [ ] **Step 3: Run the full verification suite and inspect repository state**

```powershell
python -m pytest -q
python -m compileall -q poseguard scripts
git diff --check
git status --short
```

Expected: all tests pass, compilation exits successfully, `git diff --check` produces no output, and only intended project files are tracked.

- [ ] **Step 4: Commit the portability handoff**

```powershell
git add docs/embedded-portability.md README.md
git -c user.name='Codex' -c user.email='codex@local' commit -m "docs: define embedded backend handoff"
```

## Verification checklist before declaring the prototype ready

- [ ] `python -m pytest -q` passes with zero failures.
- [ ] `python -m compileall -q poseguard scripts` exits successfully.
- [ ] Windows camera or a local video runs for 120 frames without a freeze.
- [ ] Two stable people in the configured region produce a red multi-person decision only after 1.5 seconds.
- [ ] Wrist-near-ear without a phone remains orange/candidate and never becomes a confirmed phone alert.
- [ ] A matching phone plus stable pose produces a red phone decision after 1 second.
- [ ] A single target becomes a red lingering decision only after 20 seconds of region membership and low motion.
- [ ] Short detector gaps preserve IDs and do not reset the lingering timer.
- [ ] Event JSONL contains no raw frame or image bytes.
- [ ] README and LICENSES.md explain third-party dependencies and commercial-license review.
- [ ] The result is described as suspicious-behavior assistance, not identity or criminal classification.
