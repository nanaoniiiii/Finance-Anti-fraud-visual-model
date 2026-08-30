"""Allocation-conscious person association for MaixCAM scenes."""

import math


def _center(bbox):
    return (bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0


def _area(bbox):
    return max(bbox[2] - bbox[0], 1.0) * max(bbox[3] - bbox[1], 1.0)


def _blend(old, new, alpha):
    return old + alpha * (new - old)


class TrackManager:
    """Maintain stable monotonic IDs for a small number of people."""

    def __init__(
        self,
        *,
        minimum_confidence=0.35,
        max_missing_seconds=0.8,
        smoothing_alpha=0.55,
        maximum_match_cost=1.15,
        min_confirmed_hits=2,
        max_tracks=6,
    ):
        self.minimum_confidence = float(minimum_confidence)
        self.max_missing_seconds = float(max_missing_seconds)
        self.smoothing_alpha = float(smoothing_alpha)
        self.maximum_match_cost = float(maximum_match_cost)
        self.min_confirmed_hits = int(min_confirmed_hits)
        self.max_tracks = int(max_tracks)
        self._tracks = {}
        self._next_id = 1

    def reset(self):
        self._tracks.clear()

    def update(self, observations, timestamp):
        timestamp = float(timestamp)
        candidates = sorted(
            (
                item
                for item in observations
                if float(item.get("confidence", 0.0)) >= self.minimum_confidence
            ),
            key=lambda item: item["confidence"],
            reverse=True,
        )

        pairs = []
        for track_id, track in self._tracks.items():
            for observation_index, observation in enumerate(candidates):
                cost = self._match_cost(track, observation)
                if cost <= self.maximum_match_cost:
                    pairs.append((cost, track_id, observation_index))
        pairs.sort(key=lambda item: item[0])

        matched_tracks = set()
        matched_observations = set()
        assignments = {}
        for _, track_id, observation_index in pairs:
            if track_id in matched_tracks or observation_index in matched_observations:
                continue
            assignments[track_id] = observation_index
            matched_tracks.add(track_id)
            matched_observations.add(observation_index)

        updated = {}
        for track_id, track in self._tracks.items():
            observation_index = assignments.get(track_id)
            if observation_index is not None:
                updated[track_id] = self._update_track(
                    track,
                    candidates[observation_index],
                    timestamp,
                )
            elif timestamp - track["last_seen"] <= self.max_missing_seconds:
                predicted = dict(track)
                predicted["predicted"] = True
                predicted["pose_motion"] = 0.0
                predicted["pose_motion_valid"] = False
                updated[track_id] = predicted

        free_slots = max(self.max_tracks - len(updated), 0)
        for observation_index, observation in enumerate(candidates):
            if free_slots <= 0:
                break
            if observation_index in matched_observations:
                continue
            new_track = self._new_track(observation, timestamp)
            updated[new_track["track_id"]] = new_track
            free_slots -= 1

        self._tracks = updated
        return [
            updated[track_id]
            for track_id in sorted(updated)
            if updated[track_id]["confirmed"]
        ]

    def _new_track(self, observation, timestamp):
        bbox = tuple(observation["bbox"])
        track = {
            "track_id": self._next_id,
            "bbox": bbox,
            "confidence": float(observation["confidence"]),
            "keypoints": tuple(observation["keypoints"]),
            "center": _center(bbox),
            "body_height": max(bbox[3] - bbox[1], 1.0),
            "first_seen": timestamp,
            "last_seen": timestamp,
            "predicted": False,
            "hits": 1,
            "confirmed": self.min_confirmed_hits <= 1,
            "path_length": 0.0,
            "pose_motion": 0.0,
            "pose_motion_valid": False,
        }
        self._next_id += 1
        return track

    def _update_track(self, track, observation, timestamp):
        alpha = self.smoothing_alpha
        bbox = tuple(
            _blend(old, new, alpha)
            for old, new in zip(track["bbox"], observation["bbox"])
        )
        center = _center(bbox)
        pose_motion, pose_motion_valid = self._pose_motion(track, observation)
        keypoints = tuple(
            self._blend_point(old, new, alpha)
            for old, new in zip(track["keypoints"], observation["keypoints"])
        )
        hits = track["hits"] + 1
        return {
            "track_id": track["track_id"],
            "bbox": bbox,
            "confidence": _blend(
                track["confidence"],
                observation["confidence"],
                alpha,
            ),
            "keypoints": keypoints,
            "center": center,
            "body_height": max(bbox[3] - bbox[1], 1.0),
            "first_seen": track["first_seen"],
            "last_seen": timestamp,
            "predicted": False,
            "hits": hits,
            "confirmed": track["confirmed"] or hits >= self.min_confirmed_hits,
            "path_length": track["path_length"] + math.dist(track["center"], center),
            "pose_motion": pose_motion,
            "pose_motion_valid": pose_motion_valid,
        }

    @staticmethod
    def _blend_point(old, new, alpha):
        if new is None:
            return None
        if old is None:
            return new
        return _blend(old[0], new[0], alpha), _blend(old[1], new[1], alpha)

    @staticmethod
    def _pose_motion(track, observation):
        distances = [
            math.dist(old, new)
            for old, new in zip(track["keypoints"], observation["keypoints"])
            if old is not None and new is not None
        ]
        if len(distances) < 4:
            return 0.0, False
        observation_bbox = observation["bbox"]
        body_scale = max(
            track["body_height"],
            track["bbox"][2] - track["bbox"][0],
            observation_bbox[2] - observation_bbox[0],
            observation_bbox[3] - observation_bbox[1],
            1.0,
        )
        normalized = sorted(
            (distance / body_scale for distance in distances),
            reverse=True,
        )
        top_count = max(1, len(normalized) // 4)
        return sum(normalized[:top_count]) / top_count, True

    @staticmethod
    def _match_cost(track, observation):
        bbox = observation["bbox"]
        body_scale = max(track["body_height"], bbox[3] - bbox[1], 1.0)
        center_cost = math.dist(track["center"], _center(bbox)) / body_scale
        area_cost = abs(math.log(_area(bbox) / _area(track["bbox"]))) * 0.15
        point_distances = [
            math.dist(old, new) / body_scale
            for old, new in zip(track["keypoints"], observation["keypoints"])
            if old is not None and new is not None
        ]
        point_cost = (
            sum(point_distances) / len(point_distances) * 0.25
            if point_distances
            else 0.0
        )
        return center_cost + area_cost + point_cost
