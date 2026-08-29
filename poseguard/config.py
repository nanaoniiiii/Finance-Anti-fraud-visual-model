"""Validated runtime configuration for desktop and embedded adapters."""

from __future__ import annotations

import copy
import json
import math
from numbers import Real
from pathlib import Path
from typing import Any, Mapping


DEFAULT_CONFIG: dict[str, Any] = {
    "source": 0,
    "display": {"enabled": True, "max_width": 960},
    "camera": {"width": 1280, "height": 720, "fps": 30, "buffer_size": 1},
    "models": {
        "pose_path": "models/yolo11n-pose.pt",
        "phone_path": "models/yolo11n.pt",
        "pose_confidence": 0.35,
        "phone_confidence": 0.30,
        "phone_class": 67,
    },
    "features": {"phone_detection": True, "event_logging": True},
    "quality": {
        "min_visible_keypoints": 6,
        "min_torso_keypoints": 3,
        "min_bbox_area_ratio": 0.015,
        "max_bbox_area_ratio": 0.75,
        "max_outside_ratio": 0.20,
        "duplicate_iou_threshold": 0.45,
        "duplicate_center_body_ratio": 0.25,
        "duplicate_keypoint_body_ratio": 0.05,
    },
    "tracking": {
        "minimum_confidence": 0.35,
        "max_missing_frames": 8,
        "smoothing_alpha": 0.55,
        "maximum_match_cost": 1.15,
        "min_confirmed_hits": 3,
    },
    "risk": {
        "region": [0.05, 0.05, 0.95, 0.95],
        "lingering_seconds": 20.0,
        "multi_person_seconds": 1.5,
        "phone_confirm_seconds": 1.0,
        "alert_release_seconds": 0.8,
        "wrist_ear_ratio": 0.13,
        "nearby_body_ratio": 0.8,
        "lingering_max_speed_ratio": 0.12,
    },
    "output": {"directory": "runs", "event_filename": "events.jsonl"},
}


def default_config() -> dict[str, Any]:
    return copy.deepcopy(DEFAULT_CONFIG)


