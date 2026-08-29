"""Small-scene person association with stable monotonic IDs."""

from __future__ import annotations

import math
from dataclasses import replace
from typing import Iterable, Optional

from poseguard.types import BBox, Keypoint, PersonObservation, PersonTrack


def _center(bbox: BBox) -> tuple[float, float]:
    return (bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0


def _area(bbox: BBox) -> float:
    return max(bbox[2] - bbox[0], 1.0) * max(bbox[3] - bbox[1], 1.0)


def _blend(old: float, new: float, alpha: float) -> float:
    return old + alpha * (new - old)


class PersonTrackManager:
    def __init__(
        self,
        minimum_confidence: float = 0.35,
        max_missing_frames: int = 8,
        smoothing_alpha: float = 0.55,
        maximum_match_cost: float = 1.15,
        min_confirmed_hits: int = 1,
    ) -> None:
        self.minimum_confidence = minimum_confidence
        self.max_missing_frames = max_missing_frames
        self.smoothing_alpha = smoothing_alpha
        self.maximum_match_cost = maximum_match_cost
        if type(min_confirmed_hits) is not int or min_confirmed_hits < 1:
            raise ValueError("min_confirmed_hits must be a positive integer")
        self.min_confirmed_hits = min_confirmed_hits
        self._tracks: dict[int, PersonTrack] = {}
        self._next_id = 1

    def update(
        self,
        observations: Iterable[PersonObservation],
        timestamp: float,
        frame_size: tuple[int, int],
    ) -> tuple[PersonTrack, ...]:
        del frame_size  # Association uses body-relative distances.
        candidates = tuple(
            observation
            for observation in observations
            if observation.confidence >= self.minimum_confidence
        )

        scored_pairs: list[tuple[float, int, int]] = []
        for track_id, track in self._tracks.items():
            for observation_index, observation in enumerate(candidates):
                cost = self._match_cost(track, observation)
                if cost <= self.maximum_match_cost:
                    scored_pairs.append((cost, track_id, observation_index))
        scored_pairs.sort(key=lambda item: item[0])

        matched_tracks: set[int] = set()
        matched_observations: set[int] = set()
        assignments: dict[int, int] = {}
        for _, track_id, observation_index in scored_pairs:
            if track_id in matched_tracks or observation_index in matched_observations:
                continue
            assignments[track_id] = observation_index
            matched_tracks.add(track_id)
            matched_observations.add(observation_index)

        updated: dict[int, PersonTrack] = {}
        for track_id, track in self._tracks.items():
            if track_id in assignments:
                updated[track_id] = self._update_track(
                    track,
                    candidates[assignments[track_id]],
                    timestamp,
                )
            elif track.missing_frames + 1 <= self.max_missing_frames:
                updated[track_id] = replace(
                    track,
                    missing_frames=track.missing_frames + 1,
                    predicted=True,
                    hits=track.hits if track.confirmed else 0,
                    pose_motion=0.0,
                    pose_motion_valid=False,
                )

        for index, observation in enumerate(candidates):
            if index in matched_observations:
                continue
            track = self._new_track(observation, timestamp)
            updated[track.track_id] = track

        self._tracks = updated
        return tuple(
            updated[key]
            for key in sorted(updated)
            if updated[key].confirmed
        )

    def _new_track(self, observation: PersonObservation, timestamp: float) -> PersonTrack:
        center = _center(observation.bbox)
        track = PersonTrack(
            track_id=self._next_id,
            bbox=observation.bbox,
            confidence=observation.confidence,
            keypoints=observation.keypoints,
            center=center,
            body_height=max(observation.bbox[3] - observation.bbox[1], 1.0),
            first_seen=timestamp,
            last_seen=timestamp,
            hits=1,
            confirmed=self.min_confirmed_hits <= 1,
        )
        self._next_id += 1
        return track

    def _update_track(
        self,
        track: PersonTrack,
        observation: PersonObservation,
        timestamp: float,
    ) -> PersonTrack:
        alpha = self.smoothing_alpha
        pose_motion, pose_motion_valid = self._pose_motion(track, observation)
        bbox = tuple(
            _blend(old, new, alpha)
            for old, new in zip(track.bbox, observation.bbox)
        )
        center = _center(bbox)  # type: ignore[arg-type]
        motion = math.dist(track.center, center)
        keypoints = tuple(
            self._blend_keypoint(old, new, alpha)
            for old, new in zip(track.keypoints, observation.keypoints)
        )
        return PersonTrack(
            track_id=track.track_id,
            bbox=bbox,  # type: ignore[arg-type]
            confidence=_blend(track.confidence, observation.confidence, alpha),
            keypoints=keypoints,
            center=center,
            body_height=max(bbox[3] - bbox[1], 1.0),
            first_seen=track.first_seen,
            last_seen=timestamp,
            missing_frames=0,
            predicted=False,
            hits=track.hits + 1,
            confirmed=(
                track.confirmed or track.hits + 1 >= self.min_confirmed_hits
            ),
            pose_motion=pose_motion,
            pose_motion_valid=pose_motion_valid,
            inside_since=track.inside_since,
            path_length=track.path_length + motion,
        )

    @staticmethod
    def _pose_motion(
        track: PersonTrack,
        observation: PersonObservation,
    ) -> tuple[float, bool]:
        distances = [
            math.dist((old.x, old.y), (new.x, new.y))
            for old, new in zip(track.keypoints, observation.keypoints)
            if old is not None and new is not None
        ]
        if len(distances) < 4:
            return 0.0, False

        track_width = max(track.bbox[2] - track.bbox[0], 1.0)
        observation_width = max(
            observation.bbox[2] - observation.bbox[0],
            1.0,
        )
        observation_height = max(
            observation.bbox[3] - observation.bbox[1],
            1.0,
        )
        body_scale = max(
            track.body_height,
            track_width,
            observation_width,
            observation_height,
        )
        normalized = sorted(
            (distance / body_scale for distance in distances),
            reverse=True,
        )
        top_count = max(1, len(normalized) // 4)
        return sum(normalized[:top_count]) / top_count, True

    @staticmethod
    def _blend_keypoint(
        old: Optional[Keypoint],
        new: Optional[Keypoint],
        alpha: float,
    ) -> Optional[Keypoint]:
        if new is None:
            return None
        if old is None:
            return new
        return Keypoint(
            x=_blend(old.x, new.x, alpha),
            y=_blend(old.y, new.y, alpha),
            confidence=_blend(old.confidence, new.confidence, alpha),
        )

    @staticmethod
    def _match_cost(track: PersonTrack, observation: PersonObservation) -> float:
        observation_center = _center(observation.bbox)
        observation_height = max(observation.bbox[3] - observation.bbox[1], 1.0)
        scale = max(track.body_height, observation_height)
        center_cost = math.dist(track.center, observation_center) / scale
        area_cost = abs(math.log(_area(observation.bbox) / _area(track.bbox))) * 0.15

        keypoint_distances = [
            math.dist((old.x, old.y), (new.x, new.y)) / scale
            for old, new in zip(track.keypoints, observation.keypoints)
            if old is not None and new is not None
        ]
        keypoint_cost = (
            sum(keypoint_distances) / len(keypoint_distances) * 0.25
            if keypoint_distances
            else 0.0
        )
        return center_cost + area_cost + keypoint_cost
