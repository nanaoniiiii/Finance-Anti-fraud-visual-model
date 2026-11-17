import test from 'node:test';
import assert from 'node:assert/strict';
import {jpegCredit,sourceCredit,clearCredits,consumeCredit,hasCredit,spendCredit,JPEG_CREDIT_BYTES} from '../shared/preview-credit.js';
import {storeFrame,selectFrame} from '../src/preview-frames.js';
test('Parallel JPEG decode cannot restore a frame from an older installation direction',()=>{
  const store={};let released=0;
  const fresh={image:{close(){}},meta:{frame_role:'raw',camera_applied_version:2}};
  storeFrame(store,fresh);
  const old={image:{close(){released++;}},meta:{frame_role:'pose',camera_applied_version:1}};
  assert.equal(storeFrame(store,old),false);assert.equal(released,1);assert.equal(selectFrame(store,true),fresh);
});
test('JPEG windows are opt-in and bounded by both frame count and bytes',()=>{
  assert.equal(jpegCredit(undefined),1);assert.equal(jpegCredit(999),8);assert.equal(sourceCredit(999),12);
  const state={jpegWindow:8};clearCredits(state);
  for(let i=1;i<=8;i++){assert.equal(hasCredit(state,'jpeg',1024),true);spendCredit(state,i,1024,i*100,'jpeg');}
  assert.equal(hasCredit(state,'jpeg',1024),false);
  assert.equal(consumeCredit(state,5,1000),true);
  assert.deepEqual(state.outstanding,[1,2,3,4,6,7,8]);
  assert.equal(state.sentAt,100);assert.equal(hasCredit(state,'jpeg',1024),true);
  assert.equal(consumeCredit(state,5,1000),false);
});
test('Large images consume the byte budget, with only one oversize image allowed',()=>{
  const state={jpegWindow:8};clearCredits(state);
  spendCredit(state,1,JPEG_CREDIT_BYTES,100,'jpeg');
  assert.equal(hasCredit(state,'jpeg',1),false);
  consumeCredit(state,1,200);
  assert.equal(hasCredit(state,'jpeg',600*1024),true);
  spendCredit(state,2,600*1024,210,'jpeg');
  assert.equal(hasCredit(state,'jpeg',1),false);
});
test('Legacy H264 cumulative acknowledgements and credit reset remain compatible',()=>{
  const state={jpegWindow:1};clearCredits(state);
  for(let i=1;i<=4;i++)spendCredit(state,i,1024,i*100,'h264');
  assert.equal(hasCredit(state,'h264',1024),false);
  consumeCredit(state,3,1000);assert.deepEqual(state.outstanding,[4]);assert.equal(state.sentAt,400);
  clearCredits(state);assert.equal(hasCredit(state,'h264',1024),true);
});
