"""Validated runtime configuration for desktop and embedded adapters."""

from __future__ import annotations

import copy
import json
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
    "tracking": {
        "minimum_confidence": 0.35,
        "max_missing_frames": 8,
        "smoothing_alpha": 0.55,
        "maximum_match_cost": 1.15,
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
    risk = config.get("risk", {})
    models = config.get("models", {})
    features = config.get("features", {})

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

    tracking = config.get("tracking", {})
    confidence = tracking.get("minimum_confidence")
    if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        errors.append("tracking.minimum_confidence must be between 0 and 1")

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
