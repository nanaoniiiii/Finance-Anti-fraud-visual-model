import json
import struct
import time

import cv2
import numpy as np

from poseguard.cloud.orientation import CameraOrientation, direction_score
from poseguard.cloud.preview import PreviewPublisher
from poseguard.types import Keypoint, PersonObservation, PersonTrack


def rotate(frame, degrees, mirror=False):
    result = np.rot90(frame, -(degrees//90))
    return np.fliplr(result) if mirror else result


def upright():
    points = [None]*17
    for index, (x,y) in {0:(50,12),1:(45,10),2:(55,10),5:(30,35),6:(70,35),11:(35,70),12:(65,70)}.items():
        points[index] = Keypoint(x,y,.9)
    return PersonObservation(0,(20,0,80,100),.9,tuple(points))


def test_four_corrections_restore_rectangular_input_before_inference():
    image = np.arange(6*9*3,dtype=np.uint8).reshape((6,9,3))
    for installed in (0,90,180,270):
        raw = rotate(image,installed)
        orientation = CameraOrientation(str((360-installed)%360))
        def infer(corrected):
            assert np.array_equal(corrected,image)
            return [upright()]
        corrected, people, _ = orientation.process(raw,0,infer,rotate)
        assert people and corrected.shape == image.shape


def test_auto_recovers_after_mount_changes_while_person_stays_visible():
    image = np.arange(4*7*3,dtype=np.uint8).reshape((4,7,3))
    orientation = CameraOrientation()
    infer = lambda candidate: [upright()] if candidate.shape == image.shape and np.array_equal(candidate,image) else []
    for now in (0,.7,1.4): orientation.process(image,now,infer,rotate)
    for now in (7,13,19):
        corrected, people, _ = orientation.process(rotate(image,90),now,infer,rotate)
    assert orientation.rotation == 270 and people and np.array_equal(corrected,image)


def test_upper_body_sideways_scores_lower_than_upright_without_hips():
    person = upright()
    p = list(person.keypoints);p[11]=p[12]=None
    standing = dict(bbox=(0,0,100,100),confidence=.9,keypoints=[None if k is None else (k.x,k.y,k.confidence) for k in p])
    sideways = dict(standing,keypoints=[None if k is None else (100-k[1],k[0],k[2]) for k in standing['keypoints']])
    assert direction_score([standing]) > direction_score([sideways])*1.2+.12


def test_preview_idle_does_not_copy_frames_and_active_uses_latest_only(tmp_path):
    copied=[]
    publisher=PreviewPublisher(dict(data_directory=str(tmp_path)),None,lambda frame:copied.append(frame) or frame)
    camera=dict(rotation='0',mirror=False,version=1)
    for seq in range(1,5):publisher.submit(seq,[],[],20,seq,camera=camera,rotation=0,mirror=False)
    assert not copied and publisher.pending is None
    publisher.lease=time.monotonic()+8
    publisher.submit(5,[],[],20,5,camera=camera,rotation=0,mirror=False)
    publisher.next_frame=0
    publisher.submit(6,[],[],20,6,camera=camera,rotation=0,mirror=False)
    assert publisher.pending[0] == 6 and copied == [5,6]


def test_preview_normalizes_pose_against_detection_image():
    p = upright()
    track=PersonTrack(2,p.bbox,p.confidence,p.keypoints,(50,50),100,0,1)
    meta=dict(sequence=1,source_epoch='test',codec='jpeg',keyframe=True,inference_fps=20)
    image=np.zeros((100,100,3),dtype=np.uint8)
    ok,jpeg=cv2.imencode('.jpg',image);assert ok
    packet=PreviewPublisher.packet(jpeg.tobytes(),100,100,[track],[],meta)
    size=struct.unpack_from('>I',packet,4)[0]
    m=json.loads(packet[8:8+size]); payload=packet[8+size:]
    assert packet[:4] == b'PGV1' and m['tracks'][0]['keypoints'][0] == [.5,.12,.9]
    assert cv2.imdecode(np.frombuffer(payload,dtype=np.uint8),cv2.IMREAD_COLOR).shape == image.shape
