"""Append compact risk state transitions without storing camera frames."""

import json
import os
import time


class EventStore:
    def __init__(self, path):
        self.path = str(path)
        self._states = {}
        self._last_decisions = {}
        self._last_error_log = 0.0

    def publish(self, decisions, timestamp, people, metrics):
        current = {
            (item["track_id"], item["risk"]): item
            for item in decisions
            if item.get("state") in ("candidate", "alert")
        }
        records = []

        for key in sorted(current):
            item = current[key]
            if self._states.get(key) == item["state"]:
                continue
            records.append(
                self._record(
                    item,
                    item["state"],
                    timestamp,
                    people,
                    metrics,
                )
            )

        for key in sorted(set(self._states) - set(current)):
            previous = self._last_decisions[key]
            records.append(
                self._record(
                    previous,
                    "clear",
                    timestamp,
                    people,
                    metrics,
                )
            )

        if records and not self._append(records):
            return False

        self._states = {key: item["state"] for key, item in current.items()}
        self._last_decisions = current
        return True

    @staticmethod
    def _record(item, state, timestamp, people, metrics):
        return {
            "timestamp": float(timestamp),
            "track_id": int(item["track_id"]),
            "risk": str(item["risk"]),
            "state": state,
            "reason": str(item.get("reason", "")),
            "duration": round(float(item.get("duration", 0.0)), 3),
            "people": int(people),
            "fps": round(float(metrics.get("fps", 0.0)), 2),
            "inference_ms": round(float(metrics.get("inference_ms", 0.0)), 2),
        }

    def _append(self, records):
        try:
            parent = os.path.dirname(os.path.abspath(self.path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as stream:
                for record in records:
                    stream.write(
                        json.dumps(
                            record,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                    )
                    stream.write("\n")
            return True
        except OSError as exc:
            now = time.monotonic()
            if now - self._last_error_log >= 5.0:
                print("[event] write failed: {}".format(exc))
                self._last_error_log = now
            return False
