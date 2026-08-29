import pytest

from poseguard.tracking.person_tracks import PersonTrackManager
from poseguard.types import Keypoint, PersonObservation


def _observation(x: float, y: float, width: float = 60, height: float = 160):
    bbox = (x, y, x + width, y + height)
    points = tuple(Keypoint(x + width / 2, y + index * 3, 0.9) for index in range(17))
    return PersonObservation(0, bbox, 0.9, points)


def test_track_requires_three_matched_frames_before_publication():
    manager = PersonTrackManager(min_confirmed_hits=3)

    first = manager.update((_observation(10, 20),), 0.0, (640, 480))
    internal_id = next(iter(manager._tracks))
    second = manager.update((_observation(11, 20),), 0.1, (640, 480))
    third = manager.update((_observation(12, 20),), 0.2, (640, 480))

    assert first == ()
    assert second == ()
    assert len(third) == 1
    assert third[0].track_id == internal_id
    assert third[0].hits == 3
    assert third[0].confirmed is True


def test_tentative_track_is_never_published_when_it_disappears_early():
    manager = PersonTrackManager(min_confirmed_hits=3, max_missing_frames=2)

    first = manager.update((_observation(10, 20),), 0.0, (640, 480))
    first_missing = manager.update((), 0.1, (640, 480))
    second_missing = manager.update((), 0.2, (640, 480))
    expired = manager.update((), 0.3, (640, 480))

    assert first == ()
    assert first_missing == ()
    assert second_missing == ()
    assert expired == ()
    assert manager._tracks == {}


def test_tentative_hit_streak_resets_after_a_missing_frame():
    manager = PersonTrackManager(min_confirmed_hits=3, max_missing_frames=2)

    assert manager.update((_observation(10, 20),), 0.0, (640, 480)) == ()
    assert manager.update((), 0.1, (640, 480)) == ()
    assert manager.update((_observation(11, 20),), 0.2, (640, 480)) == ()
    assert manager.update((_observation(12, 20),), 0.3, (640, 480)) == ()
    confirmed = manager.update((_observation(13, 20),), 0.4, (640, 480))

    assert len(confirmed) == 1
    assert confirmed[0].hits == 3


def test_matched_keypoint_motion_is_normalized_by_body_scale():
    manager = PersonTrackManager(smoothing_alpha=1.0)
    initial = _observation(10, 20)
    first = manager.update((initial,), 0.0, (640, 480))[0]
    moved = PersonObservation(
        detection_index=0,
        bbox=initial.bbox,
        confidence=initial.confidence,
        keypoints=tuple(
            Keypoint(point.x + 12.0, point.y, point.confidence)
            if point is not None
            else None
            for point in initial.keypoints
        ),
    )

    second = manager.update((moved,), 0.1, (640, 480))[0]

    assert first.pose_motion == 0.0
    assert first.pose_motion_valid is False
    assert 0.0 < second.pose_motion < 1.0
    assert second.pose_motion_valid is True


def test_pose_motion_detects_a_moving_limb_among_stable_joints():
    manager = PersonTrackManager(smoothing_alpha=1.0)
    initial = _observation(10, 20)
    manager.update((initial,), 0.0, (640, 480))
    moved_points = list(initial.keypoints)
    for index in (9, 10):
        point = moved_points[index]
        assert point is not None
        moved_points[index] = Keypoint(
            point.x + 24.0,
            point.y,
            point.confidence,
        )
    moved = PersonObservation(
        detection_index=0,
        bbox=initial.bbox,
        confidence=initial.confidence,
        keypoints=tuple(moved_points),
    )

    updated = manager.update((moved,), 0.1, (640, 480))[0]

    assert updated.pose_motion > 0.0
    assert updated.pose_motion_valid is True


def test_pose_motion_uses_exactly_highest_quarter_of_shared_keypoints():
    manager = PersonTrackManager(smoothing_alpha=1.0)
    initial = _observation(10, 20)
    manager.update((initial,), 0.0, (640, 480))
    moved_points = list(initial.keypoints)
    for index in (7, 8, 9, 10):
        point = moved_points[index]
        assert point is not None
        moved_points[index] = Keypoint(
            point.x + 24.0,
            point.y,
            point.confidence,
        )
    moved = PersonObservation(
        detection_index=0,
        bbox=initial.bbox,
        confidence=initial.confidence,
        keypoints=tuple(moved_points),
    )

    updated = manager.update((moved,), 0.1, (640, 480))[0]

    assert updated.pose_motion == pytest.approx(24.0 / 160.0)