def _merge(base: dict[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = value
    return base


def validate_config(config: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []

    def finite_real(value: Any) -> bool:
        return (
            isinstance(value, Real)
            and not isinstance(value, bool)
            and math.isfinite(value)
        )

    def section(name: str) -> Mapping[str, Any]:
        value = config.get(name, {})
        if not isinstance(value, Mapping):
            errors.append(f"{name} must be an object")
            return {}
        return value

    risk = section("risk")
    models = section("models")
    features = section("features")
    quality = section("quality")
    tracking = section("tracking")
    camera = section("camera")
    display = section("display")
    output = section("output")

    for name in (
        "lingering_seconds",
        "multi_person_seconds",
        "phone_confirm_seconds",
        "alert_release_seconds",
    ):
        value = risk.get(name)
        if not isinstance(value, (int, float)) or value < 0:
            errors.append(f"risk.{name} must be a non-negative number")

    for name in ("pose_confidence", "phone_confidence"):
        value = models.get(name)
        if not isinstance(value, (int, float)) or not 0 <= value <= 1:
            errors.append(f"models.{name} must be between 0 and 1")

    for name, maximum in (
        ("min_visible_keypoints", 17),
        ("min_torso_keypoints", 4),
    ):
        value = quality.get(name)
        if type(value) is not int or not 0 <= value <= maximum:
            errors.append(f"quality.{name} must be an integer between 0 and {maximum}")

    for name in (
        "min_bbox_area_ratio",
        "max_bbox_area_ratio",
        "max_outside_ratio",
        "duplicate_iou_threshold",
    ):
        value = quality.get(name)
        if not finite_real(value) or not 0 <= value <= 1:
            errors.append(f"quality.{name} must be a finite number between 0 and 1")

    for name in (
        "duplicate_center_body_ratio",
        "duplicate_keypoint_body_ratio",
    ):
        value = quality.get(name)
        if not finite_real(value) or value < 0:
            errors.append(f"quality.{name} must be a finite non-negative number")

    minimum_area = quality.get("min_bbox_area_ratio")
    maximum_area = quality.get("max_bbox_area_ratio")
    if (
        finite_real(minimum_area)
        and finite_real(maximum_area)
        and 0 <= minimum_area <= 1
        and 0 <= maximum_area <= 1
        and minimum_area > maximum_area
    ):
        errors.append(
            "quality.min_bbox_area_ratio must not exceed "
            "quality.max_bbox_area_ratio"
        )

    region = risk.get("region")
    if (
        not isinstance(region, (list, tuple))
        or len(region) != 4
        or not all(isinstance(value, (int, float)) for value in region)
        or not (0 <= region[0] < region[2] <= 1)
        or not (0 <= region[1] < region[3] <= 1)
    ):
        errors.append("risk.region must be [x1, y1, x2, y2] within 0..1")

    if not models.get("pose_path"):
        errors.append("models.pose_path is required")
    if features.get("phone_detection", True) and not models.get("phone_path"):
        errors.append("models.phone_path is required when phone detection is enabled")

    confidence = tracking.get("minimum_confidence")
    if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        errors.append("tracking.minimum_confidence must be between 0 and 1")

    alpha = tracking.get("smoothing_alpha")
    if not isinstance(alpha, (int, float)) or not 0 < alpha <= 1:
        errors.append("tracking.smoothing_alpha must be within (0, 1]")
    missing_frames = tracking.get("max_missing_frames")
    if not isinstance(missing_frames, int) or missing_frames < 0:
        errors.append("tracking.max_missing_frames must be a non-negative integer")
    maximum_cost = tracking.get("maximum_match_cost")
    if not isinstance(maximum_cost, (int, float)) or maximum_cost <= 0:
        errors.append("tracking.maximum_match_cost must be positive")
    min_confirmed_hits = tracking.get("min_confirmed_hits")
    if type(min_confirmed_hits) is not int or min_confirmed_hits < 1:
        errors.append("tracking.min_confirmed_hits must be a positive integer")

    for name in ("wrist_ear_ratio", "nearby_body_ratio"):
        value = risk.get(name)
        if not isinstance(value, (int, float)) or value <= 0:
            errors.append(f"risk.{name} must be positive")
    speed_ratio = risk.get("lingering_max_speed_ratio")
    if not isinstance(speed_ratio, (int, float)) or speed_ratio < 0:
        errors.append("risk.lingering_max_speed_ratio must be non-negative")

    for name in ("width", "height", "fps", "buffer_size"):
        value = camera.get(name)
        if not isinstance(value, int) or value <= 0:
            errors.append(f"camera.{name} must be a positive integer")
    max_width = display.get("max_width")
    if not isinstance(max_width, int) or max_width <= 0:
        errors.append("display.max_width must be a positive integer")
    if not isinstance(output.get("directory"), str) or not output.get("directory"):
        errors.append("output.directory must be a non-empty string")
    if not isinstance(output.get("event_filename"), str) or not output.get("event_filename"):
        errors.append("output.event_filename must be a non-empty string")

    return errors


def load_config(path: str | Path) -> dict[str, Any]:
    loaded = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError("configuration root must be a JSON object")
    config = _merge(default_config(), loaded)
    errors = validate_config(config)
    if errors:
        raise ValueError("; ".join(errors))
    return config


def apply_cli_overrides(config: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    result = copy.deepcopy(config)
    if overrides.get("source") is not None:
        result["source"] = overrides["source"]
    if overrides.get("pose_model"):
        result["models"]["pose_path"] = overrides["pose_model"]
    if overrides.get("phone_model"):
        result["models"]["phone_path"] = overrides["phone_model"]
    if overrides.get("disable_phone"):
        result["features"]["phone_detection"] = False
    if overrides.get("no_display"):
        result["display"]["enabled"] = False
    if overrides.get("output_dir"):
        result["output"]["directory"] = overrides["output_dir"]
    errors = validate_config(result)
    if errors:
        raise ValueError("; ".join(errors))
    return result
