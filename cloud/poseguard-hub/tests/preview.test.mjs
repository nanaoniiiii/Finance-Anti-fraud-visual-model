import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { cameraSettings, packFrame, parseFrame } from "../shared/preview.js";

const base = process.env.PG_TEST_BASE || "http://127.0.0.1:8787";
const password = process.env.PG_TEST_PASSWORD;
const frame = (sequence) =>
  packFrame(
    {
      sequence,
      width: 16,
      height: 16,
      source_epoch: "protocol-fixture",
      codec: "jpeg",
      inference_fps: 0,
      detector_ready: false,
      tracks: [],
      risks: [],
      camera_applied_version: 0,
    },
    new Uint8Array([255, 216, 255, 217]),
  );
test("预览协议：帧与检测元数据配对、长度与方向校验", () => {
  const packet = frame(42),
    parsed = parseFrame(packet);
  assert.equal(parsed.meta.sequence, 42);
  assert.deepEqual([...parsed.payload], [255, 216, 255, 217]);
  const corrupt = packet.slice();
  new DataView(corrupt.buffer).setUint32(4, 1000000);
  assert.throws(() => parseFrame(corrupt));
  assert.throws(() => cameraSettings({ rotation: "45" }));
  assert.throws(() => cameraSettings({ mirror: "true" }));
  assert.throws(() => cameraSettings({ version: -1 }));
});
async function api(path, method, data, token) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
      "CF-Connecting-IP": "198.51.100.91",
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
function connect(path, token) {
  const url = base.replace(/^http/, "ws") + path;
  const ws = new WebSocket(url, {
    headers: { Authorization: "Bearer " + token, Origin: new URL(base).origin },
    perMessageDeflate: false,
  });
  const messages = [];
  const waiters = [];
  let closed;
  ws.on("message", (bytes, binary) => {
    const value = binary ? parseFrame(bytes) : JSON.parse(bytes.toString());
    messages.push({ binary, value });
    for (const notify of waiters.splice(0)) notify();
  });
  const done = new Promise((resolve) =>
    ws.on("close", (code) => {
      closed = code;
      resolve(code);
    }),
  );
  const open = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", () =>
      reject(new Error("Preview WebSocket handshake rejected")),
    );
  });
  const next = async (predicate) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const at = messages.findIndex(predicate);
      if (at >= 0) return messages.splice(at, 1)[0].value;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error("Expected preview message did not arrive");
  };
  return {
    ws,
    open,
    done,
    messages,
    next,
    send: (value) => ws.send(JSON.stringify(value)),
    get closed() {
      return closed;
    },
  };
}
test(
  "真实Worker/D1：按需预览、背压、权限隔离、画面方向及解除设备",
  { skip: !password },
  async () => {
    const login = await api("/api/auth/login", "POST", {
      email: process.env.PG_TEST_EMAIL,
      password,
      client_type: "cli",
    });
    assert.equal(login.status, 200);
    const owner = login.data.api_token;
    const invite = await api(
      "/api/enrollments",
      "POST",
      { platform: "rk3566", name: "预览协议回归（测试）", is_test: true },
      owner,
    );
    assert.equal(invite.status, 201);
    const enrollment = await api("/api/enroll", "POST", {
      code: invite.data.code,
      platform: "rk3566",
    });
    assert.equal(enrollment.status, 201);
    const id = enrollment.data.device_id,
      device = enrollment.data.device_token;
    const source = connect("/api/device/preview/connect", device);
    const viewer = connect("/api/devices/" + id + "/preview/connect", owner);
    try {
      await source.open;
      await viewer.open;
      source.send({
        type: "hello",
        codecs: ["jpeg"],
        pose: false,
        camera: true,
        frame_ack: true,
      });
      source.ws.send(frame(41));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(viewer.messages.filter(message => message.binary).length, 0,
        'wait for viewer mode and keepalive before forwarding frames');
      viewer.send({ type: "keepalive", profile: "low", codecs: ["jpeg"] });
      const wanted = await source.next(
        (m) => !m.binary && m.value.type === "control" && m.value.active,
      );
      assert.equal(wanted.lease_ms, 8000);
      source.ws.send(frame(42));
      const first = await viewer.next((m) => m.binary);
      assert.equal(first.meta.source_sequence, 42);
      const accepted = await source.next(m => !m.binary && m.value.type === 'frame_ack' && m.value.sequence === 42);
      assert.equal(accepted.epoch, 'protocol-fixture');
      source.ws.send(frame(43));
      source.ws.send(frame(44));
      await source.next(m => !m.binary && m.value.type === 'frame_ack' && m.value.sequence === 44);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        viewer.messages.filter((m) => m.binary).length,
        0,
        "unacknowledged images must not queue",
      );
      viewer.send({
        type: "ack",
        sequence: first.meta.sequence,
        epoch: first.meta.stream_epoch,
      });
      source.ws.send(frame(45));
      const latest = await viewer.next((m) => m.binary);
      assert.equal(latest.meta.source_sequence, 45);
      viewer.send({
        type: "ack",
        sequence: latest.meta.sequence,
        epoch: latest.meta.stream_epoch,
      });
      const initial = await api(
        "/api/devices/" + id + "/camera",
        "GET",undefined,owner,
      );
      viewer.send({type:"keepalive",profile:"low",codecs:["jpeg"],view:"raw"});
      await source.next(m=>!m.binary&&m.value.type==="control"&&m.value.want_raw===true&&m.value.want_pose===false);
      const baseFrame=parseFrame(frame(46));
      const roleFrame=(sequence,role,ready=true)=>packFrame({...baseFrame.meta,sequence,frame_role:role,detector_ready:ready},baseFrame.payload);
      source.ws.send(roleFrame(46,"pose"));await new Promise(resolve=>setTimeout(resolve,100));assert.equal(viewer.messages.filter(m=>m.binary).length,0);
      source.ws.send(roleFrame(47,"raw"));const raw=await viewer.next(m=>m.binary);assert.equal(raw.meta.frame_role,"raw");viewer.send({type:"ack",sequence:raw.meta.sequence,epoch:raw.meta.stream_epoch});
      viewer.send({type:"keepalive",profile:"low",codecs:["jpeg"],view:"pose"});
      await source.next(m=>!m.binary&&m.value.type==="control"&&m.value.want_raw===false&&m.value.want_pose===true);
      source.ws.send(roleFrame(48,"raw"));await new Promise(resolve=>setTimeout(resolve,100));assert.equal(viewer.messages.filter(m=>m.binary).length,0);
      source.ws.send(roleFrame(49,"pose"));const posed=await viewer.next(m=>m.binary);assert.equal(posed.meta.frame_role,"pose");viewer.send({type:"ack",sequence:posed.meta.sequence,epoch:posed.meta.stream_epoch});
      viewer.send({type:"keepalive",profile:"low",codecs:["jpeg"],view:"pose"});await source.next(m=>!m.binary&&m.value.type==="control"&&m.value.want_pose===true&&m.value.want_raw===false);
      source.ws.send(roleFrame(50,"raw",false));const fallback=await viewer.next(m=>m.binary);assert.equal(fallback.meta.detector_ready,false);viewer.send({type:"ack",sequence:fallback.meta.sequence,epoch:fallback.meta.stream_epoch});
      const initialAfterViews = await api(
        "/api/devices/" + id + "/camera",
        "GET",
        undefined,
        owner,
      );
      assert.equal(initial.status, 200);assert.equal(initialAfterViews.status,200);
      const change = await api(
        "/api/devices/" + id + "/camera",
        "PUT",
        { rotation: "180", mirror: true, expected_version: 0 },
        owner,
      );
      assert.equal(change.status, 200);
      assert.equal(change.data.applied, false);
      const apply = await source.next(
        (m) =>
          !m.binary &&
          m.value.type === "control" &&
          m.value.camera.version === 1,
      );
      assert.equal(apply.camera.rotation, "180");
      source.send({ type: "applied", version: 1 });
      await viewer.next(
        (m) => !m.binary && m.value.type === "camera" && m.value.applied === 1,
      );
      assert.equal(
        (
          await api(
            "/api/devices/" + id + "/camera",
            "PUT",
            { rotation: "90", expected_version: 0 },
            owner,
          )
        ).status,
        409,
      );
      const wrongRole = connect(
        "/api/devices/" + id + "/preview/connect",
        device,
      );
      await assert.rejects(wrongRole.open);
      wrongRole.ws.terminate();
      const camera = await api(
        "/api/devices/" + id + "/camera",
        "GET",
        undefined,
        owner,
      );
      assert.equal(camera.data.applied_version, 1);
      viewer.ws.close();
      await viewer.done;
      await source.next(
        (m) => !m.binary && m.value.type === "control" && !m.value.active,
      );
      assert.equal(
        (await api("/api/devices/" + id, "DELETE", {}, owner)).status,
        200,
      );
      assert.equal(await source.done, 1008);
    } finally {
      viewer.ws.terminate();
      source.ws.terminate();
    }
  },
);

