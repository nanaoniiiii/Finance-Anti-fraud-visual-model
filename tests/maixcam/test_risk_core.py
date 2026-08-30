from platforms.maixcam.risk_core import RiskEngine


def pose_points(*, left_phone=False, right_phone=False):
    points = [None] * 17
    points[0] = (100.0, 35.0)
    points[3] = (80.0, 45.0)
    points[4] = (120.0, 45.0)
    points[5] = (82.0, 75.0)
    points[6] = (118.0, 75.0)
    points[7] = (70.0, 75.0)
    points[8] = (130.0, 75.0)
    points[9] = (81.0, 48.0) if left_phone else (55.0, 115.0)
    points[10] = (119.0, 48.0) if right_phone else (145.0, 115.0)
    points[11] = (88.0, 130.0)
    points[12] = (112.0, 130.0)
    points[13] = (90.0, 180.0)
    points[14] = (110.0, 180.0)
    points[15] = (92.0, 215.0)
    points[16] = (108.0, 215.0)
    return tuple(points)


def track(
    track_id,
    *,
    left_phone=False,
    right_phone=False,
    predicted=False,
    center_x=100.0,
    path_length=0.0,
    pose_motion=0.0,
):
    return {
        "track_id": track_id,
        "bbox": (50.0, 20.0, 150.0, 220.0),
        "center": (center_x, 120.0),
        "body_height": 200.0,
        "confidence": 0.9,
        "keypoints": pose_points(
            left_phone=left_phone,
            right_phone=right_phone,
        ),
        "predicted": predicted,
        "path_length": path_length,
        "pose_motion": pose_motion,
        "pose_motion_valid": True,
    }


def decisions_for(result, risk):
    return [item for item in result if item["risk"] == risk]


def test_single_hand_near_ear_becomes_alert_after_hold():
    engine = RiskEngine(phone_seconds=1.0)

    candidate = engine.evaluate([track(1, left_phone=True)], (320, 224), 1.0)
    alert = engine.evaluate([track(1, left_phone=True)], (320, 224), 2.1)

    assert decisions_for(candidate, "phone_to_ear")[0]["state"] == "candidate"
    assert decisions_for(alert, "phone_to_ear")[0]["state"] == "alert"


def test_double_hand_near_ears_is_not_phone_candidate():
    engine = RiskEngine(phone_seconds=1.0)

    result = engine.evaluate(
        [track(1, left_phone=True, right_phone=True)],
        (320, 224),
        1.0,
    )

    assert decisions_for(result, "phone_to_ear") == []


def test_two_visible_people_become_multi_person_alert():
    engine = RiskEngine(multi_seconds=1.2)
    people = [track(1, center_x=90), track(2, center_x=210)]

    engine.evaluate(people, (320, 224), 1.0)
    result = engine.evaluate(people, (320, 224), 2.3)

    alerts = [item for item in result if item["risk"] == "multi_person"]
    assert len(alerts) == 2
    assert {item["state"] for item in alerts} == {"alert"}


def test_predicted_track_does_not_accumulate_phone_evidence():
    engine = RiskEngine(phone_seconds=1.0)
    engine.evaluate([track(1, left_phone=True)], (320, 224), 1.0)

    result = engine.evaluate(
        [track(1, left_phone=True, predicted=True)],
        (320, 224),
        2.2,
    )

    assert decisions_for(result, "phone_to_ear") == []


def test_predicted_track_does_not_accumulate_lingering_evidence():
    engine = RiskEngine(lingering_seconds=1.0)
    engine.evaluate([track(1)], (320, 224), 1.0)
    engine.evaluate([track(1, predicted=True)], (320, 224), 1.8)

    result = engine.evaluate([track(1)], (320, 224), 2.2)

    assert decisions_for(result, "lingering") == []


def test_predicted_tracks_do_not_accumulate_multi_person_evidence():
    engine = RiskEngine(multi_seconds=1.0)
    people = [track(1, center_x=90), track(2, center_x=210)]
    engine.evaluate(people, (320, 224), 1.0)
    engine.evaluate(
        [
            track(1, center_x=90, predicted=True),
            track(2, center_x=210, predicted=True),
        ],
        (320, 224),
        1.8,
    )

    result = engine.evaluate(people, (320, 224), 2.2)

    states = {item["state"] for item in decisions_for(result, "multi_person")}
    assert states == {"candidate"}


def test_stationary_track_becomes_lingering_alert():
    engine = RiskEngine(lingering_seconds=1.0)

    engine.evaluate([track(1)], (320, 224), 1.0)
    result = engine.evaluate([track(1)], (320, 224), 2.1)

    alert = decisions_for(result, "lingering")[0]
    assert alert["state"] == "alert"


def test_motion_resets_lingering_timer():
    engine = RiskEngine(lingering_seconds=1.0)
    engine.evaluate([track(1)], (320, 224), 1.0)

    moving = track(1, path_length=40.0, pose_motion=0.08)
    engine.evaluate([moving], (320, 224), 1.6)
    engine.evaluate([moving], (320, 224), 1.7)
    result = engine.evaluate([track(1, path_length=40.0)], (320, 224), 2.1)

    assert decisions_for(result, "lingering") == []
