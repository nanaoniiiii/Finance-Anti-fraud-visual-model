from poseguard.app import build_parser


def test_max_frames_argument_supports_bounded_validation_runs():
    args = build_parser().parse_args(["--max-frames", "120", "--no-display"])

    assert args.max_frames == 120
    assert args.no_display is True
