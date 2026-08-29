import numpy as np

from poseguard.types import Keypoint, PersonTrack, RiskDecision, RiskKind, RiskState
from poseguard.ui.overlay import OverlayRenderer, is_exit_key


def _track():
    points = tuple(Keypoint(40 + index, 50 + index * 2, 0.9) for index in range(17))
    return PersonTrack(
        track_id=1,
        bbox=(20, 20, 120, 220),
        confidence=0.9,
        keypoints=points,
        center=(70, 120),
        body_height=200,
        first_seen=0.0,
        last_seen=1.0,
    )


def test_renderer_preserves_input_and_shape_for_alert():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    original = frame.copy()
    decision = RiskDecision(
        track_id=1,
        kind=RiskKind.PHONE,
        state=RiskState.ALERT,
        reason="疑似贴耳通话",
        confidence=0.9,
        bbox=(20, 20, 120, 220),
        duration_seconds=1.2,
    )

    rendered = OverlayRenderer().render(
        frame,
        (_track(),),
        (decision,),
        {"fps": 20.0, "inference_ms": 35.0},
    )

    assert rendered.shape == frame.shape
    assert np.array_equal(frame, original)
    assert np.any(rendered != original)


def test_exit_keys_accept_q_and_escape_only():
    assert is_exit_key(ord("q"))
    assert is_exit_key(ord("Q"))
    assert is_exit_key(27)
    assert not is_exit_key(ord("p"))
