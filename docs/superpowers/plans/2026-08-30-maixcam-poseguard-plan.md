# PoseGuard MaixCAM Pro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a self-contained MaixCAM Pro loop that captures the onboard camera, performs YOLO11n-Pose 320×224 INT8 inference, maintains person tracks, evaluates three suspicious-pose rules, and displays/logs alerts.

**Architecture:** Maix-specific code lives under `platforms/maixcam` and has no import-time dependency on desktop OpenCV or Ultralytics. Pure-Python adapter, tracking, risk, and event modules are tested on Windows; `main.py` is the only module that opens Maix camera/model/display resources.

**Tech Stack:** Python 3.11, MaixPy 4.12.5, `maix.nn.YOLO11`, onboard MIPI camera/display, pytest, Paramiko for deployment.

---

### Task 1: Maix pose-result adapter

**Files:**
- Create: `platforms/__init__.py`
- Create: `platforms/maixcam/__init__.py`
- Create: `platforms/maixcam/config.py`
- Create: `platforms/maixcam/pose_adapter.py`
- Test: `tests/maixcam/test_pose_adapter.py`

- [ ] **Step 1: Write the failing adapter tests**

```python
from types import SimpleNamespace

from platforms.maixcam.pose_adapter import adapt_objects


def make_object(points, *, score=0.8, x=20, y=10, w=100, h=180):
    return SimpleNamespace(
        x=x, y=y, w=w, h=h, score=score, class_id=0, points=points
    )


def test_converts_minus_one_points_to_none():
    points = [10, 11] * 17
    points[6:8] = [-1, -1]
    result = adapt_objects([make_object(points)], (320, 224))
    assert len(result) == 1
    assert result[0]["keypoints"][3] is None


def test_rejects_detection_with_too_few_visible_points():
    points = [-1, -1] * 17
    points[:10] = [10, 11] * 5
    assert adapt_objects([make_object(points)], (320, 224)) == []


def test_deduplicates_overlapping_people_by_score():
    points = [40, 40] * 17
    low = make_object(points, score=0.6)
    high = make_object(points, score=0.9, x=22)
    result = adapt_objects([low, high], (320, 224))
    assert [item["confidence"] for item in result] == [0.9]
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `python -m pytest tests/maixcam/test_pose_adapter.py -q`

Expected: collection fails because `platforms.maixcam.pose_adapter` does not exist.

- [ ] **Step 3: Implement configuration and adapter**

`config.py` exposes a plain `CONFIG` dictionary with model path, thresholds, ROI, tracking limits, risk durations, display flag, and event path. `pose_adapter.py` exposes this API:

```python
KEYPOINT_COUNT = 17
TORSO_INDICES = (5, 6, 11, 12)


def adapt_objects(objects, frame_size, config=None):
    settings = config or {}
    observations = []
    for detection_index, obj in enumerate(objects):
        observation = adapt_object(obj, detection_index, frame_size, settings)
        if observation is not None:
            observations.append(observation)
    return deduplicate(observations, settings.get("duplicate_iou", 0.45))


def adapt_object(obj, detection_index, frame_size, settings):
    points = list(obj.points)
    if len(points) != KEYPOINT_COUNT * 2:
        return None
    keypoints = tuple(
        None if points[i] < 0 or points[i + 1] < 0
        else (float(points[i]), float(points[i + 1]))
        for i in range(0, len(points), 2)
    )
    bbox = (float(obj.x), float(obj.y), float(obj.x + obj.w), float(obj.y + obj.h))
    if not passes_quality(bbox, keypoints, float(obj.score), frame_size, settings):
        return None
    return {
        "detection_index": detection_index,
        "bbox": bbox,
        "confidence": float(obj.score),
        "keypoints": keypoints,
    }
```

Quality checks use the numeric thresholds from the approved design: confidence 0.35, at least 6 visible points, at least 3 torso points, area ratio 0.015–0.80, outside-area ratio at most 0.20, duplicate IoU 0.45.

- [ ] **Step 4: Run the adapter tests and full suite**

Run: `python -m pytest tests/maixcam/test_pose_adapter.py -q && python -m pytest -q`

Expected: adapter tests pass and the total suite has zero failures.

- [ ] **Step 5: Commit**

```bash
git add platforms tests/maixcam/test_pose_adapter.py
git commit -m "feat: adapt Maix pose detections"
```

### Task 2: Lightweight tracking and risk state machine

**Files:**
- Create: `platforms/maixcam/track_core.py`
- Create: `platforms/maixcam/risk_core.py`
- Test: `tests/maixcam/test_track_core.py`
- Test: `tests/maixcam/test_risk_core.py`

- [ ] **Step 1: Write failing tracking tests**

```python
from platforms.maixcam.track_core import TrackManager


