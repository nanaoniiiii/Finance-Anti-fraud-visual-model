from pathlib import Path

import numpy as np

from platforms.rk3566.tools.compare_outputs import (
    combine_model_outputs,
    initialize_quantized_simulator,
)
from platforms.rk3566.tools.export_pose_onnx import (
    inspect_onnx_output,
    normalize_output_shape,
    split_pose_output_scales,
)
from platforms.rk3566.tools.prepare_inputs import sample_indices


def test_model_toolchain_uses_rknn_compatible_onnx_without_debug_dumps():
    repo_root = Path(__file__).resolve().parents[2]
    dockerfile = (repo_root / "platforms/rk3566/docker/model.Dockerfile").read_text(
        encoding="utf-8"
    )
    converter = (
        repo_root / "platforms/rk3566/tools/convert_pose_rknn.py"
    ).read_text(encoding="utf-8")

    assert "onnx==1.16.1" in dockerfile
    assert "RKNN(verbose=False)" in converter


def test_sampling_and_pose_contract():
    assert sample_indices(631, 5) == [0, 157, 315, 472, 630]
    assert normalize_output_shape([1, 56, 2100]) == {
        "layout": "BCN",
        "channels": 56,
        "anchors": 2100,
        "keypoints": 17,
    }


def test_quantized_simulator_builds_from_onnx_instead_of_loading_rknn():
    calls = []

    class FakeRunner:
        def config(self, **kwargs):
            calls.append(("config", kwargs))
            return 0

        def load_onnx(self, **kwargs):
            calls.append(("load_onnx", kwargs))
            return 0

        def build(self, **kwargs):
            calls.append(("build", kwargs))
            return 0

        def init_runtime(self):
            calls.append(("init_runtime", {}))
            return 0

    initialize_quantized_simulator(
        FakeRunner(), Path("pose.onnx"), Path("dataset.txt")
    )

    assert [name for name, _ in calls] == [
        "config",
        "load_onnx",
        "build",
        "init_runtime",
    ]
    assert calls[2][1] == {
        "do_quantization": True,
        "dataset": "dataset.txt",
    }


def test_split_pose_outputs_keep_scores_on_independent_scales(tmp_path):
    import onnx
    from onnx import TensorProto, helper

    anchors = 10
    inputs = [
        helper.make_tensor_value_info("boxes_raw", TensorProto.FLOAT, [1, 4, anchors]),
        helper.make_tensor_value_info("scores_raw", TensorProto.FLOAT, [1, 1, anchors]),
        helper.make_tensor_value_info(
            "keypoints_raw", TensorProto.FLOAT, [1, 51, anchors]
        ),
    ]
    output = helper.make_tensor_value_info(
        "output0", TensorProto.FLOAT, [1, 56, anchors]
    )
    graph = helper.make_graph(
        [
            helper.make_node(
                "Concat",
                [item.name for item in inputs],
                ["output0"],
                axis=1,
                name="pose_concat",
            )
        ],
        "pose",
        inputs,
        [output],
    )
    source = tmp_path / "source.onnx"
    target = tmp_path / "split.onnx"
    onnx.save(helper.make_model(graph, opset_imports=[helper.make_opsetid("", 12)]), source)

    contract = split_pose_output_scales(source, target)

    assert contract == {
        "layout": "SPLIT_BCN",
        "channels": 56,
        "anchors": anchors,
        "keypoints": 17,
        "outputs": 4,
    }
    assert inspect_onnx_output(target) == contract
    model = onnx.load(target)
    assert [item.name for item in model.graph.output] == [
        "pose_boxes",
        "pose_scores",
        "pose_keypoints",
        "pose_keypoint_scores",
    ]
    assert any(node.op_type == "Gather" for node in model.graph.node)


def test_combine_model_outputs_restores_56_channel_contract():
    anchors = 2
    boxes = np.arange(4 * anchors, dtype=np.float32).reshape(1, 4, anchors)
    scores = np.array([[[0.7, 0.8]]], dtype=np.float32)
    keypoints = np.arange(51 * anchors, dtype=np.float32).reshape(1, 51, anchors)
    keypoint_scores = np.full((1, 17, anchors), 0.9, dtype=np.float32)

    combined = combine_model_outputs(
        [boxes, scores, keypoints, keypoint_scores]
    )

    assert combined.shape == (1, 56, anchors)
    np.testing.assert_array_equal(combined[:, :4], boxes)
    np.testing.assert_array_equal(combined[:, 4:5], scores)
    for point in range(17):
        np.testing.assert_array_equal(
            combined[:, 7 + point * 3], keypoint_scores[:, point]
        )
