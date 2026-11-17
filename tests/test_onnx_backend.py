import numpy as np
import pytest
from poseguard.backends.onnx_yolo import OnnxPoseBackend,OnnxPhoneBackend

def test_decoded_pose_nms_coordinate_mapping_and_low_confidence_points(monkeypatch):
    backend=OnnxPoseBackend('not-loaded.onnx')
    row=np.zeros(56,dtype=np.float32);row[:5]=[160,160,100,200,.9]
    row[5:]=np.tile([160,120,.8],17);row[7]=.1
    predictions=np.array([row,row.copy()]);predictions[1,4]=.7
    monkeypatch.setattr(backend,'run',lambda image:(predictions,(80,0,.5,320,640)))
    people=backend.infer(np.zeros((640,320,3),dtype=np.uint8))
    assert len(people)==1;assert people[0].bbox==pytest.approx((60,120,260,520))
    assert people[0].keypoints[0]is None
    assert people[0].keypoints[1].x==pytest.approx(160)
    assert people[0].keypoints[1].y==pytest.approx(240)

def test_phone_region_offset_and_class_filter(monkeypatch):
    backend=OnnxPhoneBackend('not-loaded.onnx');row=np.zeros(84,dtype=np.float32)
    row[:4]=[30,40,20,20];row[4+67]=.85;other=row.copy();other[4+67]=.8;other[4+1]=.99
    monkeypatch.setattr(backend,'run',lambda image:(np.array([row,other]),(0,0,1,100,100)))
    phones=backend.find(np.zeros((300,300,3),dtype=np.uint8),[(50,60,150,160)])
    assert len(phones)==1;assert phones[0].bbox==pytest.approx((70,90,90,110))
    assert backend.find(np.zeros((1,1,3),dtype=np.uint8),[])==()
