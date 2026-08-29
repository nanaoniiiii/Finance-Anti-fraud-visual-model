from poseguard import __version__
from poseguard.types import Keypoint, PersonObservation


def test_package_exposes_version_and_observation_types():
    point = Keypoint(x=10.0, y=20.0, confidence=0.9)
    observation = PersonObservation(
        detection_index=0,
        bbox=(0.0, 0.0, 50.0, 100.0),
        confidence=0.9,
        keypoints=(point,) * 17,
    )

    assert __version__
    assert len(observation.keypoints) == 17