def observation(x=20.0, wrist=(48.0, 55.0)):
    points = [(50.0, 20.0)] * 17
    points[9] = wrist
    return {
        "detection_index": 0,
        "bbox": (x, 10.0, x + 100.0, 210.0),
        "confidence": 0.9,
        "keypoints": tuple(points),
    }


def test_track_id_survives_short_dropout():
    manager = TrackManager(min_confirmed_hits=1, max_missing_seconds=0.8)
    first = manager.update([observation()], 1.0)[0]
    predicted = manager.update([], 1.4)[0]
    recovered = manager.update([observation(x=24.0)], 1.5)[0]
    assert first["track_id"] == predicted["track_id"] == recovered["track_id"]
    assert predicted["predicted"] is True
    assert recovered["predicted"] is False


def test_track_count_is_bounded():
    manager = TrackManager(min_confirmed_hits=1, max_tracks=2)
    tracks = manager.update([observation(0), observation(110), observation(220)], 1.0)
    assert len(tracks) == 2
```

- [ ] **Step 2: Write failing risk tests**

```python
from platforms.maixcam.risk_core import RiskEngine


def track(track_id, *, wrist_near_ear=False, predicted=False, center_x=100.0):
    points = [None] * 17
    points[3] = (80.0, 45.0)
    points[5] = (78.0, 70.0)
    points[6] = (122.0, 70.0)
    points[7] = (75.0, 60.0)
    points[9] = (81.0, 47.0) if wrist_near_ear else (55.0, 110.0)
    points[11] = (85.0, 125.0)
    points[12] = (115.0, 125.0)
    points[13] = (88.0, 175.0)
    points[15] = (90.0, 215.0)
    return {
        "track_id": track_id,
        "bbox": (50.0, 20.0, 150.0, 220.0),
        "center": (center_x, 120.0),
        "body_height": 200.0,
        "confidence": 0.9,
        "keypoints": tuple(points),
        "predicted": predicted,
        "path_length": 0.0,
        "pose_motion": 0.0,
        "pose_motion_valid": True,
    }


def test_single_hand_near_ear_becomes_alert_after_hold():
    engine = RiskEngine(phone_seconds=1.0)
    candidate = engine.evaluate([track(1, wrist_near_ear=True)], (320, 224), 1.0)
    alert = engine.evaluate([track(1, wrist_near_ear=True)], (320, 224), 2.1)
    assert candidate[0]["state"] == "candidate"
    assert alert[0]["state"] == "alert"


def test_two_visible_people_become_multi_person_alert():
    engine = RiskEngine(multi_seconds=1.2)
    people = [track(1, center_x=90), track(2, center_x=210)]
    engine.evaluate(people, (320, 224), 1.0)
    result = engine.evaluate(people, (320, 224), 2.3)
    assert {item["risk"] for item in result if item["state"] == "alert"} == {"multi_person"}


def test_predicted_track_does_not_accumulate_phone_evidence():
    engine = RiskEngine(phone_seconds=1.0)
    engine.evaluate([track(1, wrist_near_ear=True)], (320, 224), 1.0)
    assert engine.evaluate([track(1, wrist_near_ear=True, predicted=True)], (320, 224), 2.2) == []
```

- [ ] **Step 3: Run tests and verify RED**

Run: `python -m pytest tests/maixcam/test_track_core.py tests/maixcam/test_risk_core.py -q`

Expected: imports fail because tracking and risk modules do not exist.

- [ ] **Step 4: Implement tracking**

`TrackManager.update(observations, timestamp)` returns dictionaries containing `track_id`, smoothed `bbox`, `keypoints`, `center`, `body_height`, `first_seen`, `last_seen`, `predicted`, `hits`, `confirmed`, `path_length`, `pose_motion`, and `pose_motion_valid`. Association greedily sorts all valid pairs by:

```python
cost = center_distance / body_scale + abs(log(area_ratio)) * 0.15
cost += mean_shared_keypoint_distance / body_scale * 0.25
```

Pairs above 1.15 are rejected. New observations are accepted in confidence order until `max_tracks=6`; unmatched tracks remain predicted for at most 0.8 seconds.

- [ ] **Step 5: Implement risk rules**

`RiskEngine.evaluate(tracks, frame_size, timestamp)` returns decision dictionaries. Implement phone-pose geometry with the exact approved inequalities, multi-person hold of 1.2 seconds, lingering hold of 20 seconds, movement thresholds 0.12 and 0.04, and 0.8-second alert release. Predicted tracks may retain an existing alert but never create or advance evidence.

Each decision has:

```python
{
    "track_id": 1,
    "risk": "phone_to_ear",
    "state": "candidate",
    "reason": "PHONE?",
    "duration": 0.4,
    "bbox": (50.0, 20.0, 150.0, 220.0),
}
```

- [ ] **Step 6: Run focused and full tests**

Run: `python -m pytest tests/maixcam/test_track_core.py tests/maixcam/test_risk_core.py -q && python -m pytest -q`

Expected: all focused tests and all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add platforms/maixcam/track_core.py platforms/maixcam/risk_core.py tests/maixcam
git commit -m "feat: track Maix poses and evaluate risks"
```

