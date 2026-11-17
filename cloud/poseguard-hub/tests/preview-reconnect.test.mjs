import test from 'node:test';import assert from 'node:assert/strict';
import {previewRetryDelay} from '../src/preview-reconnect.js';
test('网络中断和服务重启自动恢复预览，重试间隔有上限',()=>{
  assert.deepEqual([0,1,2,3,4,5].map(n=>previewRetryDelay(1006,n)),[500,1000,2000,4000,8000,8000]);
  for(const code of[1001,1011,1012,1013])assert.ok(previewRetryDelay(code)>=500);
  assert.equal(previewRetryDelay(4001),0);
});
test('鉴权失败、慢端暂停和主动停止不会自动再次打开预览',()=>{
  for(const code of[1000,1008,4002])assert.equal(previewRetryDelay(code),null);
});
test('页面后台和App后台取消待执行的预览恢复',()=>{
  assert.equal(previewRetryDelay(1006,0,'',false),null);
  assert.equal(previewRetryDelay(1006,0,'app_background'),null);
  assert.equal(previewRetryDelay(1006,0,'Viewer stopped'),null);
});
