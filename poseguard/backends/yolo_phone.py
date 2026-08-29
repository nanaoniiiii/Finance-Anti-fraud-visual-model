"""Conditional COCO cell-phone detector adapter."""

from __future__ import annotations

from typing import Any, Sequence

from poseguard.types import BBox, PhoneObservation


def _numpy(value: Any):
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    return value


def convert_phone_result(
    result: Any,
    *,
    phone_class: int = 67,
    offset: tuple[int, int] = (0, 0),
) -> tuple[PhoneObservation, ...]:
    if result.boxes is None:
        return ()
    boxes = _numpy(result.boxes.xyxy)
    confidences = _numpy(result.boxes.conf)
    classes = _numpy(result.boxes.cls)
    offset_x, offset_y = offset
    phones = []
    for bbox, confidence, class_id in zip(boxes, confidences, classes):
        if int(class_id) != phone_class:
            continue
        phones.append(
            PhoneObservation(
                bbox=(
                    float(bbox[0]) + offset_x,
                    float(bbox[1]) + offset_y,
                    float(bbox[2]) + offset_x,
                    float(bbox[3]) + offset_y,
                ),
                confidence=float(confidence),
            )
        )
    return tuple(phones)


class YoloPhoneBackend:
    def __init__(
        self,
        model_path: str,
        *,
        enabled: bool = True,
        confidence: float = 0.30,
        phone_class: int = 67,
        device: str | None = None,
    ) -> None:
        self.model_path = model_path
        self.enabled = enabled
        self.confidence = confidence
        self.phone_class = phone_class
        self.device = device
        self._model: Any = None

    @property
    def model_loaded(self) -> bool:
        return self._model is not None

    def _get_model(self):
        if self._model is None:
            try:
                from ultralytics import YOLO
            except ImportError as exc:
                raise RuntimeError(
                    "Ultralytics is unavailable; disable phone detection or install requirements"
                ) from exc
            try:
                self._model = YOLO(self.model_path)
            except Exception as exc:
                raise RuntimeError(f"Unable to load phone model: {self.model_path}") from exc
        return self._model

    def find(
        self,
        frame: Any,
        regions: Sequence[BBox],
    ) -> tuple[PhoneObservation, ...]:
        if not self.enabled or not regions:
            return ()
        height, width = frame.shape[:2]
        x1 = max(int(min(region[0] for region in regions)), 0)
        y1 = max(int(min(region[1] for region in regions)), 0)
        x2 = min(int(max(region[2] for region in regions)), width)
        y2 = min(int(max(region[3] for region in regions)), height)
        if x2 <= x1 or y2 <= y1:
            return ()
        crop = frame[y1:y2, x1:x2]
        kwargs = {
            "source": crop,
            "conf": self.confidence,
            "classes": [self.phone_class],
            "verbose": False,
        }
        if self.device:
            kwargs["device"] = self.device
        results = self._get_model().predict(**kwargs)
        if not results:
            return ()
        return convert_phone_result(
            results[0],
            phone_class=self.phone_class,
            offset=(x1, y1),
        )