### Task 3: Event transitions and Maix screen rendering

**Files:**
- Create: `platforms/maixcam/event_store.py`
- Create: `platforms/maixcam/screen.py`
- Test: `tests/maixcam/test_event_store.py`
- Test: `tests/maixcam/test_screen.py`

- [ ] **Step 1: Write failing event-transition test**

```python
import json

from platforms.maixcam.event_store import EventStore


def test_writes_once_per_state_transition(tmp_path):
    store = EventStore(str(tmp_path / "events.jsonl"))
    alert = {"track_id": 1, "risk": "phone_to_ear", "state": "alert", "duration": 1.2}
    store.publish([alert], timestamp=10.0, people=1, metrics={"fps": 20.0})
    store.publish([alert], timestamp=10.1, people=1, metrics={"fps": 20.0})
    lines = (tmp_path / "events.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["risk"] == "phone_to_ear"
```

- [ ] **Step 2: Write failing renderer test with a fake image**

```python
from platforms.maixcam.screen import ScreenRenderer


class FakeImage:
    def __init__(self):
        self.calls = []

    def draw_rect(self, *args, **kwargs): self.calls.append(("rect", args, kwargs))
    def draw_line(self, *args, **kwargs): self.calls.append(("line", args, kwargs))
    def draw_circle(self, *args, **kwargs): self.calls.append(("circle", args, kwargs))
    def draw_string(self, *args, **kwargs): self.calls.append(("string", args, kwargs))


def test_alert_track_uses_red_and_draws_label():
    frame = FakeImage()
    track = {"track_id": 1, "bbox": (10, 20, 100, 200), "keypoints": (None,) * 17}
    decision = {"track_id": 1, "risk": "phone_to_ear", "state": "alert", "reason": "PHONE", "duration": 1.2}
    ScreenRenderer().render(frame, [track], [decision], {"fps": 20.0, "inference_ms": 20.0})
    assert any(call[0] == "rect" and call[2]["color"] == (255, 0, 0) for call in frame.calls)
    assert any(call[0] == "string" for call in frame.calls)
```

- [ ] **Step 3: Run tests and verify RED**

Run: `python -m pytest tests/maixcam/test_event_store.py tests/maixcam/test_screen.py -q`

Expected: imports fail because the modules do not exist.

- [ ] **Step 4: Implement event transitions and renderer**

`EventStore` remembers `(track_id, risk) -> state`, emits only candidate/alert/clear transitions, creates its parent directory, and writes compact UTF-8 JSON. `ScreenRenderer` uses Maix RGB tuples: yellow `(255, 255, 0)`, orange `(255, 165, 0)`, red `(255, 0, 0)`. It draws the standard 17-point skeleton and compact ASCII labels so no external font is required.

- [ ] **Step 5: Run focused and full tests**

Run: `python -m pytest tests/maixcam/test_event_store.py tests/maixcam/test_screen.py -q && python -m pytest -q`

Expected: zero failures.

- [ ] **Step 6: Commit**

```bash
git add platforms/maixcam/event_store.py platforms/maixcam/screen.py tests/maixcam
git commit -m "feat: render and log Maix risk alerts"
```

### Task 4: Maix runtime loop and host-side smoke test

**Files:**
- Create: `platforms/maixcam/main.py`
- Test: `tests/maixcam/test_main.py`

- [ ] **Step 1: Write a failing pure-Python pipeline smoke test**

```python
from platforms.maixcam.main import process_detections


def test_process_detections_returns_tracks_decisions_and_metrics():
    tracks, decisions = process_detections([], timestamp=1.0, frame_size=(320, 224))
    assert tracks == []
    assert decisions == []
```

- [ ] **Step 2: Run the test and verify RED**

Run: `python -m pytest tests/maixcam/test_main.py -q`

