import test from 'node:test';import assert from 'node:assert/strict';
import {previewView,wantedFrames,acceptsFrame}from'../shared/preview-views.js';
test('按观看模式请求共享源，旧接收端继续订阅全部',()=>{
  assert.equal(previewView(undefined),'both');assert.deepEqual(wantedFrames(['raw']),{want_raw:true,want_pose:false});
  assert.deepEqual(wantedFrames(['pose']),{want_raw:false,want_pose:true});assert.deepEqual(wantedFrames(['raw','pose']),{want_raw:true,want_pose:true});
  assert.deepEqual(wantedFrames([]),{want_raw:false,want_pose:false});
});
test('各接收端只接收所需画面，检测未就绪和旧设备保持可看',()=>{
  assert.equal(acceptsFrame('raw',{frame_role:'pose',detector_ready:true}),false);
  assert.equal(acceptsFrame('pose',{frame_role:'raw',detector_ready:true}),false);
  assert.equal(acceptsFrame('pose',{frame_role:'pose',detector_ready:true}),true);
  assert.equal(acceptsFrame('pose',{frame_role:'raw',detector_ready:false}),true);
  assert.equal(acceptsFrame('raw',{}),true);assert.equal(acceptsFrame('pose',{}),true);
});
