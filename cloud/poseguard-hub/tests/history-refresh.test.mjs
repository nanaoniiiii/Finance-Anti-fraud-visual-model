import test from 'node:test';
import assert from 'node:assert/strict';
import {needsHistory} from '../src/history-refresh.js';
test('Idle refreshes keep health current without rereading unchanged history every 20 seconds',()=>{
  const snapshot={cursor:100,loadedAt:1000};
  assert.equal(needsHistory(snapshot,100,{passive:true,time:21000}),false);
  assert.equal(needsHistory(snapshot,100,{passive:true,time:121000}),true);
  assert.equal(needsHistory(snapshot,100,{time:21000}),true);
});
test('Initial state, new changes and changes arriving during a snapshot always require history',()=>{
  assert.equal(needsHistory(null,100,{passive:true,time:1000}),true);
  assert.equal(needsHistory({cursor:100,loadedAt:1000},101,{passive:true,time:1001}),true);
  // Snapshot marker is the cursor captured before its requests were started.
  const completedOldSnapshot={cursor:99,loadedAt:2000};
  assert.equal(needsHistory(completedOldSnapshot,100,{passive:true,time:2001}),true);
});
