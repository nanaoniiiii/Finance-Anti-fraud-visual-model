"""CPU-only ONNX adapters for self-contained Windows/Linux distributions."""
from __future__ import annotations
from pathlib import Path
import cv2
import numpy as np
from poseguard.types import Keypoint, PersonObservation, PhoneObservation


class OnnxYolo:
    def __init__(self,path,confidence):
        self.path=str(path);self.confidence=confidence;self.session=None

    def run(self,image):
        if self.session is None:
            import onnxruntime as ort
            if not Path(self.path).is_file():raise RuntimeError('Model file missing: '+self.path)
            settings=ort.SessionOptions();settings.intra_op_num_threads=4;settings.inter_op_num_threads=1
            self.session=ort.InferenceSession(self.path,sess_options=settings,providers=['CPUExecutionProvider'])
            self.input=self.session.get_inputs()[0]
            if len(self.input.shape)!=4 or not all(isinstance(n,int)and n>0 for n in self.input.shape):raise RuntimeError('A static NCHW YOLO ONNX model is required')
        height,width=image.shape[:2];target_height,target_width=self.input.shape[2:]
        scale=min(target_width/width,target_height/height);nw,nh=round(width*scale),round(height*scale)
        left,top=(target_width-nw)//2,(target_height-nh)//2
        canvas=np.full((target_height,target_width,3),114,dtype=np.uint8)
        canvas[top:top+nh,left:left+nw]=cv2.resize(image,(nw,nh))
        tensor=np.ascontiguousarray(canvas[:,:,::-1].transpose(2,0,1)[None],dtype=np.float32)/255
        output=self.session.run(None,{self.input.name:tensor})
        if len(output)!=1 or output[0].ndim!=3:raise RuntimeError('Expected a decoded YOLO output tensor')
        predictions=output[0][0]
        if predictions.shape[0] in (56,84):predictions=predictions.T
        return predictions,(left,top,scale,width,height)

    @staticmethod
    def box(raw,transform):
        left,top,scale,width,height=transform;x,y,w,h=map(float,raw)
        return (max(0,(x-w/2-left)/scale),max(0,(y-h/2-top)/scale),min(width-1,(x+w/2-left)/scale),min(height-1,(y+h/2-top)/scale))

    def select(self,predictions,scores,transform):
        mask=np.flatnonzero(scores>=self.confidence)
        boxes=[self.box(predictions[i,:4],transform)for i in mask]
        indexes=cv2.dnn.NMSBoxes([(b[0],b[1],max(0,b[2]-b[0]),max(0,b[3]-b[1]))for b in boxes],scores[mask].astype(float).tolist(),self.confidence,.65)
        return [(int(mask[int(i)]),boxes[int(i)])for i in np.asarray(indexes).reshape(-1)]


class OnnxPoseBackend(OnnxYolo):
    def __init__(self,path,confidence=.35,keypoint_confidence=.25):
        super().__init__(path,confidence);self.keypoint_confidence=keypoint_confidence

    def infer(self,image):
        predictions,transform=self.run(image)
        if predictions.shape[1]!=56:raise RuntimeError('Pose ONNX must output 4 box + 1 score + 51 keypoint values')
        left,top,scale,width,height=transform;observations=[]
        for index,box in self.select(predictions,predictions[:,4],transform):
            points=[]
            for x,y,confidence in predictions[index,5:].reshape(17,3):
                points.append(Keypoint(float(np.clip((x-left)/scale,0,width-1)),float(np.clip((y-top)/scale,0,height-1)),float(confidence))if confidence>=self.keypoint_confidence else None)
            observations.append(PersonObservation(detection_index=len(observations),bbox=box,confidence=float(predictions[index,4]),keypoints=tuple(points)))
        return tuple(observations)


class OnnxPhoneBackend(OnnxYolo):
    def __init__(self,path,confidence=.3,phone_class=67):
        super().__init__(path,confidence);self.phone_class=phone_class

    def find(self,image,regions):
        if not regions:return ()
        height,width=image.shape[:2]
        x1=max(0,int(min(b[0]for b in regions)));y1=max(0,int(min(b[1]for b in regions)))
        x2=min(width,int(max(b[2]for b in regions)));y2=min(height,int(max(b[3]for b in regions)))
        if x2<=x1 or y2<=y1:return ()
        predictions,transform=self.run(image[y1:y2,x1:x2])
        if predictions.shape[1]!=84:raise RuntimeError('Phone ONNX must have 80 COCO class scores')
        scores=predictions[:,4+self.phone_class].copy()
        scores[np.argmax(predictions[:,4:],axis=1)!=self.phone_class]=0
        return tuple(PhoneObservation(bbox=(box[0]+x1,box[1]+y1,box[2]+x1,box[3]+y1),confidence=float(scores[index]))for index,box in self.select(predictions,scores,transform))
