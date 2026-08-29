"""Backend-neutral domain records shared by tracking and risk rules."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple


BBox = Tuple[float, float, float, float]


@dataclass(frozen=True, slots=True)
class Keypoint:
    x: float
    y: float
    confidence: float


@dataclass(frozen=True, slots=True)
class PersonObservation:
    detection_index: int
    bbox: BBox
    confidence: float
    keypoints: Tuple[Optional[Keypoint], ...]

    def __post_init__(self) -> None:
        if len(self.keypoints) != 17:
            raise ValueError("PersonObservation requires 17 COCO keypoints")


@dataclass(frozen=True, slots=True)
class PhoneObservation:
    bbox: BBox
    confidence: float
