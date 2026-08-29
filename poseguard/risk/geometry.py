"""Scale-normalized pose and proximity calculations."""

from __future__ import annotations

import math
from typing import Optional, Sequence

from poseguard.types import Keypoint, PersonObservation, PhoneObservation


COCO = {
    "left_ear": 3,
    "right_ear": 4,
    "left_shoulder": 5,
    "right_shoulder": 6,
    "left_elbow": 7,
    "right_elbow": 8,
    "left_wrist": 9,
    "right_wrist": 10,
    "left_hip": 11,
    "right_hip": 12,
    "left_ankle": 15,
    "right_ankle": 16,
}


def _point_xy(point: Keypoint | Sequence[float]) -> tuple[float, float]:
    if isinstance(point, Keypoint):
        return point.x, point.y
    return float(point[0]), float(point[1])


def distance(a: Keypoint | Sequence[float], b: Keypoint | Sequence[float]) -> float:
    ax, ay = _point_xy(a)
    bx, by = _point_xy(b)
    return math.hypot(ax - bx, ay - by)


def hand_near_ear(
    wrist: Keypoint | Sequence[float],
    ear: Keypoint | Sequence[float],
    body_height: float,
    ratio: float,
) -> bool:
    return body_height > 0 and distance(wrist, ear) <= body_height * ratio


def _visible(person: PersonObservation, index: int, minimum: float = 0.3) -> Optional[Keypoint]:
    point = person.keypoints[index]
    return point if point is not None and point.confidence >= minimum else None


def is_standing(person: PersonObservation) -> bool:
    shoulders = [
        point
        for index in (COCO["left_shoulder"], COCO["right_shoulder"])
        if (point := _visible(person, index)) is not None
    ]
    hips = [
        point
        for index in (COCO["left_hip"], COCO["right_hip"])
        if (point := _visible(person, index)) is not None
    ]
    ankles = [
        point
        for index in (COCO["left_ankle"], COCO["right_ankle"])
        if (point := _visible(person, index)) is not None
    ]
    if not shoulders or not hips or not ankles:
        return False
    shoulder_y = sum(point.y for point in shoulders) / len(shoulders)
    hip_y = sum(point.y for point in hips) / len(hips)
    ankle_y = sum(point.y for point in ankles) / len(ankles)
    body_height = person.bbox[3] - person.bbox[1]
    return shoulder_y < hip_y < ankle_y and ankle_y - shoulder_y >= body_height * 0.45


def candidate_phone_sides(
    person: PersonObservation,
    wrist_ear_ratio: float,
) -> tuple[str, ...]:
    if not is_standing(person):
        return ()
    body_height = person.bbox[3] - person.bbox[1]
    candidates: list[str] = []
    for side in ("left", "right"):
        ear = _visible(person, COCO[f"{side}_ear"])
        shoulder = _visible(person, COCO[f"{side}_shoulder"])
        elbow = _visible(person, COCO[f"{side}_elbow"])
        wrist = _visible(person, COCO[f"{side}_wrist"])
        if not all((ear, shoulder, elbow, wrist)):
            continue
        assert ear and shoulder and elbow and wrist
        arm_raised = wrist.y <= elbow.y + body_height * 0.06 and elbow.y < shoulder.y
        if arm_raised and hand_near_ear(wrist, ear, body_height, wrist_ear_ratio):
            candidates.append(side)
    return tuple(candidates)


def inside_region(
    center: Sequence[float],
    frame_size: Sequence[int],
    region: Sequence[float],
) -> bool:
    width, height = frame_size
    if width <= 0 or height <= 0:
        return False
    x, y = center
    return region[0] <= x / width <= region[2] and region[1] <= y / height <= region[3]


def nearby_people(
    center_a: Sequence[float],
    height_a: float,
    center_b: Sequence[float],
    height_b: float,
    ratio: float,
) -> bool:
    return distance(center_a, center_b) <= max(height_a, height_b) * ratio


def phone_matches_side(
    person: PersonObservation,
    phone: PhoneObservation,
    side: str,
) -> bool:
    if side not in ("left", "right"):
        return False
    ear = _visible(person, COCO[f"{side}_ear"])
    wrist = _visible(person, COCO[f"{side}_wrist"])
    if ear is None or wrist is None:
        return False
    body_height = max(person.bbox[3] - person.bbox[1], 1.0)
    margin = body_height * 0.07
    corridor = (
        min(ear.x, wrist.x) - margin,
        min(ear.y, wrist.y) - margin,
        max(ear.x, wrist.x) + margin,
        max(ear.y, wrist.y) + margin,
    )
    px1, py1, px2, py2 = phone.bbox
    return not (
        px2 < corridor[0]
        or px1 > corridor[2]
        or py2 < corridor[1]
        or py1 > corridor[3]
    )
