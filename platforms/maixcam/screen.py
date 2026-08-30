"""Maix image drawing primitives for tracks, skeletons, and alerts."""


YELLOW = (255, 255, 0)
ORANGE = (255, 165, 0)
RED = (255, 0, 0)
WHITE = (255, 255, 255)

SKELETON = (
    (0, 1),
    (0, 2),
    (1, 3),
    (2, 4),
    (5, 6),
    (5, 7),
    (7, 9),
    (6, 8),
    (8, 10),
    (5, 11),
    (6, 12),
    (11, 12),
    (11, 13),
    (13, 15),
    (12, 14),
    (14, 16),
)

STATE_RANK = {"normal": 0, "candidate": 1, "alert": 2}
STATE_COLOR = {"normal": YELLOW, "candidate": ORANGE, "alert": RED}


class ScreenRenderer:
    def render(self, frame, tracks, decisions, metrics):
        by_track = {}
        for item in decisions:
            by_track.setdefault(item["track_id"], []).append(item)

        for track in tracks:
            track_decisions = by_track.get(track["track_id"], [])
            strongest = self._strongest(track_decisions)
            state = strongest["state"] if strongest is not None else "normal"
            color = STATE_COLOR[state]
            x1, y1, x2, y2 = (int(value) for value in track["bbox"])
            frame.draw_rect(
                x1,
                y1,
                max(x2 - x1, 1),
                max(y2 - y1, 1),
                color=color,
            )
            self._draw_pose(frame, track["keypoints"], color)
            frame.draw_string(
                max(x1, 0),
                max(y1 - 14, 0),
                self._label(track["track_id"], track_decisions),
                color=color,
            )

        frame.draw_string(
            2,
            2,
            "FPS {:.1f} INF {:.1f}ms P {}".format(
                float(metrics.get("fps", 0.0)),
                float(metrics.get("inference_ms", 0.0)),
                len([track for track in tracks if not track.get("predicted", False)]),
            ),
            color=WHITE,
        )
        return frame

    @staticmethod
    def _strongest(decisions):
        if not decisions:
            return None
        return max(decisions, key=lambda item: STATE_RANK.get(item["state"], 0))

    @staticmethod
    def _label(track_id, decisions):
        if not decisions:
            return "ID {}".format(track_id)
        ordered = sorted(
            decisions,
            key=lambda item: STATE_RANK.get(item["state"], 0),
            reverse=True,
        )
        reasons = []
        for item in ordered:
            reason = item.get("reason", "")
            if reason and reason not in reasons:
                reasons.append(reason)
        duration = max(float(item.get("duration", 0.0)) for item in ordered)
        return "ID {} {} {:.1f}s".format(track_id, "+".join(reasons), duration)

    @staticmethod
    def _draw_pose(frame, keypoints, color):
        for start, end in SKELETON:
            first = keypoints[start]
            second = keypoints[end]
            if first is None or second is None:
                continue
            frame.draw_line(
                int(first[0]),
                int(first[1]),
                int(second[0]),
                int(second[1]),
                color=color,
            )
        for point in keypoints:
            if point is None:
                continue
            frame.draw_circle(int(point[0]), int(point[1]), 2, color=color)
