"""OpenCV overlay for tracks, skeletons, risks, and performance metrics."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Mapping, Sequence

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from poseguard.types import PersonTrack, RiskDecision, RiskState


SKELETON = (
    (0, 1), (0, 2), (1, 3), (2, 4),
    (5, 6), (5, 7), (7, 9), (6, 8), (8, 10),
    (5, 11), (6, 12), (11, 12),
    (11, 13), (13, 15), (12, 14), (14, 16),
)

UNICODE_FONT_CANDIDATES = (
    Path("C:/Windows/Fonts/msyh.ttc"),
    Path("C:/Windows/Fonts/simhei.ttf"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    Path("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
)


def is_exit_key(key: int) -> bool:
    return key in (27, ord("q"), ord("Q"))


def summarize_track_decisions(
    track_id: int,
    decisions: Sequence[RiskDecision],
) -> tuple[str, RiskDecision | None]:
    relevant = tuple(
        decision
        for decision in decisions
        if decision.state is not RiskState.NORMAL
    )
    if not relevant:
        return f"ID {track_id}", None
    strongest = max(
        relevant,
        key=lambda item: {
            RiskState.NORMAL: 0,
            RiskState.CANDIDATE: 1,
            RiskState.ALERT: 2,
        }[item.state],
    )
    reasons = tuple(dict.fromkeys(decision.reason for decision in relevant))
    duration = max(decision.duration_seconds for decision in relevant)
    return (
        f"ID {track_id} | 疑似风险行为 | {' + '.join(reasons)} | {duration:.1f}s",
        strongest,
    )


def split_track_label(label: str) -> tuple[str, ...]:
    """Keep a risk label readable without growing into a stacked paragraph."""
    parts = tuple(part for part in label.split(" | ") if part)
    if len(parts) <= 2:
        return parts or (label,)
    return " | ".join(parts[:2]), " | ".join(parts[2:])


class UnicodeTextPainter:
    def __init__(self) -> None:
        self._font_path = next(
            (path for path in UNICODE_FONT_CANDIDATES if path.exists()),
            None,
        )
        self._fonts: dict[int, ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}

    @property
    def unicode_font_available(self) -> bool:
        return self._font_path is not None

    def draw(self, canvas, items):
        if not items:
            return canvas
        image = Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB))
        draw = ImageDraw.Draw(image)
        for text, position, color, size in items:
            draw.text(
                position,
                text,
                font=self._font(size),
                fill=(color[2], color[1], color[0]),
            )
        return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)

    def _font(self, size: int):
        if size not in self._fonts:
            self._fonts[size] = (
                ImageFont.truetype(str(self._font_path), size)
                if self._font_path is not None
                else ImageFont.load_default()
            )
        return self._fonts[size]


class OverlayRenderer:
    def __init__(self) -> None:
        self._text = UnicodeTextPainter()

    def render(
        self,
        frame,
        tracks: Sequence[PersonTrack],
        decisions: Sequence[RiskDecision],
        metrics: Mapping[str, float],
        recent_events: Sequence[str] = (),
    ):
        canvas = frame.copy()
        text_items = []
        by_track: dict[int, list[RiskDecision]] = defaultdict(list)
        for decision in decisions:
            by_track[decision.track_id].append(decision)

        for track in tracks:
            track_decisions = by_track.get(track.track_id, [])
            label, strongest = summarize_track_decisions(
                track.track_id,
                track_decisions,
            )
            color = strongest.color if strongest else (0, 220, 255)
            thickness = 3 if strongest and strongest.state is RiskState.ALERT else 2
            x1, y1, x2, y2 = (int(value) for value in track.bbox)
            cv2.rectangle(canvas, (x1, y1), (x2, y2), color, thickness)
            self._draw_skeleton(canvas, track, color)

            label_lines = split_track_label(label)
            label_y = max(y1 - 22 * len(label_lines), 2)
            for index, line in enumerate(label_lines):
                text_items.append(
                    (
                        line,
                        (max(x1, 0), label_y + index * 20),
                        color,
                        17,
                    )
                )

        fps = metrics.get("fps", 0.0)
        inference_ms = metrics.get("inference_ms", 0.0)
        status = f"FPS {fps:.1f} | infer {inference_ms:.1f} ms | people {len(tracks)}"
        cv2.rectangle(canvas, (0, 0), (min(canvas.shape[1], 430), 34), (25, 25, 25), -1)
        text_items.append((status, (10, 7), (240, 240, 240), 16))
        for index, event in enumerate(recent_events[-3:]):
            y = canvas.shape[0] - 12 - (len(recent_events[-3:]) - 1 - index) * 22
            text_items.append(
                (
                    event,
                    (10, max(y - 17, 2)),
                    (220, 220, 220),
                    15,
                )
            )
        return self._text.draw(canvas, text_items)

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
