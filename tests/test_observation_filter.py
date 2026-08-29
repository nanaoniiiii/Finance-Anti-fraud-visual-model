import pytest
import numpy as np

from poseguard import app
from poseguard.config import default_config, validate_config
from poseguard.tracking.observation_filter import PoseObservationFilter
from poseguard.types import Keypoint, PersonObservation


FRAME_SIZE = (640, 480)


def _observation(
    detection_index: int,
    bbox: tuple[float, float, float, float],
    confidence: float,
    visible_indices: tuple[int, ...],
    *,
    offset: tuple[float, float] = (0.0, 0.0),
) -> PersonObservation:
    x1, y1, x2, y2 = bbox
    width = x2 - x1
    height = y2 - y1
    points = tuple(
        Keypoint(
            x=x1 + width * (0.2 + (index % 5) * 0.15) + offset[0],
            y=y1 + height * (0.15 + (index // 5) * 0.25) + offset[1],
            confidence=0.9,
        )
        if index in visible_indices
        else None
        for index in range(17)
    )
    return PersonObservation(detection_index, bbox, confidence, points)


def test_low_keypoint_clutter_is_rejected():
    clutter = _observation(
        0,
        (120.0, 100.0, 300.0, 320.0),
        0.92,
        (5, 6, 11, 12, 15),
    )

    assert PoseObservationFilter().filter((clutter,), FRAME_SIZE) == ()


def test_valid_horizontal_side_pose_survives():
    side_pose = _observation(
        1,
        (60.0, 170.0, 580.0, 310.0),
        0.58,
        (0, 5, 6, 7, 9, 11, 12, 15),
    )

    assert PoseObservationFilter().filter((side_pose,), FRAME_SIZE) == (side_pose,)


def test_overlapping_skeleton_equivalent_observations_keep_higher_quality():
    lower_quality = _observation(
        2,
        (100.0, 80.0, 300.0, 400.0),
        0.52,
        (0, 5, 6, 7, 8, 11, 12, 13),
    )
    higher_quality = _observation(
        3,
        (104.0, 82.0, 304.0, 402.0),
        0.88,
        tuple(range(17)),
        offset=(-4.0, -2.0),
    )

    filtered = PoseObservationFilter().filter(
        (lower_quality, higher_quality),
        FRAME_SIZE,
    )

    assert filtered == (higher_quality,)


def test_overlapping_same_pose_people_separated_by_tenth_body_scale_survive():
    first = _observation(
        4,
        (100.0, 80.0, 300.0, 400.0),
        0.82,
        tuple(range(17)),
    )
    second = _observation(
        5,
        (132.0, 80.0, 332.0, 400.0),
        0.78,
        tuple(range(17)),
    )

    assert PoseObservationFilter().filter((first, second), FRAME_SIZE) == (
        first,
        second,
    )


@pytest.mark.parametrize(
    "bbox",
    (
        (100.0, 100.0, 100.0, 300.0),
        (100.0, 100.0, 300.0, 100.0),
        (300.0, 100.0, 100.0, 300.0),
    ),
)
def test_nonpositive_bboxes_are_rejected(bbox):
    observation = _observation(0, bbox, 0.9, tuple(range(17)))

    assert PoseObservationFilter().filter((observation,), FRAME_SIZE) == ()


@pytest.mark.parametrize(
    "bbox",
    (
        (10.0, 10.0, 20.0, 20.0),
        (0.0, 0.0, 640.0, 480.0),
    ),
)
def test_implausible_clipped_bbox_area_is_rejected(bbox):
    observation = _observation(0, bbox, 0.9, tuple(range(17)))

    assert PoseObservationFilter().filter((observation,), FRAME_SIZE) == ()


def test_bbox_mostly_outside_frame_is_rejected():
    observation = _observation(
        0,
        (-50.0, 100.0, 150.0, 300.0),
        0.9,
        tuple(range(17)),
    )

    assert PoseObservationFilter().filter((observation,), FRAME_SIZE) == ()


def test_similar_skeletons_need_spatial_closeness_to_be_duplicates():
    first = _observation(
        0,
        (40.0, 100.0, 200.0, 360.0),
        0.7,
        tuple(range(17)),
    )
    far_bbox = (400.0, 100.0, 560.0, 360.0)
    second = PersonObservation(1, far_bbox, 0.8, first.keypoints)

    assert PoseObservationFilter().filter((first, second), FRAME_SIZE) == (
        first,
        second,
    )


def test_overlapping_boxes_need_similar_skeletons_to_be_duplicates():
    first = _observation(
        0,
        (100.0, 80.0, 300.0, 400.0),
        0.7,
        tuple(range(17)),
    )
    different_pose = _observation(
        1,
        (104.0, 82.0, 304.0, 402.0),
        0.8,
        tuple(range(17)),
        offset=(80.0, 0.0),
    )

    assert PoseObservationFilter().filter((first, different_pose), FRAME_SIZE) == (
        first,
        different_pose,
    )


def test_duplicate_comparison_requires_four_shared_visible_keypoints():
    first = _observation(
        0,
        (100.0, 80.0, 300.0, 400.0),
        0.7,
        (5, 6, 11, 12, 13, 14),
    )
    second = _observation(
        1,
        (100.0, 80.0, 300.0, 400.0),
        0.8,
        (0, 1, 2, 5, 6, 11),
    )

    assert PoseObservationFilter().filter((first, second), FRAME_SIZE) == (
        first,
        second,
    )


def test_center_closeness_can_suppress_duplicates_with_low_iou():
    compact = _observation(
        0,
        (160.0, 120.0, 320.0, 360.0),
        0.7,
        tuple(range(17)),
    )
    enclosing = PersonObservation(
        1,
        (80.0, 40.0, 400.0, 440.0),
        0.9,
        compact.keypoints,
    )

    assert PoseObservationFilter().filter((compact, enclosing), FRAME_SIZE) == (
        enclosing,
    )


def test_default_config_exposes_observation_quality_thresholds():
    assert default_config()["quality"] == {
        "min_visible_keypoints": 6,
        "min_torso_keypoints": 3,
        "min_bbox_area_ratio": 0.015,
        "max_bbox_area_ratio": 0.75,
        "max_outside_ratio": 0.20,
        "duplicate_iou_threshold": 0.45,
        "duplicate_center_body_ratio": 0.25,
        "duplicate_keypoint_body_ratio": 0.05,
    }


@pytest.mark.parametrize(
    ("name", "value"),
    (
        ("min_visible_keypoints", 18),
        ("min_torso_keypoints", 5),
        ("min_bbox_area_ratio", -0.1),
        ("max_bbox_area_ratio", 1.1),
        ("max_outside_ratio", 1.1),
        ("duplicate_iou_threshold", -0.1),
        ("duplicate_center_body_ratio", -0.1),
        ("duplicate_keypoint_body_ratio", -0.1),
    ),
)
def test_invalid_observation_quality_threshold_is_rejected(name, value):
    config = default_config()
    config["quality"][name] = value

    assert any(f"quality.{name}" in error for error in validate_config(config))


@pytest.mark.parametrize(
    "name",
    ("min_visible_keypoints", "min_torso_keypoints"),
)
@pytest.mark.parametrize("value", (True, False))
def test_quality_count_thresholds_reject_booleans(name, value):
    config = default_config()
    config["quality"][name] = value

    assert any(f"quality.{name}" in error for error in validate_config(config))


@pytest.mark.parametrize(
    "name",
    (
        "min_bbox_area_ratio",
        "max_bbox_area_ratio",
        "max_outside_ratio",
        "duplicate_iou_threshold",
        "duplicate_center_body_ratio",
        "duplicate_keypoint_body_ratio",
    ),
)
@pytest.mark.parametrize(
    "value",
    (True, False, float("nan"), float("inf")),
    ids=("true", "false", "nan", "inf"),
)
def test_quality_ratios_reject_boolean_and_nonfinite_values(name, value):
    config = default_config()
    config["quality"][name] = value

    assert any(f"quality.{name}" in error for error in validate_config(config))


def test_bbox_area_ratio_range_must_not_be_reversed():
    config = default_config()
    config["quality"]["min_bbox_area_ratio"] = 0.8

    assert any("min_bbox_area_ratio" in error for error in validate_config(config))


def test_non_object_quality_section_is_reported_without_crashing():
    config = default_config()
    config["quality"] = []

    assert "quality must be an object" in validate_config(config)


def test_run_filters_pose_observations_before_tracking(monkeypatch):
    clutter = _observation(
        0,
        (120.0, 100.0, 300.0, 320.0),
        0.92,
        (5, 6, 11, 12, 15),
    )
    seen = {}
    config = default_config()
    config["display"]["enabled"] = False
    config["features"]["phone_detection"] = False
    config["features"]["event_logging"] = False

    class FakePoseBackend:
        def __init__(self, *_args, **_kwargs):
            pass

        def infer(self, _frame):
            return (clutter,)

    class FakePhoneBackend:
        def __init__(self, *_args, **_kwargs):
            pass

        def find(self, _frame, _regions):
            return ()

    class RecordingTracker:
        def __init__(self, **_kwargs):
            pass

        def update(self, observations, _timestamp, _frame_size):
            seen["observations"] = tuple(observations)
            return ()

    class FakeRiskEngine:
        def __init__(self, **_kwargs):
            pass

        def evaluate(self, *_args):
            return ()

    class FakeCapture:
        def read(self):
            return True, np.zeros((480, 640, 3), dtype=np.uint8)

        def release(self):
            pass

    monkeypatch.setattr(app, "load_config", lambda _path: config)
    monkeypatch.setattr(app, "YoloPoseBackend", FakePoseBackend)
    monkeypatch.setattr(app, "YoloPhoneBackend", FakePhoneBackend)
    monkeypatch.setattr(app, "PersonTrackManager", RecordingTracker)
    monkeypatch.setattr(app, "RiskRuleEngine", FakeRiskEngine)
    monkeypatch.setattr(app, "open_capture", lambda _source, _camera: FakeCapture())
    monkeypatch.setattr(app.cv2, "destroyAllWindows", lambda: None)

    args = app.build_parser().parse_args(["--no-display", "--max-frames", "1"])

    assert app.run(args) == 0
    assert seen["observations"] == ()
