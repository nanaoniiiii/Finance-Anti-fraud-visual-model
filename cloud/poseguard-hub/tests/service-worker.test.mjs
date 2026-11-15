import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import vm from 'node:vm';
test('离线缓存拒绝把SPA回退HTML缓存为JS；损坏旧条目重新联网获取',async()=>{
  const handlers={},stored=new Map();let requests=0;
  const context={URL,Response,location:{origin:'https://fixture.test'},self:{addEventListener:(name,handler)=>handlers[name]=handler},caches:{open:async()=>({match:async request=>stored.get(request.url),put:async(request,response)=>stored.set(request.url,response)})},fetch:async()=>{requests++;return new Response('export const ready=true',{headers:{'Content-Type':'text/javascript'}});}};
  vm.createContext(context);vm.runInContext(await fs.readFile(new URL('../public/sw.js',import.meta.url),'utf8'),context);
  const url='https://fixture.test/assets/current.js';stored.set(url,new Response('<!doctype html>',{headers:{'Content-Type':'text/html'}}));
  let response;handlers.fetch({request:{url,method:'GET',mode:'cors'},respondWith:value=>response=value});assert.match(await(await response).text(),/ready=true/);assert.equal(requests,1);
  handlers.fetch({request:{url,method:'GET',mode:'cors'},respondWith:value=>response=value});assert.equal((await response).headers.get('Content-Type'),'text/javascript');assert.equal(requests,1);
  context.fetch=async()=>new Response('<!doctype html>',{headers:{'Content-Type':'text/html'}});
  const missing='https://fixture.test/assets/missing.js';handlers.fetch({request:{url:missing,method:'GET',mode:'cors'},respondWith:value=>response=value});await response;assert.equal(stored.has(missing),false);
});
