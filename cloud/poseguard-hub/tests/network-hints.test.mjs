import test from 'node:test';import assert from 'node:assert/strict';
import {networkHints,publicIpv4} from '../worker/network-hints.js';
test('动态网络候选拒绝本地/保留地址，保留公网IPv4',()=>{
  for(const ip of['127.0.0.1','10.0.0.2','172.31.0.1','192.168.31.1','169.254.2.1','100.64.0.1','198.18.0.1','224.0.0.1','1.2.3.256','bad'])assert.equal(publicIpv4(ip),false,ip);
  assert.equal(publicIpv4('104.21.68.137'),true);
});
test('DoH候选有过期时间，仅使用A记录，缓存不触发重复查询',async()=>{
  let calls=0;const env={PUBLIC_ORIGIN:'https://test.example',PREVIEW_CDN_DNS_NAME:'test-'+Date.now()+'.workers.dev'};
  const query=async()=>{calls++;return new Response(JSON.stringify({Status:0,Answer:[{type:1,data:'104.21.68.137',TTL:120},{type:1,data:'10.0.0.1',TTL:120},{type:28,data:'::1',TTL:120}]}));};
  const result=await networkHints(env,query);assert.deepEqual(result.addresses,['104.21.68.137']);assert.equal(result.host,'test.example');assert.ok(result.expires_unix>Date.now()/1000);assert.ok(result.expires_unix<Date.now()/1000+121);
  assert.deepEqual(await networkHints(env,query),result);assert.equal(calls,1);
  assert.equal(await networkHints({...env,PREVIEW_CDN_DNS_NAME:'failed.workers.dev'},async()=>{throw new Error('offline');}),undefined);
});
