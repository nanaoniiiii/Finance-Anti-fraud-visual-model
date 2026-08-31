from dataclasses import replace

from poseguard.risk.risk_engine import RiskRuleEngine
from poseguard.types import (
    Keypoint,
    PersonTrack,
    PhoneObservation,
    RiskKind,
    RiskState,
)


FRAME_SIZE = (640, 480)


def _track(track_id=1, center=(320.0, 240.0), timestamp=0.0, phone_pose=False):
    x, y = center
    bbox = (x - 50, y - 100, x + 50, y + 100)
    points = [None] * 17
    if phone_pose:
        points[3] = Keypoint(x - 12, y - 70, 0.95)
        points[5] = Keypoint(x - 10, y - 35, 0.95)
        points[7] = Keypoint(x - 20, y - 48, 0.95)
        points[9] = Keypoint(x - 11, y - 66, 0.95)
    points[11] = Keypoint(x - 8, y + 15, 0.95)
    points[12] = Keypoint(x + 8, y + 15, 0.95)
    points[15] = Keypoint(x - 8, y + 90, 0.95)
    points[16] = Keypoint(x + 8, y + 90, 0.95)
    if points[5] is None:
        points[5] = Keypoint(x - 10, y - 35, 0.95)
    return PersonTrack(
        track_id=track_id,
        bbox=bbox,
        confidence=0.9,
        keypoints=tuple(points),
        center=center,
        body_height=200.0,
        first_seen=0.0,
        last_seen=timestamp,
        pose_motion_valid=True,
    )


def _engine():
    return RiskRuleEngine(
        region=(0.05, 0.05, 0.95, 0.95),
        lingering_seconds=20.0,
        multi_person_seconds=1.5,
        phone_confirm_seconds=1.0,
        alert_release_seconds=0.8,
        wrist_ear_ratio=0.13,
        nearby_body_ratio=0.8,
        lingering_max_speed_ratio=0.12,
        lingering_max_pose_motion_ratio=0.04,
    )


def _decision(decisions, kind, track_id=1):
    return next(item for item in decisions if item.kind is kind and item.track_id == track_id)


def test_phone_candidate_stays_orange_without_phone():
    engine = _engine()
    track = _track(phone_pose=True)

    first = engine.evaluate((track,), (), FRAME_SIZE, 0.0)
    later = engine.evaluate((replace(track, last_seen=3.0),), (), FRAME_SIZE, 3.0)

    assert _decision(first, RiskKind.PHONE).state is RiskState.CANDIDATE
    assert _decision(later, RiskKind.PHONE).state is RiskState.CANDIDATE
    assert _decision(later, RiskKind.PHONE).color == (0, 165, 255)


def test_phone_match_turns_red_after_one_second():
    engine = _engine()
    track = _track(phone_pose=True)
    phone = PhoneObservation((295, 165, 315, 195), 0.85)

    engine.evaluate((track,), (phone,), FRAME_SIZE, 0.0)
    decisions = engine.evaluate((replace(track, last_seen=1.1),), (phone,), FRAME_SIZE, 1.1)

    result = _decision(decisions, RiskKind.PHONE)
    assert result.state is RiskState.ALERT
    assert result.color == (0, 0, 255)
    assert "与他人通话" in result.reason


def test_two_people_inside_region_turn_red_after_one_point_five_seconds():
    engine = _engine()
    tracks = (_track(1, (280, 240)), _track(2, (380, 240)))

    engine.evaluate(tracks, (), FRAME_SIZE, 0.0)
    decisions = engine.evaluate(
        tuple(replace(track, last_seen=1.6) for track in tracks),
        (),
        FRAME_SIZE,
        1.6,
    )

    assert _decision(decisions, RiskKind.MULTI_PERSON, 1).state is RiskState.ALERT
    assert _decision(decisions, RiskKind.MULTI_PERSON, 2).state is RiskState.ALERT


def test_single_person_lingering_turns_red_after_twenty_seconds():
    engine = _engine()
    track = _track()

    engine.evaluate((track,), (), FRAME_SIZE, 0.0)
    decisions = engine.evaluate((replace(track, last_seen=20.1),), (), FRAME_SIZE, 20.1)

    result = _decision(decisions, RiskKind.LINGERING)
    assert result.state is RiskState.ALERT
    assert result.duration_seconds >= 20.0


