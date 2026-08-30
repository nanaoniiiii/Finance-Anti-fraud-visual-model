import json

from platforms.maixcam.event_store import EventStore


def decision(state="alert", risk="phone_to_ear", track_id=1):
    return {
        "track_id": track_id,
        "risk": risk,
        "state": state,
        "reason": "PHONE",
        "duration": 1.2,
        "bbox": (10.0, 20.0, 100.0, 200.0),
    }


def read_events(path):
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


def test_writes_once_per_state_transition(tmp_path):
    path = tmp_path / "nested" / "events.jsonl"
    store = EventStore(str(path))
    alert = decision()

    store.publish([alert], timestamp=10.0, people=1, metrics={"fps": 20.0})
    store.publish([alert], timestamp=10.1, people=1, metrics={"fps": 20.0})

    events = read_events(path)
    assert len(events) == 1
    assert events[0]["risk"] == "phone_to_ear"
    assert events[0]["state"] == "alert"


def test_candidate_to_alert_writes_two_transitions(tmp_path):
    path = tmp_path / "events.jsonl"
    store = EventStore(str(path))

    store.publish([decision("candidate")], 10.0, 1, {})
    store.publish([decision("alert")], 11.1, 1, {})

    assert [event["state"] for event in read_events(path)] == [
        "candidate",
        "alert",
    ]


def test_missing_decision_writes_clear_transition(tmp_path):
    path = tmp_path / "events.jsonl"
    store = EventStore(str(path))
    store.publish([decision()], 10.0, 1, {})

    store.publish([], 11.0, 0, {})

    events = read_events(path)
    assert [event["state"] for event in events] == ["alert", "clear"]
    assert events[-1]["track_id"] == 1


def test_separate_risks_keep_separate_state(tmp_path):
    path = tmp_path / "events.jsonl"
    store = EventStore(str(path))

    store.publish(
        [decision(risk="phone_to_ear"), decision(risk="multi_person")],
        10.0,
        2,
        {"fps": 18.5, "inference_ms": 19.0},
    )

    assert {event["risk"] for event in read_events(path)} == {
        "phone_to_ear",
        "multi_person",
    }
