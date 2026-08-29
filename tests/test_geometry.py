from poseguard.risk.geometry import (
    candidate_phone_sides,
    hand_near_ear,
    inside_region,
    is_standing,
    nearby_people,
    phone_matches_side,
)
from poseguard.types import Keypoint, PersonObservation, PhoneObservation


def _person(points, bbox=(0.0, 0.0, 100.0, 200.0)):
    keypoints = [None] * 17
    for index, xy in points.items():
        keypoints[index] = Keypoint(*xy, confidence=0.95)
    return PersonObservation(0, bbox, 0.9, tuple(keypoints))


def test_hand_near_ear_is_scale_normalized():
    assert hand_near_ear((48, 42), (50, 40), body_height=100, ratio=0.08)
    assert not hand_near_ear((48, 42), (70, 40), body_height=100, ratio=0.08)


def test_candidate_phone_side_requires_arm_geometry_and_standing_pose():
    person = _person(
        {
            3: (38, 35),
            5: (40, 65),
            7: (33, 55),
            9: (39, 39),
            11: (42, 120),
            12: (58, 120),
            15: (43, 190),
            16: (57, 190),
        }
    )

    assert is_standing(person)
    assert candidate_phone_sides(person, wrist_ear_ratio=0.13) == ("left",)


def test_missing_leg_evidence_is_not_called_standing():
    person = _person({3: (38, 35), 5: (40, 65), 7: (33, 55), 9: (39, 39)})

    assert not is_standing(person)
    assert candidate_phone_sides(person, wrist_ear_ratio=0.13) == ()


def test_inside_region_uses_normalized_frame_coordinates():
    assert inside_region((320, 240), (640, 480), (0.1, 0.1, 0.9, 0.9))
    assert not inside_region((10, 10), (640, 480), (0.1, 0.1, 0.9, 0.9))


def test_nearby_people_is_body_scale_normalized():
    assert nearby_people((100, 100), 200, (180, 100), 180, ratio=0.5)
    assert not nearby_people((100, 100), 200, (260, 100), 180, ratio=0.5)


def test_phone_box_must_intersect_hand_ear_corridor():
    phone = PhoneObservation(bbox=(35, 34, 44, 52), confidence=0.8)
    person = _person(
        {
            3: (38, 35),
            5: (40, 65),
            7: (33, 55),
            9: (39, 39),
            11: (42, 120),
            12: (58, 120),
            15: (43, 190),
            16: (57, 190),
        }
    )

    assert phone_matches_side(person, phone, "left")
    assert not phone_matches_side(
        person,
        PhoneObservation(bbox=(80, 140, 95, 170), confidence=0.9),
        "left",
    )
