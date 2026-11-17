"""The smaller student must inherit physical coordinates, not raw cell offsets."""
import sys
import unittest
from pathlib import Path
import numpy as np
import torch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from distill_pose import resize_teacher
from quantize_pose import decode


class Geometry(unittest.TestCase):
    def test_teacher_cell_at_edge_of_three_by_three_region(self):
        boxes,scores,keys=[],[],[]
        for size in (48,24,12):
            boxes.append(torch.zeros(1,64,size,size))
            scores.append(torch.full((1,1,size,size),-20.))
            keys.append(torch.zeros(1,51,size,size))
        scores[0][0,0,2,2]=2
        values=tuple(v for pair in zip(boxes,scores)for v in pair)+tuple(keys)
        result=resize_teacher(values,1/3)
        self.assertEqual(result[1].shape,(1,1,16,16))
        self.assertAlmostEqual(float(result[1][0,0,0,0]),2)
        # Physical decoded keypoint (2*0+2)*8 becomes 16/3 pixels.
        actual=decode([v.numpy()for v in result])
        self.assertEqual(len(actual),1)
        np.testing.assert_allclose(actual[0]['keypoints'][:,:2],16/3,atol=.0001)

    def test_high_resolution_teacher_boxes_and_keypoints(self):
        torch.set_num_threads(2)
        boxes,scores,keys=[],[],[]
        for stage,size in enumerate((24,12,6)):
            box=torch.full((1,64,size,size),-20.)
            score=torch.full((1,1,size,size),-20.)
            key=torch.zeros(1,51,size,size)
            if stage==0:
                x,y=13,14
                score[0,0,y,x]=2
                distances=(6,8.25,6.5,6.75)
                for side,distance in enumerate(distances):
                    low=int(distance);fraction=distance-low
                    box[0,side*16+low,y,x]=np.log(1-fraction) if fraction<1 else -20
                    if fraction:box[0,side*16+low+1,y,x]=np.log(fraction)
                for point in range(17):
                    key[0,point*3,y,x]=(100/8-x)/2
                    key[0,point*3+1,y,x]=(80/8-y)/2
                    key[0,point*3+2,y,x]=2
            boxes.append(box);scores.append(score);keys.append(key)
        outputs=tuple(item for pair in zip(boxes,scores) for item in pair)+tuple(keys)
        reference=decode([value.numpy()for value in outputs])
        self.assertEqual(len(reference),1)
        self.assertIs(resize_teacher(outputs,1),outputs)
        for size in (128,160):
            scale=size/192
            converted=resize_teacher(outputs,scale)
            actual=decode([value.numpy()for value in converted])
            self.assertEqual(len(actual),1)
            np.testing.assert_allclose(actual[0]['bbox'],reference[0]['bbox']*scale,atol=.0002)
            np.testing.assert_allclose(actual[0]['keypoints'][:,:2],reference[0]['keypoints'][:,:2]*scale,atol=.0002)
            np.testing.assert_allclose(actual[0]['keypoints'][:,2],reference[0]['keypoints'][:,2],atol=.00001)


if __name__=='__main__':unittest.main()
