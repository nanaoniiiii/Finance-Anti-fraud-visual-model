"""OpenCV overlay for tracks, skeletons, risks, and performance metrics."""

from __future__ import annotations

from collections import defaultdict
from typing import Mapping, Sequence

import cv2

from poseguard.types import PersonTrack, RiskDecision, RiskState


SKELETON = (
    (0, 1), (0, 2), (1, 3), (2, 4),
    (5, 6), (5, 7), (7, 9), (6, 8), (8, 10),
    (5, 11), (6, 12), (11, 12),
    (11, 13), (13, 15), (12, 14), (14, 16),
)


def is_exit_key(key: int) -> bool:
    return key in (27, ord("q"), ord("Q"))


class OverlayRenderer:
    def render(
        self,
        frame,
        tracks: Sequence[PersonTrack],
        decisions: Sequence[RiskDecision],
        metrics: Mapping[str, float],
    ):
        canvas = frame.copy()
        by_track: dict[int, list[RiskDecision]] = defaultdict(list)
        for decision in decisions:
            by_track[decision.track_id].append(decision)

        for track in tracks:
            track_decisions = by_track.get(track.track_id, [])
            strongest = max(
                track_decisions,
                key=lambda item: {
                    RiskState.NORMAL: 0,
                    RiskState.CANDIDATE: 1,
                    RiskState.ALERT: 2,
                }[item.state],
                default=None,
            )
            color = strongest.color if strongest else (0, 220, 255)
            thickness = 3 if strongest and strongest.state is RiskState.ALERT else 2
            x1, y1, x2, y2 = (int(value) for value in track.bbox)
            cv2.rectangle(canvas, (x1, y1), (x2, y2), color, thickness)
            self._draw_skeleton(canvas, track, color)

            label = f"ID {track.track_id}"
            if strongest and strongest.state is not RiskState.NORMAL:
                label += f" | {strongest.kind.value} {strongest.duration_seconds:.1f}s"
            cv2.putText(
                canvas,
                label,
                (max(x1, 0), max(y1 - 8, 18)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                color,
                2,
                cv2.LINE_AA,
            )

        fps = metrics.get("fps", 0.0)
        inference_ms = metrics.get("inference_ms", 0.0)
        status = f"FPS {fps:.1f} | infer {inference_ms:.1f} ms | people {len(tracks)}"
        cv2.rectangle(canvas, (0, 0), (min(canvas.shape[1], 430), 34), (25, 25, 25), -1)
        cv2.putText(
            canvas,
            status,
            (10, 23),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (240, 240, 240),
            1,
            cv2.LINE_AA,
        )
        return canvas

    @staticmethod
    def _draw_skeleton(canvas, track: PersonTrack, color: tuple[int, int, int]) -> None:
        for start, end in SKELETON:
            first = track.keypoints[start]
            second = track.keypoints[end]
            if first is None or second is None:
                continue
            cv2.line(
                canvas,
                (int(first.x), int(first.y)),
                (int(second.x), int(second.y)),
                color,
                1,
                cv2.LINE_AA,
            )
