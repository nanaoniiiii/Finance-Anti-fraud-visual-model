import test from 'node:test';
import assert from 'node:assert/strict';
import {storeFrame,selectFrame,clearFrames} from '../src/preview-frames.js';
const frame=(role,id,extra={})=>({image:{closed:0,close(){this.closed++}},meta:{frame_role:role,capture_id:id,camera_applied_version:1,...extra}});
test('慢速推理与原始画面共用连接，切换仅选择相应缓存，不把旧骨架画到新帧',()=>{
  const store={};const raw=frame('raw',10),pose=frame('pose',5),next=frame('raw',11);
  storeFrame(store,raw);storeFrame(store,pose);storeFrame(store,next);
  assert.equal(selectFrame(store,false),next);assert.equal(selectFrame(store,true),pose);assert.equal(raw.image.closed,1);assert.equal(pose.image.closed,0);
  clearFrames(store);assert.equal(next.image.closed,1);assert.equal(pose.image.closed,1);
});
test('旧设备逐帧检测继续同时提供原始与姿态画面，资源仅释放一次',()=>{
  const store={},a=frame(undefined,1),b=frame(undefined,2);storeFrame(store,a);assert.equal(selectFrame(store,true),a);
  storeFrame(store,b);assert.equal(a.image.closed,1);assert.equal(selectFrame(store,false),b);clearFrames(store);assert.equal(b.image.closed,1);
});
test('模型未就绪或检测方向更新时清除旧姿态，等待新的匹配结果',()=>{
  const store={},pose=frame('pose',1);storeFrame(store,pose);const raw=frame('raw',2,{camera_applied_version:2});storeFrame(store,raw);
  assert.equal(pose.image.closed,1);assert.equal(selectFrame(store,true),raw);
  const updated=frame('pose',3,{camera_applied_version:2});storeFrame(store,updated);storeFrame(store,frame('raw',4,{camera_applied_version:2,detector_ready:false}));assert.equal(updated.image.closed,1);
});