test('真实Worker/D1：Linux绑定与HTTPS备用预览、背压、方向、撤销', {skip: !password}, async () => {
  const login = await api('/api/auth/login', 'POST', {email: process.env.PG_TEST_EMAIL, password, client_type: 'cli'});
  assert.equal(login.status, 200); const owner = login.data.api_token;
  const invitation = await api('/api/enrollments', 'POST', {name: 'HTTPS回归', platform: 'linux', is_test: true}, owner);
  assert.equal(invitation.status, 201);
  const binding = await api('/api/enroll', 'POST', {code: invitation.data.code, platform: 'linux'});
  assert.equal(binding.status, 201); assert.equal(binding.data.is_test, true);
  const id = binding.data.device_id, device = binding.data.device_token;
  const upload = (bytes, token=device, session='https-fixture',capabilities={}) => fetch(base + '/api/device/preview/' + (bytes ? 'frame' : 'control'), {
    method: bytes ? 'POST' : 'GET', headers: {Authorization: 'Bearer ' + token, 'X-PoseGuard-Stream': session, 'X-PoseGuard-Pose': '1',...capabilities}, body: bytes,
  });
  assert.equal((await upload(undefined, owner)).status, 401);
  assert.equal((await upload(undefined, device, '')).status, 400);
  assert.equal((await upload(new Uint8Array(600 * 1024 + 1))).status, 413);
  assert.equal((await upload(new Uint8Array(1))).status, 400);
  const viewer = connect('/api/devices/' + id + '/preview/connect', owner);
  try {
    await viewer.open;
    viewer.send({type: 'keepalive', profile: 'low', codecs: ['jpeg'], view: 'raw'});
    await new Promise(resolve => setTimeout(resolve, 100));
    const control = await (await upload()).json();
    assert.equal(control.active, true); assert.equal(control.want_raw, true); assert.equal(control.want_pose, false);
    assert.equal(control.source_window,1);assert.equal(control.fps,3);
    viewer.send({type:'keepalive',profile:'balanced',codecs:['jpeg'],view:'raw'});
    await viewer.next(m=>!m.binary&&m.value.type==='keepalive_ack');
    const modern=await(await upload(undefined,device,'https-fixture',{'X-PoseGuard-Low-Resource':'1','X-PoseGuard-Source-Window':'999'})).json();
    assert.equal(modern.fps,15);assert.equal(modern.source_window,12);
    const response = await upload(frame(1)); assert.equal(response.status, 200);
    const accepted = await response.json(); assert.deepEqual(accepted.accepted, {type: 'frame_ack', sequence: 1, epoch: 'protocol-fixture'});
    const first = await viewer.next(m => m.binary); assert.equal(first.meta.source_sequence, 1);
    await upload(frame(2)); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(viewer.messages.filter(m => m.binary).length, 0);
    viewer.send({type: 'ack', sequence: first.meta.sequence, epoch: first.meta.stream_epoch});
    const changed = await api('/api/devices/' + id + '/camera', 'PUT', {rotation: '90', expected_version: 0}, owner);
    assert.equal(changed.status, 200);
    assert.equal((await (await upload()).json()).camera.rotation, '90');
    const parsed = parseFrame(frame(3));
    await upload(packFrame({...parsed.meta, camera_applied_version: 1}, parsed.payload));
    await viewer.next(m => m.binary);
    const status = await api('/api/devices/' + id + '/camera', 'GET', undefined, owner);
    assert.equal(status.data.publisher, true); assert.equal(status.data.applied_version, 1);
    assert.equal((await api('/api/devices/' + id, 'DELETE', {}, owner)).status, 200);
    assert.equal((await upload()).status, 401);
  } finally {viewer.ws.terminate();}
});