def test_insufficient_shared_keypoints_mark_pose_motion_unknown():
    manager = PersonTrackManager(smoothing_alpha=1.0)
    base = _observation(10, 20)
    first_visible = {5, 6, 7, 9, 11, 12}
    second_visible = {0, 1, 2, 5, 6, 11}
    first = PersonObservation(
        detection_index=0,
        bbox=base.bbox,
        confidence=base.confidence,
        keypoints=tuple(
            point if index in first_visible else None
            for index, point in enumerate(base.keypoints)
        ),
    )
    second = PersonObservation(
        detection_index=0,
        bbox=base.bbox,
        confidence=base.confidence,
        keypoints=tuple(
            Keypoint(point.x + 30.0, point.y, point.confidence)
            if index in second_visible and point is not None
            else None
            for index, point in enumerate(base.keypoints)
        ),
    )

    manager.update((first,), 0.0, (640, 480))
    updated = manager.update((second,), 0.1, (640, 480))[0]

    assert updated.pose_motion == 0.0
    assert updated.pose_motion_valid is False


@pytest.mark.parametrize("value", (0, -1, True, 1.5, "3"))
def test_manager_rejects_invalid_min_confirmed_hits(value):
    with pytest.raises(ValueError, match="min_confirmed_hits"):
        PersonTrackManager(min_confirmed_hits=value)


def test_small_motion_keeps_track_id_and_smooths_center():
    manager = PersonTrackManager(max_missing_frames=2, smoothing_alpha=0.5)
    first = manager.update((_observation(10, 20),), 0.0, (640, 480))[0]
    raw_next_center = (70.0, 100.0)

    second = manager.update((_observation(40, 20),), 0.1, (640, 480))[0]

    assert second.track_id == first.track_id
    assert first.center[0] < second.center[0] < raw_next_center[0]
    assert not second.predicted


def test_two_people_receive_different_ids():
    manager = PersonTrackManager()

    tracks = manager.update(
        (_observation(10, 20), _observation(400, 30)),
        0.0,
        (640, 480),
    )

    assert len({track.track_id for track in tracks}) == 2


def test_brief_missing_detection_retains_track_then_expires():
    manager = PersonTrackManager(max_missing_frames=2)
    original = manager.update((_observation(10, 20),), 0.0, (640, 480))[0]

    first_missing = manager.update((), 0.1, (640, 480))
    second_missing = manager.update((), 0.2, (640, 480))
    expired = manager.update((), 0.3, (640, 480))

    assert first_missing[0].track_id == original.track_id
    assert first_missing[0].predicted
    assert second_missing[0].missing_frames == 2
    assert expired == ()


def test_confirmed_track_survives_quality_gap_by_elapsed_time_not_frame_count():
    manager = PersonTrackManager(
        max_missing_frames=8,
        max_missing_seconds=1.0,
    )
    original = manager.update((_observation(10, 20),), 0.0, (640, 480))[0]

    # At 20 FPS, a 0.55 second quality gap exceeds eight frames but should
    # not replace the same person with a new ID.
    for frame in range(1, 12):
        predicted = manager.update((), frame * 0.05, (640, 480))
        assert predicted[0].track_id == original.track_id
        assert predicted[0].predicted is True

    recovered = manager.update((_observation(14, 20),), 0.6, (640, 480))[0]

    assert recovered.track_id == original.track_id
    assert recovered.predicted is False


def test_path_length_accumulates_smoothed_motion():
    manager = PersonTrackManager(smoothing_alpha=1.0)
    first = manager.update((_observation(0, 0),), 0.0, (640, 480))[0]
    second = manager.update((_observation(3, 4),), 0.1, (640, 480))[0]

    assert first.path_length == 0.0
    assert second.path_length == 5.0


def test_visible_frame_does_not_reuse_missing_keypoints():
    manager = PersonTrackManager(smoothing_alpha=0.5)
    first_observation = _observation(10, 20)
    manager.update((first_observation,), 0.0, (640, 480))
    missing_points = PersonObservation(
        detection_index=0,
        bbox=first_observation.bbox,
        confidence=0.9,
        keypoints=(None,) * 17,
    )

    updated = manager.update((missing_points,), 0.1, (640, 480))[0]

    assert updated.predicted is False
    assert updated.keypoints == (None,) * 17
