"""Backend-neutral pose observation quality and duplicate suppression."""

from __future__ import annotations

import math
from typing import Iterable

from poseguard.types import BBox, PersonObservation


TORSO_KEYPOINT_INDICES = (5, 6, 11, 12)
MINIMUM_SHARED_KEYPOINTS = 4
CLOSE_UP_SHOULDER_INDICES = (5, 6)
CLOSE_UP_ANKLE_INDICES = (15, 16)
CLOSE_UP_MIN_CONFIDENCE = 0.75
CLOSE_UP_MIN_VISIBLE_KEYPOINTS = 7
CLOSE_UP_MIN_AREA_RATIO = 0.35


def _bbox_size(bbox: BBox) -> tuple[float, float]:
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def _bbox_center(bbox: BBox) -> tuple[float, float]:
    return (bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0


def _bbox_iou(first: BBox, second: BBox) -> float:
    intersection_width = max(
        0.0,
        min(first[2], second[2]) - max(first[0], second[0]),
    )
    intersection_height = max(
        0.0,
        min(first[3], second[3]) - max(first[1], second[1]),
    )
    intersection = intersection_width * intersection_height
    first_width, first_height = _bbox_size(first)
    second_width, second_height = _bbox_size(second)
    union = first_width * first_height + second_width * second_height - intersection
    return intersection / union if union > 0.0 else 0.0


class PoseObservationFilter:
    def __init__(
        self,
        min_visible_keypoints: int = 6,
        min_torso_keypoints: int = 3,
        min_bbox_area_ratio: float = 0.015,
        max_bbox_area_ratio: float = 0.75,
        max_outside_ratio: float = 0.20,
        duplicate_iou_threshold: float = 0.45,
        duplicate_center_body_ratio: float = 0.25,
        duplicate_keypoint_body_ratio: float = 0.05,
    ) -> None:
        self.min_visible_keypoints = min_visible_keypoints
        self.min_torso_keypoints = min_torso_keypoints
        self.min_bbox_area_ratio = min_bbox_area_ratio
        self.max_bbox_area_ratio = max_bbox_area_ratio
        self.max_outside_ratio = max_outside_ratio
        self.duplicate_iou_threshold = duplicate_iou_threshold
        self.duplicate_center_body_ratio = duplicate_center_body_ratio
        self.duplicate_keypoint_body_ratio = duplicate_keypoint_body_ratio

    def filter(
        self,
        observations: Iterable[PersonObservation],
        frame_size: tuple[int, int],
    ) -> tuple[PersonObservation, ...]:
        """Reject implausible observations and collapse duplicate skeletons."""
        candidates = [
            (index, observation)
            for index, observation in enumerate(observations)
            if self._passes_quality_checks(observation, frame_size)
        ]
        ranked = sorted(
            candidates,
            key=lambda item: self._quality_score(item[1]),
            reverse=True,
        )

        kept: list[tuple[int, PersonObservation]] = []
        for candidate in ranked:
            if any(
                self._are_duplicates(candidate[1], selected[1])
                for selected in kept
            ):
                continue
            kept.append(candidate)

        kept.sort(key=lambda item: item[0])
        return tuple(observation for _, observation in kept)

    def _passes_quality_checks(
        self,
        observation: PersonObservation,
        frame_size: tuple[int, int],
    ) -> bool:
        frame_width, frame_height = frame_size
        if frame_width <= 0 or frame_height <= 0:
            return False

        bbox_width, bbox_height = _bbox_size(observation.bbox)
        if bbox_width <= 0.0 or bbox_height <= 0.0:
            return False

        visible_count = sum(point is not None for point in observation.keypoints)
        torso_count = sum(
            observation.keypoints[index] is not None
            for index in TORSO_KEYPOINT_INDICES
        )
        if visible_count < self.min_visible_keypoints:
            return False

        x1, y1, x2, y2 = observation.bbox
        clipped_width = max(0.0, min(x2, frame_width) - max(x1, 0.0))
        clipped_height = max(0.0, min(y2, frame_height) - max(y1, 0.0))
        clipped_area = clipped_width * clipped_height
        frame_area = float(frame_width * frame_height)
        clipped_area_ratio = clipped_area / frame_area
        close_upper_body = (
            observation.confidence >= CLOSE_UP_MIN_CONFIDENCE
            and visible_count
            >= max(self.min_visible_keypoints, CLOSE_UP_MIN_VISIBLE_KEYPOINTS)
            and clipped_area_ratio >= CLOSE_UP_MIN_AREA_RATIO
            and all(
                observation.keypoints[index] is not None
                for index in CLOSE_UP_SHOULDER_INDICES
            )
            and all(
                observation.keypoints[index] is None
                for index in CLOSE_UP_ANKLE_INDICES
            )
        )
        if torso_count < self.min_torso_keypoints and not close_upper_body:
            return False
        if clipped_area_ratio < self.min_bbox_area_ratio:
            return False
        if clipped_area_ratio > self.max_bbox_area_ratio and not close_upper_body:
            return False

        bbox_area = bbox_width * bbox_height
        outside_ratio = 1.0 - clipped_area / bbox_area
        return outside_ratio <= self.max_outside_ratio

    @staticmethod
    def _quality_score(observation: PersonObservation) -> float:
        visible_count = sum(point is not None for point in observation.keypoints)
        torso_count = sum(
            observation.keypoints[index] is not None
            for index in TORSO_KEYPOINT_INDICES
        )
        return observation.confidence + visible_count / 17.0 + torso_count / 4.0

    def _are_duplicates(
        self,
        first: PersonObservation,
        second: PersonObservation,
    ) -> bool:
        shared_points = [
            (first_point, second_point)
            for first_point, second_point in zip(first.keypoints, second.keypoints)
            if first_point is not None and second_point is not None
        ]
        if len(shared_points) < MINIMUM_SHARED_KEYPOINTS:
            return False

        first_width, first_height = _bbox_size(first.bbox)
        second_width, second_height = _bbox_size(second.bbox)
        body_scale = max(
            first_width,
            first_height,
            second_width,
            second_height,
            1.0,
        )
        mean_keypoint_distance = sum(
            math.dist(
                (first_point.x, first_point.y),
                (second_point.x, second_point.y),
            )
            for first_point, second_point in shared_points
        ) / len(shared_points)
        if mean_keypoint_distance / body_scale > self.duplicate_keypoint_body_ratio:
            return False

        center_distance = math.dist(
            _bbox_center(first.bbox),
            _bbox_center(second.bbox),
        )
        spatially_close = (
            _bbox_iou(first.bbox, second.bbox) >= self.duplicate_iou_threshold
            or center_distance / body_scale <= self.duplicate_center_body_ratio
        )
        return spatially_close