def test_visible_pose_motion_restarts_lingering_qualification_window():
    engine = _engine()
    track = replace(_track(), pose_motion_valid=True)

    engine.evaluate((track,), (), FRAME_SIZE, 0.0)
    moving = replace(track, last_seen=19.0, pose_motion=0.08)
    assert not any(
        item.kind is RiskKind.LINGERING and item.state is RiskState.ALERT
        for item in engine.evaluate((moving,), (), FRAME_SIZE, 19.0)
    )

    still_soon_after = replace(track, last_seen=20.1, pose_motion=0.0)
    decisions = engine.evaluate((still_soon_after,), (), FRAME_SIZE, 20.1)

    assert not any(
        item.kind is RiskKind.LINGERING and item.state is RiskState.ALERT
        for item in decisions
    )


def test_unknown_pose_motion_restarts_lingering_qualification_window():
    engine = _engine()
    track = replace(_track(), pose_motion_valid=True)

    engine.evaluate((track,), (), FRAME_SIZE, 0.0)
    unknown_motion = replace(track, last_seen=19.0, pose_motion_valid=False)
    engine.evaluate((unknown_motion,), (), FRAME_SIZE, 19.0)
    still_soon_after = replace(track, last_seen=20.1, pose_motion=0.0)

    decisions = engine.evaluate((still_soon_after,), (), FRAME_SIZE, 20.1)

    assert not any(
        item.kind is RiskKind.LINGERING and item.state is RiskState.ALERT
        for item in decisions
    )


def test_short_linger_and_distant_background_person_stay_normal():
    engine = _engine()
    inside = _track(1, (320, 240))
    outside = _track(2, (10, 10))

    engine.evaluate((inside, outside), (), FRAME_SIZE, 0.0)
    decisions = engine.evaluate(
        (replace(inside, last_seen=5.0), replace(outside, last_seen=5.0)),
        (),
        FRAME_SIZE,
        5.0,
    )

    assert not any(item.state is RiskState.ALERT for item in decisions)


def test_alert_releases_only_after_release_window():
    engine = _engine()
    track = _track(phone_pose=True)
    phone = PhoneObservation((295, 165, 315, 195), 0.85)
    engine.evaluate((track,), (phone,), FRAME_SIZE, 0.0)
    engine.evaluate((replace(track, last_seen=1.1),), (phone,), FRAME_SIZE, 1.1)

    retained = engine.evaluate((replace(track, last_seen=1.4),), (), FRAME_SIZE, 1.4)
    released = engine.evaluate((replace(track, last_seen=2.3),), (), FRAME_SIZE, 2.3)

    assert _decision(retained, RiskKind.PHONE).state is RiskState.ALERT
    assert not any(
        item.kind is RiskKind.PHONE and item.state is RiskState.ALERT
        for item in released
    )


def test_short_predicted_gap_preserves_lingering_timer():
    engine = _engine()
    track = _track()
    engine.evaluate((track,), (), FRAME_SIZE, 0.0)

    predicted = replace(track, predicted=True, missing_frames=1)
    engine.evaluate((predicted,), (), FRAME_SIZE, 5.0)
    recovered = replace(track, last_seen=20.1)
    decisions = engine.evaluate((recovered,), (), FRAME_SIZE, 20.1)

    assert _decision(decisions, RiskKind.LINGERING).state is RiskState.ALERT


def test_predicted_gap_resets_unconfirmed_phone_timer():
    engine = _engine()
    track = _track(phone_pose=True)
    phone = PhoneObservation((295, 165, 315, 195), 0.85)
    engine.evaluate((track,), (phone,), FRAME_SIZE, 0.0)

    predicted = replace(track, predicted=True, missing_frames=1)
    engine.evaluate((predicted,), (), FRAME_SIZE, 0.5)
    recovered = replace(track, last_seen=1.1)
    decisions = engine.evaluate((recovered,), (phone,), FRAME_SIZE, 1.1)

    assert _decision(decisions, RiskKind.PHONE).state is RiskState.CANDIDATE


