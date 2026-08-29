"""Temporal risk fusion for approved suspicious behavior categories."""

from __future__ import annotations

from itertools import combinations
from typing import Iterable, Sequence

from poseguard.risk.geometry import (
    candidate_phone_sides,
    inside_region,
    nearby_people,
    phone_matches_side,
)
from poseguard.types import (
    PersonTrack,
    PhoneObservation,
    RiskDecision,
    RiskKind,
    RiskState,
)


class RiskRuleEngine:
    def __init__(
        self,
        *,
        region: Sequence[float],
        lingering_seconds: float,
        multi_person_seconds: float,
        phone_confirm_seconds: float,
        alert_release_seconds: float,
        wrist_ear_ratio: float,
        nearby_body_ratio: float,
        lingering_max_speed_ratio: float,
        lingering_max_pose_motion_ratio: float,
    ) -> None:
        self.region = tuple(region)
        self.lingering_seconds = lingering_seconds
        self.multi_person_seconds = multi_person_seconds
        self.phone_confirm_seconds = phone_confirm_seconds
        self.alert_release_seconds = alert_release_seconds
        self.wrist_ear_ratio = wrist_ear_ratio
        self.nearby_body_ratio = nearby_body_ratio
        self.lingering_max_speed_ratio = lingering_max_speed_ratio
        self.lingering_max_pose_motion_ratio = lingering_max_pose_motion_ratio

        self._phone_candidate_since: dict[int, float] = {}
        self._phone_confirm_since: dict[int, float] = {}
        self._inside_since: dict[int, float] = {}
        self._inside_path_start: dict[int, float] = {}
        self._multi_since: dict[int, float] = {}
        self._active_alerts: dict[tuple[int, RiskKind], float] = {}

    def evaluate(
        self,
        tracks: Iterable[PersonTrack],
        phones: Iterable[PhoneObservation],
        frame_size: tuple[int, int],
        timestamp: float,
    ) -> tuple[RiskDecision, ...]:
        all_tracks = tuple(tracks)
        visible_tracks = tuple(track for track in all_tracks if not track.predicted)
        phone_items = tuple(phones)
        live_ids = {track.track_id for track in all_tracks}
        self._forget_missing(live_ids)
        for track in all_tracks:
            if track.predicted:
                self._phone_candidate_since.pop(track.track_id, None)
                self._phone_confirm_since.pop(track.track_id, None)

        decisions: list[RiskDecision] = []
        inside_tracks = tuple(
            track
            for track in visible_tracks
            if inside_region(track.center, frame_size, self.region)
        )

        for track in visible_tracks:
            phone_decision = self._phone_decision(track, phone_items, timestamp)
            if phone_decision is not None:
                decisions.append(phone_decision)

            lingering_decision = self._lingering_decision(
                track,
                track in inside_tracks,
                timestamp,
            )
            if lingering_decision is not None:
                decisions.append(lingering_decision)

        decisions.extend(
            self._multi_decisions(visible_tracks, inside_tracks, timestamp)
        )

        decided_ids = {decision.track_id for decision in decisions}
        for track in visible_tracks:
            if track.track_id not in decided_ids:
                decisions.append(
                    self._decision(
                        track,
                        RiskKind.NONE,
                        RiskState.NORMAL,
                        "正常跟踪",
                        0.0,
                    )
                )
        return tuple(decisions)

    def _phone_decision(
        self,
        track: PersonTrack,
        phones: tuple[PhoneObservation, ...],
        timestamp: float,
    ) -> RiskDecision | None:
        sides = candidate_phone_sides(track, self.wrist_ear_ratio)  # type: ignore[arg-type]
        key = (track.track_id, RiskKind.PHONE)
        if not sides:
            self._phone_candidate_since.pop(track.track_id, None)
            self._phone_confirm_since.pop(track.track_id, None)
            return self._retained_alert(track, key, timestamp, "疑似贴耳通话")

        candidate_since = self._phone_candidate_since.setdefault(track.track_id, timestamp)
        matched = any(
            phone_matches_side(track, phone, side)  # type: ignore[arg-type]
            for phone in phones
            for side in sides
        )
        if matched:
            confirm_since = self._phone_confirm_since.setdefault(track.track_id, timestamp)
            duration = timestamp - confirm_since
            if duration >= self.phone_confirm_seconds:
                self._active_alerts[key] = timestamp
                return self._decision(
                    track,
                    RiskKind.PHONE,
                    RiskState.ALERT,
                    "疑似贴耳通话",
                    duration,
                )
        else:
            self._phone_confirm_since.pop(track.track_id, None)

        retained = self._retained_alert(track, key, timestamp, "疑似贴耳通话")
        if retained is not None:
            return retained
        return self._decision(
            track,
            RiskKind.PHONE,
            RiskState.CANDIDATE,
            "贴耳姿态待手机确认",
            timestamp - candidate_since,
        )

    def _lingering_decision(
        self,
        track: PersonTrack,
        is_inside: bool,
        timestamp: float,
    ) -> RiskDecision | None:
        key = (track.track_id, RiskKind.LINGERING)
        if not is_inside:
            self._inside_since.pop(track.track_id, None)
            self._inside_path_start.pop(track.track_id, None)
            return self._retained_alert(track, key, timestamp, "疑似长时间停留")

        if (
            not track.pose_motion_valid
            or track.pose_motion > self.lingering_max_pose_motion_ratio
        ):
            self._inside_since[track.track_id] = timestamp
            self._inside_path_start[track.track_id] = track.path_length
            return self._retained_alert(track, key, timestamp, "疑似长时间停留")

        since = self._inside_since.setdefault(track.track_id, timestamp)
        baseline_path = self._inside_path_start.setdefault(track.track_id, track.path_length)
        duration = timestamp - since
        path_delta = max(track.path_length - baseline_path, 0.0)
        normalized_speed = path_delta / max(track.body_height, 1.0) / max(duration, 1.0)
        if duration >= self.lingering_seconds and normalized_speed <= self.lingering_max_speed_ratio:
            self._active_alerts[key] = timestamp
            return self._decision(
                track,
                RiskKind.LINGERING,
                RiskState.ALERT,
                "疑似长时间停留",
                duration,
            )
        return self._retained_alert(track, key, timestamp, "疑似长时间停留")

    def _multi_decisions(
        self,
        visible_tracks: tuple[PersonTrack, ...],
        inside_tracks: tuple[PersonTrack, ...],
        timestamp: float,
    ) -> list[RiskDecision]:
        evidence_ids = (
            {track.track_id for track in inside_tracks}
            if len(inside_tracks) >= 2
            else set()
        )
        if not evidence_ids:
            self._multi_since.clear()
        close_ids: set[int] = set()
        for first, second in combinations(inside_tracks, 2):
            if nearby_people(
                first.center,
                first.body_height,
                second.center,
                second.body_height,
                self.nearby_body_ratio,
            ):
                close_ids.update((first.track_id, second.track_id))
        results: list[RiskDecision] = []
        for track in visible_tracks:
            key = (track.track_id, RiskKind.MULTI_PERSON)
            if track.track_id in evidence_ids:
                reason = (
                    "疑似多人过近"
                    if track.track_id in close_ids
                    else "疑似多人进入监控区"
                )
                since = self._multi_since.setdefault(track.track_id, timestamp)
                duration = timestamp - since
                state = (
                    RiskState.ALERT
                    if duration >= self.multi_person_seconds
                    else RiskState.CANDIDATE
                )
                if state is RiskState.ALERT:
                    self._active_alerts[key] = timestamp
                else:
                    retained = self._retained_alert(
                        track,
                        key,
                        timestamp,
                        reason,
                    )
                    if retained is not None:
                        results.append(retained)
                        continue
                results.append(
                    self._decision(
                        track,
                        RiskKind.MULTI_PERSON,
                        state,
                        reason,
                        duration,
                    )
                )
                continue

            self._multi_since.pop(track.track_id, None)
            retained = self._retained_alert(
                track,
                key,
                timestamp,
                "疑似多人进入监控区",
            )
            if retained is not None:
                results.append(retained)
        return results

    def _retained_alert(
        self,
        track: PersonTrack,
        key: tuple[int, RiskKind],
        timestamp: float,
        reason: str,
    ) -> RiskDecision | None:
        last_evidence = self._active_alerts.get(key)
        if last_evidence is None:
            return None
        age = timestamp - last_evidence
        if age <= self.alert_release_seconds:
            return self._decision(track, key[1], RiskState.ALERT, reason, age)
        self._active_alerts.pop(key, None)
        return None

    @staticmethod
    def _decision(
        track: PersonTrack,
        kind: RiskKind,
        state: RiskState,
        reason: str,
        duration: float,
    ) -> RiskDecision:
        return RiskDecision(
            track_id=track.track_id,
            kind=kind,
            state=state,
            reason=reason,
            confidence=track.confidence,
            bbox=track.bbox,
            duration_seconds=max(duration, 0.0),
        )

    def _forget_missing(self, live_ids: set[int]) -> None:
        for mapping in (
            self._phone_candidate_since,
            self._phone_confirm_since,
            self._inside_since,
            self._inside_path_start,
            self._multi_since,
        ):
            for track_id in tuple(mapping):
                if track_id not in live_ids:
                    mapping.pop(track_id, None)
        for key in tuple(self._active_alerts):
            if key[0] not in live_ids:
                self._active_alerts.pop(key, None)
