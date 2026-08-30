"""Temporal suspicious-pose rules for the MaixCAM edge loop."""

import math


PHONE = "phone_to_ear"
MULTI = "multi_person"
LINGERING = "lingering"


class RiskEngine:
    def __init__(
        self,
        *,
        region=(0.05, 0.05, 0.95, 0.95),
        phone_seconds=1.0,
        multi_seconds=1.2,
        lingering_seconds=20.0,
        release_seconds=0.8,
        wrist_ear_ratio=0.14,
        forearm_min_ratio=0.08,
        torso_vertical_ratio=0.45,
        standing_span_ratio=0.42,
        lingering_speed_ratio=0.12,
        lingering_pose_motion_ratio=0.04,
    ):
        self.region = tuple(region)
        self.phone_seconds = float(phone_seconds)
        self.multi_seconds = float(multi_seconds)
        self.lingering_seconds = float(lingering_seconds)
        self.release_seconds = float(release_seconds)
        self.wrist_ear_ratio = float(wrist_ear_ratio)
        self.forearm_min_ratio = float(forearm_min_ratio)
        self.torso_vertical_ratio = float(torso_vertical_ratio)
        self.standing_span_ratio = float(standing_span_ratio)
        self.lingering_speed_ratio = float(lingering_speed_ratio)
        self.lingering_pose_motion_ratio = float(lingering_pose_motion_ratio)
        self.reset()

    def reset(self):
        self._phone_since = {}
        self._phone_side = {}
        self._multi_since = {}
        self._linger_since = {}
        self._linger_path_start = {}
        self._motion_strikes = {}
        self._active = {}

    def evaluate(self, tracks, frame_size, timestamp):
        timestamp = float(timestamp)
        all_tracks = list(tracks)
        live_ids = {track["track_id"] for track in all_tracks}
        self._forget_missing(live_ids)
        visible = [track for track in all_tracks if not track.get("predicted", False)]
        predicted = [track for track in all_tracks if track.get("predicted", False)]

        for track in predicted:
            track_id = track["track_id"]
            self._phone_since.pop(track_id, None)
            self._phone_side.pop(track_id, None)
            self._multi_since.pop(track_id, None)
            self._clear_lingering(track_id)

        decisions = []
        for track in visible:
            phone = self._phone_decision(track, timestamp)
            if phone is not None:
                decisions.append(phone)
            lingering = self._lingering_decision(track, frame_size, timestamp)
            if lingering is not None:
                decisions.append(lingering)

        decisions.extend(self._multi_decisions(visible, frame_size, timestamp))

        decided_keys = {(item["track_id"], item["risk"]) for item in decisions}
        for track in predicted:
            for risk, reason in (
                (PHONE, "PHONE"),
                (MULTI, "MULTI"),
                (LINGERING, "LINGER"),
            ):
                key = (track["track_id"], risk)
                if key in decided_keys:
                    continue
                retained = self._retained(track, key, timestamp, reason)
                if retained is not None:
                    decisions.append(retained)

        decisions.sort(key=lambda item: (item["track_id"], item["risk"]))
        return decisions

    def _phone_decision(self, track, timestamp):
        track_id = track["track_id"]
        key = (track_id, PHONE)
        side = self._phone_pose_side(track)
        if side is None:
            self._phone_since.pop(track_id, None)
            self._phone_side.pop(track_id, None)
            return self._retained(track, key, timestamp, "PHONE")

        if self._phone_side.get(track_id) != side:
            self._phone_side[track_id] = side
            self._phone_since[track_id] = timestamp
        since = self._phone_since.setdefault(track_id, timestamp)
        duration = timestamp - since
        if duration >= self.phone_seconds:
            self._active[key] = timestamp
            return self._decision(track, PHONE, "alert", "PHONE", duration)

        retained = self._retained(track, key, timestamp, "PHONE")
        if retained is not None:
            return retained
        return self._decision(track, PHONE, "candidate", "PHONE?", duration)

    def _multi_decisions(self, tracks, frame_size, timestamp):
        inside = [track for track in tracks if self._inside(track, frame_size)]
        evidence_ids = {track["track_id"] for track in inside} if len(inside) >= 2 else set()
        results = []
        for track in tracks:
            track_id = track["track_id"]
            key = (track_id, MULTI)
            if track_id in evidence_ids:
                since = self._multi_since.setdefault(track_id, timestamp)
                duration = timestamp - since
                state = "alert" if duration >= self.multi_seconds else "candidate"
                if state == "alert":
                    self._active[key] = timestamp
                results.append(self._decision(track, MULTI, state, "MULTI", duration))
                continue
            self._multi_since.pop(track_id, None)
            retained = self._retained(track, key, timestamp, "MULTI")
            if retained is not None:
                results.append(retained)
        return results

    def _lingering_decision(self, track, frame_size, timestamp):
        track_id = track["track_id"]
        key = (track_id, LINGERING)
        if not self._inside(track, frame_size):
            self._clear_lingering(track_id)
            return self._retained(track, key, timestamp, "LINGER")

        since = self._linger_since.setdefault(track_id, timestamp)
        path_start = self._linger_path_start.setdefault(
            track_id,
            track.get("path_length", 0.0),
        )
        duration = max(timestamp - since, 0.0)
        speed = (
            max(track.get("path_length", 0.0) - path_start, 0.0)
            / max(track["body_height"], 1.0)
            / max(duration, 1e-6)
        )
        moving = (
            not track.get("pose_motion_valid", False)
            or track.get("pose_motion", 0.0) > self.lingering_pose_motion_ratio
            or speed > self.lingering_speed_ratio
        )
        if moving:
            strikes = self._motion_strikes.get(track_id, 0) + 1
            self._motion_strikes[track_id] = strikes
            if strikes >= 2:
                self._linger_since[track_id] = timestamp
                self._linger_path_start[track_id] = track.get("path_length", 0.0)
                self._motion_strikes[track_id] = 0
            return self._retained(track, key, timestamp, "LINGER")

        self._motion_strikes[track_id] = 0
        if duration >= self.lingering_seconds:
            self._active[key] = timestamp
            return self._decision(track, LINGERING, "alert", "LINGER", duration)
        return self._retained(track, key, timestamp, "LINGER")

    def _phone_pose_side(self, track):
        points = track["keypoints"]
        body_height = max(track["body_height"], 1.0)
        if not self._upright(points, body_height):
            return None
        sides = []
        for name, ear_index, shoulder_index, elbow_index, wrist_index in (
            ("left", 3, 5, 7, 9),
            ("right", 4, 6, 8, 10),
        ):
            ear = points[ear_index]
            shoulder = points[shoulder_index]
            elbow = points[elbow_index]
            wrist = points[wrist_index]
            if None in (ear, shoulder, elbow, wrist):
                continue
            if math.dist(wrist, ear) > body_height * self.wrist_ear_ratio:
                continue
            if math.dist(wrist, ear) >= math.dist(elbow, ear):
                continue
            if math.dist(elbow, wrist) < body_height * self.forearm_min_ratio:
                continue
            sides.append(name)
        return sides[0] if len(sides) == 1 else None

    def _upright(self, points, body_height):
        left_shoulder, right_shoulder = points[5], points[6]
        left_hip, right_hip = points[11], points[12]
        if None in (left_shoulder, right_shoulder, left_hip, right_hip):
            return False
        shoulder_mid = self._midpoint(left_shoulder, right_shoulder)
        hip_mid = self._midpoint(left_hip, right_hip)
        vertical = hip_mid[1] - shoulder_mid[1]
        if vertical <= 0:
            return False
        if abs(hip_mid[0] - shoulder_mid[0]) / max(abs(vertical), 1.0) > self.torso_vertical_ratio:
            return False

        for hip_index, knee_index, ankle_index in ((11, 13, 15), (12, 14, 16)):
            hip, knee, ankle = points[hip_index], points[knee_index], points[ankle_index]
            if hip is None or knee is None or knee[1] <= hip[1]:
                continue
            if knee[1] - shoulder_mid[1] < body_height * self.standing_span_ratio:
                continue
            if ankle is not None and ankle[1] <= knee[1]:
                continue
            return True
        return False

    def _inside(self, track, frame_size):
        width, height = frame_size
        left, top, right, bottom = self.region
        center_x, center_y = track["center"]
        return (
            left * width <= center_x <= right * width
            and top * height <= center_y <= bottom * height
        )

    def _retained(self, track, key, timestamp, reason):
        last_evidence = self._active.get(key)
        if last_evidence is None:
            return None
        age = timestamp - last_evidence
        if age <= self.release_seconds:
            return self._decision(track, key[1], "alert", reason, age)
        self._active.pop(key, None)
        return None

    @staticmethod
    def _decision(track, risk, state, reason, duration):
        return {
            "track_id": track["track_id"],
            "risk": risk,
            "state": state,
            "reason": reason,
            "duration": max(float(duration), 0.0),
            "bbox": track["bbox"],
        }

    @staticmethod
    def _midpoint(first, second):
        return (first[0] + second[0]) / 2.0, (first[1] + second[1]) / 2.0

    def _clear_lingering(self, track_id):
        self._linger_since.pop(track_id, None)
        self._linger_path_start.pop(track_id, None)
        self._motion_strikes.pop(track_id, None)

    def _forget_missing(self, live_ids):
        for mapping in (
            self._phone_since,
            self._phone_side,
            self._multi_since,
            self._linger_since,
            self._linger_path_start,
            self._motion_strikes,
        ):
            for track_id in tuple(mapping):
                if track_id not in live_ids:
                    mapping.pop(track_id, None)
        for key in tuple(self._active):
            if key[0] not in live_ids:
                self._active.pop(key, None)
