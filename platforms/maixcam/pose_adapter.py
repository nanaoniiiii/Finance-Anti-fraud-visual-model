"""Translate MaixPy YOLO11 pose objects into compact neutral records."""

import math


KEYPOINT_COUNT = 17
TORSO_INDICES = (5, 6, 11, 12)

DEFAULTS = {
    "pose_confidence": 0.35,
    "minimum_visible_keypoints": 6,
    "minimum_torso_keypoints": 3,
    "minimum_bbox_area_ratio": 0.015,
    "maximum_bbox_area_ratio": 0.80,
    "maximum_outside_ratio": 0.20,
    "duplicate_iou": 0.45,
    "duplicate_center_body_ratio": 0.25,
}


def adapt_objects(objects, frame_size, config=None):
    """Return quality-filtered observations from MaixPy detection objects."""
    settings = dict(DEFAULTS)
    if config:
        settings.update(config)

    observations = []
    for detection_index, obj in enumerate(objects):
        observation = adapt_object(obj, detection_index, frame_size, settings)
        if observation is not None:
            observations.append(observation)
    return deduplicate(observations, settings)


def adapt_object(obj, detection_index, frame_size, settings):
    """Convert one result, returning ``None`` when its evidence is invalid."""
    try:
        if int(getattr(obj, "class_id", 0)) != 0:
            return None
        points = list(obj.points)
        if len(points) != KEYPOINT_COUNT * 2:
            return None
        keypoints = tuple(
            None
            if float(points[index]) < 0 or float(points[index + 1]) < 0
            else (float(points[index]), float(points[index + 1]))
            for index in range(0, len(points), 2)
        )
        bbox = (
            float(obj.x),
            float(obj.y),
            float(obj.x + obj.w),
            float(obj.y + obj.h),
        )
        confidence = float(obj.score)
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None

    if not passes_quality(bbox, keypoints, confidence, frame_size, settings):
        return None
    return {
        "detection_index": detection_index,
        "bbox": bbox,
        "confidence": confidence,
        "keypoints": keypoints,
    }


def passes_quality(bbox, keypoints, confidence, frame_size, settings):
    if confidence < settings["pose_confidence"]:
        return False

    visible = sum(point is not None for point in keypoints)
    torso_visible = sum(keypoints[index] is not None for index in TORSO_INDICES)
    if visible < settings["minimum_visible_keypoints"]:
        return False
    if torso_visible < settings["minimum_torso_keypoints"]:
        return False

    width, height = frame_size
    if width <= 0 or height <= 0:
        return False
    x1, y1, x2, y2 = bbox
    box_width = x2 - x1
    box_height = y2 - y1
    if box_width <= 0 or box_height <= 0:
        return False

    area = box_width * box_height
    area_ratio = area / float(width * height)
    if not (
        settings["minimum_bbox_area_ratio"]
        <= area_ratio
        <= settings["maximum_bbox_area_ratio"]
    ):
        return False

    clipped_width = max(min(x2, width) - max(x1, 0.0), 0.0)
    clipped_height = max(min(y2, height) - max(y1, 0.0), 0.0)
    inside_area = clipped_width * clipped_height
    outside_ratio = 1.0 - inside_area / area
    return outside_ratio <= settings["maximum_outside_ratio"]


def deduplicate(observations, settings):
    """Keep the strongest result from each overlapping-person cluster."""
    retained = []
    for candidate in sorted(
        observations,
        key=lambda item: item["confidence"],
        reverse=True,
    ):
        if any(_duplicates(candidate, existing, settings) for existing in retained):
            continue
        retained.append(candidate)
    return retained


def _duplicates(first, second, settings):
    if _iou(first["bbox"], second["bbox"]) <= settings["duplicate_iou"]:
        return False
    first_center = _center(first["bbox"])
    second_center = _center(second["bbox"])
    minimum_height = min(_height(first["bbox"]), _height(second["bbox"]))
    return math.dist(first_center, second_center) < (
        minimum_height * settings["duplicate_center_body_ratio"]
    )


def _center(bbox):
    return (bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0


def _height(bbox):
    return max(bbox[3] - bbox[1], 1.0)


def _iou(first, second):
    x1 = max(first[0], second[0])
    y1 = max(first[1], second[1])
    x2 = min(first[2], second[2])
    y2 = min(first[3], second[3])
    intersection = max(x2 - x1, 0.0) * max(y2 - y1, 0.0)
    first_area = max(first[2] - first[0], 0.0) * max(first[3] - first[1], 0.0)
    second_area = max(second[2] - second[0], 0.0) * max(second[3] - second[1], 0.0)
    union = first_area + second_area - intersection
    return intersection / union if union > 0 else 0.0
