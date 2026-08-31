import numpy as np
import pytest

from poseguard import app
from poseguard.app import (
    ResilientPhoneBackend,
    update_alert_transitions,
    update_recent_events,
)
from poseguard.types import RiskDecision, RiskKind, RiskState


class FailingPhoneBackend:
    def __init__(self):
        self.calls = 0

    def find(self, frame, regions):
        self.calls += 1
        raise RuntimeError("phone model unavailable")


class InvalidPhoneResultBackend:
    def __init__(self):
        self.calls = 0

    def find(self, frame, regions):
        self.calls += 1
        raise ValueError("malformed phone result")


def test_optional_phone_failure_disables_backend_and_keeps_processing(capsys):
    backend = FailingPhoneBackend()
    runner = ResilientPhoneBackend(backend)
    frame = np.zeros((32, 32, 3), dtype=np.uint8)

    assert runner.find(frame, [(0.0, 0.0, 10.0, 10.0)]) == ()
    assert runner.find(frame, [(0.0, 0.0, 10.0, 10.0)]) == ()

    assert backend.calls == 1
    assert runner.available is False
    assert capsys.readouterr().err.count("phone model unavailable") == 1


def test_optional_phone_result_error_also_degrades_once(capsys):
    backend = InvalidPhoneResultBackend()
    runner = ResilientPhoneBackend(backend)
    frame = np.zeros((32, 32, 3), dtype=np.uint8)

    assert runner.find(frame, []) == ()
    assert runner.find(frame, []) == ()

    assert backend.calls == 1
    assert runner.available is False
    assert capsys.readouterr().err.count("malformed phone result") == 1


def test_open_capture_releases_all_failed_windows_handles(monkeypatch):
    captures = []

    class FailedCapture:
        def __init__(self):
            self.released = False

        def isOpened(self):
            return False

        def release(self):
            self.released = True

    def create_capture(*_args):
        capture = FailedCapture()
        captures.append(capture)
        return capture

    monkeypatch.setattr(app.sys, "platform", "win32")
    monkeypatch.setattr(app.cv2, "VideoCapture", create_capture)

    with pytest.raises(RuntimeError, match="Cannot open video source"):
        app.open_capture(0, {"buffer_size": 1, "width": 640, "height": 480, "fps": 30})

    assert len(captures) == 2
    assert all(capture.released for capture in captures)


def test_predicted_frame_does_not_duplicate_recovered_alert_event():
    decision = RiskDecision(
        track_id=7,
        kind=RiskKind.LINGERING,
        state=RiskState.ALERT,
        reason="risk",
        confidence=0.9,
        bbox=(0.0, 0.0, 10.0, 20.0),
    )
    new_events, remembered = update_alert_transitions((decision,), set(), set())
    assert new_events == (decision,)

    new_events, remembered = update_alert_transitions((), remembered, {7})
    assert new_events == ()

    new_events, remembered = update_alert_transitions((decision,), remembered, set())
    assert new_events == ()

    _, released = update_alert_transitions((), remembered, set())
    retriggered, _ = update_alert_transitions((decision,), released, set())
    assert retriggered == (decision,)


def test_recent_event_summary_keeps_latest_three_alerts():
    events = tuple(
        RiskDecision(
            track_id=index,
            kind=RiskKind.LINGERING,
            state=RiskState.ALERT,
            reason=f"risk-{index}",
            confidence=0.9,
            bbox=(0.0, 0.0, 10.0, 20.0),
        )
        for index in range(1, 5)
    )

    summaries = update_recent_events((), events, limit=3)

    assert tuple(text for _, text in summaries) == (
        "ID 2: risk-2",
        "ID 3: risk-3",
        "ID 4: risk-4",
    )


def test_recent_events_deduplicate_by_target_and_risk_kind():
    first = RiskDecision(
        track_id=7,
        kind=RiskKind.LINGERING,
        state=RiskState.ALERT,
        reason="疑似长时间停留",
        confidence=0.9,
        bbox=(0.0, 0.0, 10.0, 20.0),
    )
    refreshed = RiskDecision(
        track_id=7,
        kind=RiskKind.LINGERING,
        state=RiskState.ALERT,
        reason="疑似长时间停留（更新）",
        confidence=0.9,
        bbox=(0.0, 0.0, 10.0, 20.0),
    )
    other_kind = RiskDecision(
        track_id=7,
        kind=RiskKind.PHONE,
        state=RiskState.ALERT,
        reason="疑似与他人通话",
        confidence=0.9,
        bbox=(0.0, 0.0, 10.0, 20.0),
    )

    summaries = update_recent_events((), (first,))
    summaries = update_recent_events(summaries, (refreshed, other_kind))

    assert len(summaries) == 2
    assert ((7, RiskKind.LINGERING.value), "ID 7: 疑似长时间停留（更新）") in summaries
    assert ((7, RiskKind.PHONE.value), "ID 7: 疑似与他人通话") in summaries
