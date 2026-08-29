"""Ultralytics pose adapter isolated from tracking and business rules."""

from __future__ import annotations

from typing import Any

from poseguard.types import Keypoint, PersonObservation


def _numpy(value: Any):
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    return value


def convert_pose_result(
    result: Any,
    *,
    keypoint_confidence: float = 0.25,
) -> tuple[PersonObservation, ...]:
    if result.boxes is None or result.keypoints is None:
        return ()
    boxes = _numpy(result.boxes.xyxy)
    confidences = _numpy(result.boxes.conf)
    coordinates = _numpy(result.keypoints.xy)
    point_confidences = (
        _numpy(result.keypoints.conf)
        if getattr(result.keypoints, "conf", None) is not None
        else None
    )
    observations: list[PersonObservation] = []
    for index, (bbox, confidence, points) in enumerate(
        zip(boxes, confidences, coordinates)
    ):
        keypoints = []
        for point_index, point in enumerate(points):
            point_confidence = (
                float(point_confidences[index][point_index])
                if point_confidences is not None
                else 1.0
            )
            if point_confidence < keypoint_confidence:
                keypoints.append(None)
            else:
                keypoints.append(
                    Keypoint(float(point[0]), float(point[1]), point_confidence)
                )
        if len(keypoints) != 17:
            continue
        observations.append(
            PersonObservation(
                detection_index=index,
                bbox=tuple(float(value) for value in bbox),
                confidence=float(confidence),
                keypoints=tuple(keypoints),
            )
        )
    return tuple(observations)


class YoloPoseBackend:
    def __init__(
        self,
        model_path: str,
        *,
        confidence: float = 0.35,
        keypoint_confidence: float = 0.25,
        device: str | None = None,
    ) -> None:
        self.model_path = model_path
        self.confidence = confidence
        self.keypoint_confidence = keypoint_confidence
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
                    "Ultralytics is unavailable; install requirements before pose inference"
                ) from exc
            try:
                self._model = YOLO(self.model_path)
            except Exception as exc:
                raise RuntimeError(f"Unable to load pose model: {self.model_path}") from exc
        return self._model

    def infer(self, frame: Any) -> tuple[PersonObservation, ...]:
        kwargs = {"source": frame, "conf": self.confidence, "verbose": False}
        if self.device:
            kwargs["device"] = self.device
        results = self._get_model().predict(**kwargs)
        if not results:
            return ()
        return convert_pose_result(
            results[0],
            keypoint_confidence=self.keypoint_confidence,
        )
