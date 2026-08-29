"""Backend-neutral domain records shared by tracking and risk rules."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
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


@dataclass(frozen=True, slots=True)
class PersonTrack:
    track_id: int
    bbox: BBox
    confidence: float
    keypoints: Tuple[Optional[Keypoint], ...]
    center: Tuple[float, float]
    body_height: float
    first_seen: float
    last_seen: float
    missing_frames: int = 0
    predicted: bool = False
    inside_since: Optional[float] = None
    path_length: float = 0.0


class RiskKind(str, Enum):
    NONE = "none"
    PHONE = "phone_to_ear"
    MULTI_PERSON = "multi_person"
    LINGERING = "lingering"


class RiskState(str, Enum):
    NORMAL = "normal"
    CANDIDATE = "candidate"
    ALERT = "alert"


@dataclass(frozen=True, slots=True)
class RiskDecision:
    track_id: int
    kind: RiskKind
    state: RiskState
    reason: str
    confidence: float
    bbox: BBox
    duration_seconds: float = 0.0

    @property
    def color(self) -> tuple[int, int, int]:
        if self.state is RiskState.ALERT:
            return 0, 0, 255
        if self.state is RiskState.CANDIDATE:
            return 0, 165, 255
        return 0, 220, 255
