import json

import pytest

from poseguard.config import default_config, load_config, validate_config


def test_default_config_uses_approved_risk_thresholds():
    config = default_config()

    assert config["risk"]["lingering_seconds"] == 20.0
    assert config["risk"]["multi_person_seconds"] == 1.5
    assert config["risk"]["phone_confirm_seconds"] == 1.0


def test_invalid_threshold_is_rejected(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(
        json.dumps({"risk": {"lingering_seconds": -1}}),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="lingering_seconds"):
        load_config(path)


def test_missing_phone_model_is_allowed_when_optional():
    config = default_config()
    config["features"]["phone_detection"] = False
    config["models"]["phone_path"] = ""

    assert validate_config(config) == []


def test_confidence_outside_unit_interval_is_rejected():
    config = default_config()
    config["models"]["pose_confidence"] = 1.1

    assert any("pose_confidence" in item for item in validate_config(config))


def test_json_override_merges_with_defaults(tmp_path):
    path = tmp_path / "custom.json"
    path.write_text(
        json.dumps({"risk": {"lingering_seconds": 12.0}}),
        encoding="utf-8",
    )

    config = load_config(path)

    assert config["risk"]["lingering_seconds"] == 12.0
    assert config["risk"]["multi_person_seconds"] == 1.5


def test_non_object_config_section_is_reported_without_crashing():
    config = default_config()
    config["risk"] = []

    errors = validate_config(config)

    assert "risk must be an object" in errors


def test_tracking_and_ratio_ranges_are_validated():
    config = default_config()
    config["tracking"]["smoothing_alpha"] = 1.5
    config["tracking"]["max_missing_frames"] = -1
    config["risk"]["wrist_ear_ratio"] = 0.0

    errors = validate_config(config)

    assert any("smoothing_alpha" in item for item in errors)
    assert any("max_missing_frames" in item for item in errors)
    assert any("wrist_ear_ratio" in item for item in errors)
