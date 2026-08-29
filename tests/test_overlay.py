import numpy as np
import sys

from poseguard.types import Keypoint, PersonTrack, RiskDecision, RiskKind, RiskState
from poseguard.ui.overlay import (
    OverlayRenderer,
    UnicodeTextPainter,
    is_exit_key,
    split_track_label,
    summarize_track_decisions,
)


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


def test_track_summary_combines_all_risk_reasons():
    decisions = (
        RiskDecision(
            track_id=1,
            kind=RiskKind.PHONE,
            state=RiskState.ALERT,
            reason="疑似贴耳通话",
            confidence=0.9,
            bbox=(20, 20, 120, 220),
            duration_seconds=1.2,
        ),
        RiskDecision(
            track_id=1,
            kind=RiskKind.LINGERING,
            state=RiskState.ALERT,
            reason="疑似长时间停留",
            confidence=0.9,
            bbox=(20, 20, 120, 220),
            duration_seconds=21.0,
        ),
    )

    label, strongest = summarize_track_decisions(1, decisions)

    assert "疑似风险行为" in label
    assert "疑似贴耳通话" in label
    assert "疑似长时间停留" in label
    assert "21.0s" in label
    assert strongest.state is RiskState.ALERT


def test_long_risk_label_is_split_into_at_most_two_drawable_lines():
    label = (
        "ID 1 | 疑似风险行为 | 疑似贴耳通话 + 疑似长时间停留 + "
        "疑似多人进入监控区 | 21.0s"
    )

    lines = split_track_label(label)

    assert len(lines) == 2
    assert "ID 1" in lines[0]
    assert "21.0s" in lines[-1]


def test_renderer_accepts_recent_event_summary():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)

    rendered = OverlayRenderer().render(
        frame,
        (_track(),),
        (),
        {"fps": 20.0, "inference_ms": 35.0},
        recent_events=("ID 1: 疑似贴耳通话",),
    )

    assert rendered.shape == frame.shape


def test_windows_overlay_loads_a_unicode_font():
    painter = UnicodeTextPainter()

    if sys.platform.startswith("win"):
        assert painter.unicode_font_available