def test_multi_person_alert_releases_for_person_who_exits_region():
    engine = _engine()
    first = _track(1, (280, 240))
    second = _track(2, (380, 240))
    engine.evaluate((first, second), (), FRAME_SIZE, 0.0)
    engine.evaluate((first, second), (), FRAME_SIZE, 1.6)

    exiting = replace(second, center=(10.0, 10.0), bbox=(-40.0, -90.0, 60.0, 110.0))
    retained = engine.evaluate((first, exiting), (), FRAME_SIZE, 1.9)
    released = engine.evaluate((first, exiting), (), FRAME_SIZE, 2.8)

    assert _decision(retained, RiskKind.MULTI_PERSON, 2).state is RiskState.ALERT
    assert not any(
        item.track_id == 2
        and item.kind is RiskKind.MULTI_PERSON
        and item.state is RiskState.ALERT
        for item in released
    )


def test_new_person_does_not_inherit_existing_multi_person_timer():
    engine = _engine()
    first = _track(1, (260, 240))
    second = _track(2, (360, 240))
    engine.evaluate((first, second), (), FRAME_SIZE, 0.0)
    engine.evaluate((first, second), (), FRAME_SIZE, 1.6)

    newcomer = _track(3, (460, 240), timestamp=1.7)
    decisions = engine.evaluate((first, second, newcomer), (), FRAME_SIZE, 1.7)

    assert _decision(decisions, RiskKind.MULTI_PERSON, 1).state is RiskState.ALERT
    assert _decision(decisions, RiskKind.MULTI_PERSON, 2).state is RiskState.ALERT
    assert _decision(decisions, RiskKind.MULTI_PERSON, 3).state is RiskState.CANDIDATE


def test_removed_track_clears_active_alert_state():
    engine = _engine()
    track = _track(phone_pose=True)
    phone = PhoneObservation((295, 165, 315, 195), 0.85)
    engine.evaluate((track,), (phone,), FRAME_SIZE, 0.0)
    engine.evaluate((track,), (phone,), FRAME_SIZE, 1.1)

    engine.evaluate((), (), FRAME_SIZE, 2.0)

    assert engine._active_alerts == {}


def test_predicted_participant_resets_multi_person_qualification_for_both_tracks():
    engine = _engine()
    first = _track(1, (280, 240))
    second = _track(2, (380, 240))
    engine.evaluate((first, second), (), FRAME_SIZE, 0.0)

    predicted_second = replace(second, predicted=True, missing_frames=1)
    engine.evaluate((first, predicted_second), (), FRAME_SIZE, 0.5)
    decisions = engine.evaluate((first, second), (), FRAME_SIZE, 1.1)

    first_result = _decision(decisions, RiskKind.MULTI_PERSON, 1)
    second_result = _decision(decisions, RiskKind.MULTI_PERSON, 2)
    assert first_result.state is RiskState.CANDIDATE
    assert second_result.state is RiskState.CANDIDATE
    assert first_result.duration_seconds == 0.0
    assert second_result.duration_seconds == 0.0


def test_multi_person_proximity_reason_only_applies_to_close_pair():
    engine = _engine()
    tracks = (
        _track(1, (180, 240)),
        _track(2, (240, 240)),
        _track(3, (520, 240)),
    )

    decisions = engine.evaluate(tracks, (), FRAME_SIZE, 0.0)

    assert "过近" in _decision(decisions, RiskKind.MULTI_PERSON, 1).reason
    assert "过近" in _decision(decisions, RiskKind.MULTI_PERSON, 2).reason
    assert "进入监控区" in _decision(decisions, RiskKind.MULTI_PERSON, 3).reason


def test_recovered_multi_person_tracks_retain_alert_during_release_window():
    engine = _engine()
    first = _track(1, (280, 240))
    second = _track(2, (380, 240))
    engine.evaluate((first, second), (), FRAME_SIZE, 0.0)
    engine.evaluate((first, second), (), FRAME_SIZE, 1.6)

    predicted_second = replace(second, predicted=True, missing_frames=1)
    engine.evaluate((first, predicted_second), (), FRAME_SIZE, 1.7)
    recovered = engine.evaluate((first, second), (), FRAME_SIZE, 1.8)

    assert _decision(recovered, RiskKind.MULTI_PERSON, 1).state is RiskState.ALERT
    assert _decision(recovered, RiskKind.MULTI_PERSON, 2).state is RiskState.ALERT
