"""Backend protocols keep model runtimes outside the risk engine."""

from __future__ import annotations

from typing import Any, Protocol, Sequence

from poseguard.types import BBox, PersonObservation, PhoneObservation


class PoseBackend(Protocol):
    def infer(self, frame: Any) -> tuple[PersonObservation, ...]: ...


class PhoneBackend(Protocol):
    def find(
        self,
        frame: Any,
        regions: Sequence[BBox],
    ) -> tuple[PhoneObservation, ...]: ...