Expected: import fails because `main.py` does not exist.

- [ ] **Step 3: Implement the runtime**

At module import, `main.py` imports only local pure-Python modules. `run()` lazily imports MaixPy and executes:

```python
detector = nn.YOLO11(model=CONFIG["model_path"], dual_buff=True)
cam = camera.Camera(detector.input_width(), detector.input_height(), detector.input_format())
disp = display.Display() if CONFIG["display_enabled"] else None

while not app.need_exit() and (max_frames <= 0 or frame_count < max_frames):
    frame = cam.read()
    started = time.monotonic()
    objects = detector.detect(
        frame,
        conf_th=CONFIG["pose_confidence"],
        iou_th=CONFIG["pose_iou"],
        keypoint_th=CONFIG["keypoint_threshold"],
    )
    inference_ms = (time.monotonic() - started) * 1000.0
    observations = adapt_objects(objects, (detector.input_width(), detector.input_height()), CONFIG)
    tracks, decisions = pipeline.update(observations, time.monotonic())
    renderer.render(frame, tracks, decisions, metrics)
    event_store.publish(decisions, time.time(), len([t for t in tracks if not t["predicted"]]), metrics)
    if disp is not None:
        disp.show(frame)
```

Command-line options are `--max-frames`, `--no-display`, and `--test-timers`. The final `finally` block closes display and camera when supported. Every 30 frames it prints `frames`, `fps`, `infer_ms`, `people`, and `alerts` in one parseable line.

- [ ] **Step 4: Run host tests and compile all Maix files**

Run: `python -m pytest tests/maixcam/test_main.py -q && python -m compileall -q platforms/maixcam && python -m pytest -q`

Expected: compilation succeeds and all tests pass.

- [ ] **Step 5: Commit**

```bash
git add platforms/maixcam/main.py tests/maixcam/test_main.py
git commit -m "feat: add MaixCAM pose alert loop"
```

### Task 5: Deploy and prove the board loop

**Files:**
- Create: `platforms/maixcam/deploy.py`
- Create: `platforms/maixcam/deploy.ps1`
- Modify: `README.md`

- [ ] **Step 1: Implement deployment helper**

`deploy.py` accepts `--host`, `--user`, optional `--password`, and `--remote-dir`; when the password is omitted it uses `getpass.getpass()` instead of exposing a password in the process list. It creates the destination with SFTP, uploads only `.py` files from `platforms/maixcam`, and executes a remote compile check. `deploy.ps1` forwards the non-secret parameters:

```powershell
param(
    [string]$HostName = "192.168.31.114",
    [string]$UserName = "root",
    [string]$RemoteDir = "/root/poseguard_maix"
)
python "$PSScriptRoot/deploy.py" --host $HostName --user $UserName --remote-dir $RemoteDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

- [ ] **Step 2: Add exact run instructions**

Add to `README.md`:

````markdown
## MaixCAM Pro

Deploy:

```powershell
& platforms/maixcam/deploy.ps1
```

Board smoke test:

```sh
cd /root/poseguard_maix
python main.py --max-frames 300
```
````

- [ ] **Step 3: Run local verification**

Run: `python -m compileall -q platforms/maixcam && python -m pytest -q && git diff --check`

Expected: zero compile, test, or whitespace errors.

- [ ] **Step 4: Deploy without replacing the existing launcher**

Run: `python platforms/maixcam/deploy.py --host 192.168.31.114 --user root --remote-dir /root/poseguard_maix` and enter the password at its private prompt.

Expected: all Maix Python files upload and the remote compile check exits zero; `/root/main.py` keeps SHA-256 `8f4a04bf3122baa58418261f709999733ab0dc7078233c608a4858162f19f668`.

- [ ] **Step 5: Run 300 real frames and inspect the output**

Run remotely: `cd /root/poseguard_maix && python main.py --max-frames 300`

Expected: model reports 320×224 RGB input, the loop reaches frame 300, periodic metric lines are printed, and there is no uncaught traceback. Record measured FPS/inference time rather than substituting an estimate.

- [ ] **Step 6: Verify output and board cleanup**

Run remotely:

```sh
test -s /root/poseguard_maix/data/events.jsonl || true
ps -ef | grep '/root/poseguard_maix/main.py' | grep -v grep || true
sha256sum /root/main.py
```

Expected: no leftover smoke-test process, and the existing launcher hash is unchanged.

- [ ] **Step 7: Commit**

```bash
git add platforms/maixcam/deploy.py platforms/maixcam/deploy.ps1 README.md
git commit -m "docs: add MaixCAM deployment workflow"
```
