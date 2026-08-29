"""Append-only de-identified risk event log."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TextIO

from poseguard.types import RiskDecision


class EventLogger:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._stream: TextIO = self.path.open("a", encoding="utf-8")

    def write(self, decision: RiskDecision, *, timestamp: float) -> None:
        payload = {
            "timestamp": float(timestamp),
            "track_id": decision.track_id,
            "risk_kind": decision.kind.value,
            "state": decision.state.value,
            "reason": decision.reason,
            "confidence": round(decision.confidence, 4),
            "bbox": [round(value, 2) for value in decision.bbox],
            "duration_seconds": round(decision.duration_seconds, 3),
        }
        self._stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._stream.flush()

    def close(self) -> None:
        if not self._stream.closed:
            self._stream.close()

    def __enter__(self) -> "EventLogger":
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()
