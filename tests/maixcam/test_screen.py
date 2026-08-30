from platforms.maixcam.screen import ORANGE, RED, YELLOW, ScreenRenderer


class FakeImage:
    def __init__(self):
        self.calls = []

    def draw_rect(self, *args, **kwargs):
        self.calls.append(("rect", args, kwargs))

    def draw_line(self, *args, **kwargs):
        self.calls.append(("line", args, kwargs))

    def draw_circle(self, *args, **kwargs):
        self.calls.append(("circle", args, kwargs))

    def draw_string(self, *args, **kwargs):
        self.calls.append(("string", args, kwargs))


def track(track_id=1, keypoints=None):
    return {
        "track_id": track_id,
        "bbox": (10.0, 20.0, 100.0, 200.0),
        "keypoints": tuple(keypoints or [None] * 17),
        "predicted": False,
    }


def decision(state, reason="PHONE"):
    return {
        "track_id": 1,
        "risk": "phone_to_ear",
        "state": state,
        "reason": reason,
        "duration": 1.2,
    }


def rect_colors(frame):
    return [call[2]["color"] for call in frame.calls if call[0] == "rect"]


def test_normal_track_uses_yellow():
    frame = FakeImage()

    ScreenRenderer().render(frame, [track()], [], {"fps": 20.0})

    assert YELLOW in rect_colors(frame)


def test_candidate_uses_orange():
    frame = FakeImage()

    ScreenRenderer().render(
        frame,
        [track()],
        [decision("candidate", "PHONE?")],
        {"fps": 20.0},
    )

    assert ORANGE in rect_colors(frame)


def test_alert_track_uses_red_and_draws_label():
    frame = FakeImage()

    ScreenRenderer().render(
        frame,
        [track()],
        [decision("alert")],
        {"fps": 20.0, "inference_ms": 19.0},
    )

    assert RED in rect_colors(frame)
    labels = [call[1][2] for call in frame.calls if call[0] == "string"]
    assert any("PHONE" in label for label in labels)


def test_visible_keypoints_draw_skeleton_lines():
    frame = FakeImage()
    points = [None] * 17
    points[5] = (30.0, 40.0)
    points[6] = (60.0, 40.0)

    ScreenRenderer().render(frame, [track(keypoints=points)], [], {})

    assert any(call[0] == "line" for call in frame.calls)


def test_metrics_label_contains_people_and_fps():
    frame = FakeImage()

    ScreenRenderer().render(
        frame,
        [track()],
        [],
        {"fps": 18.4, "inference_ms": 19.2},
    )

    labels = [call[1][2] for call in frame.calls if call[0] == "string"]
    assert any("FPS 18.4" in label and "P 1" in label for label in labels)
