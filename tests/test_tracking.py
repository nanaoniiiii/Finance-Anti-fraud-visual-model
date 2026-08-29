from poseguard.tracking.person_tracks import PersonTrackManager
from poseguard.types import Keypoint, PersonObservation


def _observation(x: float, y: float, width: float = 60, height: float = 160):
    bbox = (x, y, x + width, y + height)
    points = tuple(Keypoint(x + width / 2, y + index * 3, 0.9) for index in range(17))
    return PersonObservation(0, bbox, 0.9, points)


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
