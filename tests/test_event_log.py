import json

import numpy as np

from poseguard.backends.yolo_phone import YoloPhoneBackend, convert_phone_result
from poseguard.backends.yolo_pose import convert_pose_result
from poseguard.io.event_log import EventLogger
from poseguard.types import RiskDecision, RiskKind, RiskState


class _Tensor:
    def __init__(self, value):
        self.value = np.asarray(value)

    def cpu(self):
        return self

    def numpy(self):
        return self.value


class _Boxes:
    def __init__(self, boxes, confidence, classes=None):
        self.xyxy = _Tensor(boxes)
        self.conf = _Tensor(confidence)
        self.cls = _Tensor(classes if classes is not None else [0] * len(boxes))


class _Keypoints:
    def __init__(self, xy, confidence):
        self.xy = _Tensor(xy)
        self.conf = _Tensor(confidence)


class _Result:
    def __init__(self, boxes, keypoints=None):
        self.boxes = boxes
        self.keypoints = keypoints


def test_pose_result_converts_to_seventeen_backend_neutral_keypoints():
    xy = [[[float(index), float(index + 1)] for index in range(17)]]
    confidence = [[0.9] * 16 + [0.1]]
    result = _Result(_Boxes([[1, 2, 101, 202]], [0.88]), _Keypoints(xy, confidence))

    observations = convert_pose_result(result, keypoint_confidence=0.25)

    assert len(observations) == 1
    assert len(observations[0].keypoints) == 17
    assert observations[0].keypoints[0].x == 0.0
    assert observations[0].keypoints[16] is None


def test_phone_result_filters_coco_phone_class_and_offsets_crop():
    result = _Result(_Boxes([[2, 3, 12, 23], [0, 0, 5, 5]], [0.8, 0.9], [67, 0]))

    phones = convert_phone_result(result, phone_class=67, offset=(100, 50))

    assert len(phones) == 1
    assert phones[0].bbox == (102.0, 53.0, 112.0, 73.0)


def test_disabled_phone_backend_returns_empty_without_loading_model():
    backend = YoloPhoneBackend("missing.pt", enabled=False)

    assert backend.find(np.zeros((10, 10, 3), dtype=np.uint8), ()) == ()
    assert backend.model_loaded is False


def test_event_log_contains_no_raw_frame_or_keypoints(tmp_path):
    path = tmp_path / "events.jsonl"
    decision = RiskDecision(
        track_id=7,
        kind=RiskKind.PHONE,
        state=RiskState.ALERT,
        reason="疑似贴耳通话",
        confidence=0.86,
        bbox=(1, 2, 30, 40),
        duration_seconds=1.2,
    )

    with EventLogger(path) as logger:
        logger.write(decision, timestamp=123.4)

    payload = json.loads(path.read_text(encoding="utf-8").strip())
    assert payload["track_id"] == 7
    assert payload["risk_kind"] == "phone_to_ear"
    assert payload["state"] == "alert"
    assert "frame" not in payload
    assert "image" not in payload
    assert "keypoints" not in payload
