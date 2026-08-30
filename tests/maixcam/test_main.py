from types import SimpleNamespace

from platforms.maixcam.main import build_pipeline, parse_args, process_detections


def test_process_detections_returns_empty_tracks_and_decisions():
    tracks, decisions = process_detections(
        [],
        timestamp=1.0,
        frame_size=(320, 224),
    )

    assert tracks == []
    assert decisions == []


def test_process_detections_adapts_a_maix_object():
    points = [coordinate for index in range(17) for coordinate in (50 + index, 30 + index)]
    detection = SimpleNamespace(
        x=20,
        y=10,
        w=100,
        h=180,
        score=0.9,
        class_id=0,
        points=points,
    )
    pipeline = build_pipeline({"minimum_confirmed_hits": 1})

    tracks, decisions = process_detections(
        [detection],
        timestamp=1.0,
        frame_size=(320, 224),
        pipeline=pipeline,
    )

    assert len(tracks) == 1
    assert tracks[0]["track_id"] == 1
    assert decisions == []


def test_test_timer_mode_shortens_risk_holds():
    pipeline = build_pipeline({}, test_timers=True)

    assert pipeline.risk_engine.phone_seconds == 0.3
    assert pipeline.risk_engine.multi_seconds == 0.3
    assert pipeline.risk_engine.lingering_seconds == 2.0


def test_parse_args_supports_board_smoke_options():
    args = parse_args(["--max-frames", "300", "--no-display", "--test-timers"])

    assert args.max_frames == 300
    assert args.no_display is True
    assert args.test_timers is True
