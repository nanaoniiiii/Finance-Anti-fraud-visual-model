import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {packFrame,parseFrame} from '../shared/preview.js';
const base=process.env.PG_TEST_BASE||'http://127.0.0.1:8787';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(path,method,data,token){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','CF-Connecting-IP':'198.51.100.93',...(token?{Authorization:'Bearer '+token}:{})},body:data?JSON.stringify(data):undefined});
  assert.ok(response.ok,'Fixture API '+path+' '+response.status);return response.json();
}
function socket(path,token){
  const ws=new WebSocket(base.replace(/^http/,'ws')+path,{headers:{Authorization:'Bearer '+token,Origin:new URL(base).origin},perMessageDeflate:false});
  const frames=[],controls=[];
  const opened=new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  ws.on('message',(bytes,binary)=>{if(binary)frames.push(parseFrame(bytes));else controls.push(JSON.parse(bytes.toString()));});
  return{ws,frames,controls,opened,send:value=>ws.send(JSON.stringify(value))};
}
test('真实Worker：25FPS输入跨160ms确认延迟持续转发，慢端有界且乱序确认只释放一帧',{skip:!process.env.PG_TEST_PASSWORD},async()=>{
  const login=await api('/api/auth/login','POST',{email:process.env.PG_TEST_EMAIL,password:process.env.PG_TEST_PASSWORD,client_type:'cli'});
  const owner=login.api_token;
  const invite=await api('/api/enrollments','POST',{name:'并行JPEG窗口回归',platform:'esp32s3',is_test:true},owner);
  const bound=await api('/api/enroll','POST',{code:invite.code,platform:'esp32s3'});
  const path='/api/devices/'+bound.device_id+'/preview/connect';
  const source=socket('/api/device/preview/connect',bound.device_token),fast=socket(path,owner),slow=socket(path,owner);
  const timers=[];
  try{
    await Promise.all([source.opened,fast.opened,slow.opened]);
    for(const viewer of[fast,slow])viewer.send({type:'keepalive',profile:'balanced',view:'raw',codecs:['jpeg'],jpeg_window:8});
    source.send({type:'hello',codecs:['jpeg'],pose:true,camera:true,frame_ack:true,max_inflight_frames:99,low_resource:true});
    const deadline=Date.now()+3000;
    while(!source.controls.some(c=>c.type==='control'&&c.active&&c.source_window===12)&&Date.now()<deadline)await delay(20);
    const control=source.controls.find(c=>c.type==='control'&&c.active&&c.source_window===12);
    assert.equal(control?.fps,15);
    fast.ws.on('message',(bytes,binary)=>{if(binary){const{meta}=parseFrame(bytes);timers.push(setTimeout(()=>{if(fast.ws.readyState===1)fast.send({type:'ack',sequence:meta.sequence,epoch:meta.stream_epoch});},160));}});
    const publish=sequence=>source.ws.send(packFrame({sequence,source_epoch:'parallel-fixture',width:16,height:16,codec:'jpeg',frame_role:'raw',detector_ready:false,tracks:[],risks:[]},new Uint8Array([255,216,255,217])));
    for(let sequence=1;sequence<=30;sequence++){publish(sequence);await delay(40);}
    await delay(300);
    assert.ok(fast.frames.length>=25,'Fast subscriber remains above serial round-trip throughput');
    assert.equal(slow.frames.length,8,'Slow subscriber retains at most eight frames');
    const middle=slow.frames[4].meta;
    slow.send({type:'ack',sequence:middle.sequence,epoch:middle.stream_epoch});
    await delay(60);publish(31);await delay(100);assert.equal(slow.frames.length,9);
    publish(32);await delay(100);assert.equal(slow.frames.length,9,'One out-of-order ACK releases exactly one credit');
    await api('/api/devices/'+bound.device_id,'DELETE',{},owner);
  }finally{for(const timer of timers)clearTimeout(timer);for(const peer of[source,fast,slow])peer.ws.terminate();}
});
