from types import SimpleNamespace

from platforms.maixcam.pose_adapter import adapt_objects


def make_object(points, *, score=0.8, x=20, y=10, w=100, h=180):
    return SimpleNamespace(
        x=x,
        y=y,
        w=w,
        h=h,
        score=score,
        class_id=0,
        points=points,
    )


def visible_points():
    return [coordinate for index in range(17) for coordinate in (30 + index, 40 + index)]


def test_converts_minus_one_points_to_none():
    points = visible_points()
    points[6:8] = [-1, -1]

    result = adapt_objects([make_object(points)], (320, 224))

    assert len(result) == 1
    assert result[0]["keypoints"][3] is None
    assert result[0]["keypoints"][4] == (34.0, 44.0)


def test_rejects_detection_with_too_few_visible_points():
    points = [-1, -1] * 17
    points[:10] = [10, 11] * 5

    assert adapt_objects([make_object(points)], (320, 224)) == []


def test_rejects_detection_with_too_few_torso_points():
    points = visible_points()
    for index in (5, 6, 11):
        points[index * 2 : index * 2 + 2] = [-1, -1]

    assert adapt_objects([make_object(points)], (320, 224)) == []


def test_rejects_bad_point_vector_length():
    assert adapt_objects([make_object([10, 20] * 16)], (320, 224)) == []


def test_deduplicates_overlapping_people_by_score():
    points = visible_points()
    low = make_object(points, score=0.6)
    high = make_object(points, score=0.9, x=22)

    result = adapt_objects([low, high], (320, 224))

    assert [item["confidence"] for item in result] == [0.9]


def test_keeps_separate_people():
    points = visible_points()

    result = adapt_objects(
        [
            make_object(points, score=0.8, x=10, w=80),
            make_object(points, score=0.7, x=200, w=80),
        ],
        (320, 224),
    )

    assert len(result) == 2
