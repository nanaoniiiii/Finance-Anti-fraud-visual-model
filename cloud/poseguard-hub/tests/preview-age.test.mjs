import test from 'node:test';import assert from 'node:assert/strict';
import {frameIsStale} from '../src/preview-frames.js';
test('刚收到但传输已延迟十秒的图像不能显示为当前检测状态',()=>{
  const frame={meta:{captured_ms:90000,processing_ms:500,status_age_ms:0}};
  assert.equal(frameIsStale(frame,999,1000,100000),true);
  assert.equal(frameIsStale({meta:{}},0,5000,100000),true);
});
test('新鲜图像与合理的慢模型处理时间分别判断，时钟异常保守标记',()=>{
  assert.equal(frameIsStale({meta:{captured_ms:98500,processing_ms:500,status_age_ms:500}},999,1000,100000),false);
  assert.equal(frameIsStale({meta:{captured_ms:97000,processing_ms:2000,status_age_ms:500}},999,1000,100000),false);
  assert.equal(frameIsStale({meta:{captured_ms:200000}},999,1000,100000),true);
});
