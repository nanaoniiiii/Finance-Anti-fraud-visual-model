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
      });
      viewer.send({ type: "keepalive", profile: "low", codecs: ["jpeg"] });
      const wanted = await source.next(
        (m) => !m.binary && m.value.type === "control" && m.value.active,
      );
      assert.equal(wanted.lease_ms, 8000);
      source.ws.send(frame(42));
      const first = await viewer.next((m) => m.binary);
      assert.equal(first.meta.source_sequence, 42);
      source.ws.send(frame(43));
      source.ws.send(frame(44));
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
        "GET",
        undefined,
        owner,
      );
      assert.equal(initial.status, 200);
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
