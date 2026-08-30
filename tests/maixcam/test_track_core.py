from platforms.maixcam.track_core import TrackManager


def observation(x=20.0, confidence=0.9):
    points = tuple((x + 40.0 + index, 30.0 + index * 4.0) for index in range(17))
    return {
        "detection_index": 0,
        "bbox": (x, 10.0, x + 90.0, 210.0),
        "confidence": confidence,
        "keypoints": points,
    }


def test_track_id_survives_short_dropout():
    manager = TrackManager(min_confirmed_hits=1, max_missing_seconds=0.8)
    first = manager.update([observation()], 1.0)[0]
    predicted = manager.update([], 1.4)[0]
    recovered = manager.update([observation(x=24.0)], 1.5)[0]

    assert first["track_id"] == predicted["track_id"] == recovered["track_id"]
    assert predicted["predicted"] is True
    assert recovered["predicted"] is False


def test_track_expires_after_missing_grace():
    manager = TrackManager(min_confirmed_hits=1, max_missing_seconds=0.8)
    manager.update([observation()], 1.0)

    assert manager.update([], 1.81) == []


def test_track_requires_confirmed_hits():
    manager = TrackManager(min_confirmed_hits=2)

    assert manager.update([observation()], 1.0) == []
    assert len(manager.update([observation(x=22.0)], 1.1)) == 1


def test_track_count_is_bounded_by_confidence():
    manager = TrackManager(min_confirmed_hits=1, max_tracks=2)
    tracks = manager.update(
        [
            observation(0, confidence=0.7),
            observation(110, confidence=0.95),
            observation(220, confidence=0.8),
        ],
        1.0,
    )

    assert len(tracks) == 2
    assert sorted(track["confidence"] for track in tracks) == [0.8, 0.95]


def test_matching_updates_path_and_pose_motion():
    manager = TrackManager(min_confirmed_hits=1, smoothing_alpha=1.0)
    manager.update([observation(10)], 1.0)

    track = manager.update([observation(20)], 1.1)[0]

    assert track["path_length"] == 10.0
    assert track["pose_motion_valid"] is True
    assert track["pose_motion"] > 0.0