test('真实Worker/D1：断网残留的预览连接不占用后续观看名额', {skip: !password}, async () => {
  const login = await api('/api/auth/login', 'POST', {email: process.env.PG_TEST_EMAIL, password, client_type: 'cli'});
  assert.equal(login.status, 200); const owner = login.data.api_token;
  const invite = await api('/api/enrollments', 'POST', {name: '预览租约回收',platform: 'windows',is_test:true}, owner);
  const bound = await api('/api/enroll','POST',{code:invite.data.code,platform:'windows'});
  assert.equal(bound.status,201); const route='/api/devices/'+bound.data.device_id+'/preview/connect';
  const viewers=[];
  try {
    for(let i=0;i<8;i++){const socket=connect(route,owner);viewers.push(socket);await socket.open;}
    await new Promise(resolve=>setTimeout(resolve,8200));
    const replacement=connect(route,owner);viewers.push(replacement);await replacement.open;
    for(const stale of viewers.slice(0,8))assert.equal(await stale.done,4001);
    assert.equal((await api('/api/devices/'+bound.data.device_id,'DELETE',{},owner)).status,200);
  }finally{for(const socket of viewers)socket.ws.terminate();}
});

test('真实Worker/D1：首帧七秒后确认仍可继续，慢端最多一帧且不阻塞快端', {skip: !password}, async () => {
  const login=await api('/api/auth/login','POST',{email:process.env.PG_TEST_EMAIL,password,client_type:'cli'});
  assert.equal(login.status,200);const owner=login.data.api_token;
  const invite=await api('/api/enrollments','POST',{name:'慢首帧回归',platform:'windows',is_test:true},owner);
  const bound=await api('/api/enroll','POST',{code:invite.data.code,platform:'windows'});assert.equal(bound.status,201);
  const route='/api/devices/'+bound.data.device_id+'/preview/connect';
  const source=connect('/api/device/preview/connect',bound.data.device_token),slow=connect(route,owner),fast=connect(route,owner);
  let pulse,frames,fastCount=0,sequence=1;
  try {
    await Promise.all([source.open,slow.open,fast.open]);
    const keep=()=>{for(const v of[slow,fast])v.send({type:'keepalive',profile:'low',codecs:['jpeg'],view:'raw'});};keep();pulse=setInterval(keep,1000);
    await slow.next(m=>!m.binary&&m.value.type==='keepalive_ack');
    fast.ws.on('message',(bytes,binary)=>{if(binary){const {meta}=parseFrame(bytes);fastCount++;fast.send({type:'ack',sequence:meta.sequence,epoch:meta.stream_epoch});}});
    await source.next(m=>!m.binary&&m.value.type==='control'&&m.value.active);
    source.ws.send(frame(sequence++));const first=await slow.next(m=>m.binary);
    frames=setInterval(()=>source.ws.send(frame(sequence++)),200);
    await new Promise(resolve=>setTimeout(resolve,7000));clearInterval(frames);
    assert.equal(slow.closed,undefined);assert.equal(slow.messages.filter(m=>m.binary).length,0);
    assert.ok(fastCount>=10,'healthy subscriber continues while the other ACK is delayed');
    slow.send({type:'ack',sequence:first.meta.sequence,epoch:first.meta.stream_epoch});
    await new Promise(resolve=>setTimeout(resolve,100));source.ws.send(frame(sequence++));
    await slow.next(m=>m.binary);
    assert.equal((await api('/api/devices/'+bound.data.device_id,'DELETE',{},owner)).status,200);
  }finally{clearInterval(pulse);clearInterval(frames);for(const v of[source,slow,fast])v.ws.terminate();}
});
