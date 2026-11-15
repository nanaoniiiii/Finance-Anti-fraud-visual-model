import test from 'node:test';import assert from 'node:assert/strict';
import {coalesceReads}from'../src/request-coalescer.js';
test('同一读取突发只发送一次，完成后新的刷新仍重新读取',async()=>{
  let calls=0,resolve;const request=coalesceReads(async()=>{calls++;return new Promise(done=>resolve=done);});
  const readers=Array.from({length:20},()=>request('/events'));await Promise.resolve();assert.equal(calls,1);resolve({events:[]});await Promise.all(readers);const next=request('/events');await Promise.resolve();assert.equal(calls,2);resolve({events:[]});await next;
});
test('保存操作使旧读取失效，旧结果结束不能删除保存后的新读取',async()=>{
  const resolvers=[];let calls=0;const request=coalesceReads((path,options)=>{if(options.method)return{saved:true};calls++;return new Promise(resolve=>resolvers.push(resolve));});
  const old=request('/settings');await Promise.resolve();await request('/settings',{method:'PUT'});const current=request('/settings');await Promise.resolve();resolvers[0]({old:true});await old;assert.equal(request('/settings'),current);resolvers[1]({saved:true});await current;assert.equal(calls,2);
});
test('错误与账号切换会清除共享读取，不复用其他账号的响应',async()=>{
  let calls=0;const request=coalesceReads(async()=>{calls++;if(calls===1)throw new Error('network');return{owner:'new-account'};});await assert.rejects(request('/personal-messages'));const current=await request('/personal-messages');assert.equal(current.owner,'new-account');request.clear();await request('/personal-messages');assert.equal(calls,3);
});
