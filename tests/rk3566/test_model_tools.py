from platforms.rk3566.tools.export_pose_onnx import normalize_output_shape
from platforms.rk3566.tools.prepare_inputs import sample_indices


def test_sampling_and_pose_contract():
    assert sample_indices(631, 5) == [0, 157, 315, 472, 630]
    assert normalize_output_shape([1, 56, 2100]) == {
        "layout": "BCN",
        "channels": 56,
        "anchors": 2100,
        "keypoints": 17,
    }
