import { DurableObject } from "cloudflare:workers";
import {
  cameraSettings,
  packFrame,
  parseFrame,
  PREVIEW_LEASE_MS,
  PROFILES,
} from "../shared/preview.js";
import { ApiError, audit, body, identifier, json, parse } from "./utils.js";
import { checkOrigin, ownerOnly } from "./auth.js";
import { previewView,wantedFrames,acceptsFrame } from "../shared/preview-views.js";
import {jpegCredit,sourceCredit,clearCredits,consumeCredit,hasCredit,spendCredit} from '../shared/preview-credit.js';

const send = (socket, value) => {
  try {
    socket.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};
const close = (socket, code = 1000, reason = "Preview stopped") => {
  try {
    socket.close(code, reason);
  } catch {}
};

// One object per device, one upstream, no persisted video. Idle publishers
// hibernate; protocol pings are answered by the runtime without waking the room.
export class PreviewRoom extends DurableObject {
  publisherOnline() {
    return this.sockets('publisher').length > 0 || (this.httpUntil || 0) > Date.now();
  }
  sockets(role) {
    return this.ctx
      .getWebSockets()
      .filter(
        (s) => s.readyState === 1 && s.deserializeAttachment()?.role === role,
      );
  }
  currentCamera() {
    return (
      this.camera ||
      this.sockets("publisher")[0]?.deserializeAttachment()?.camera ||
      this.httpSource?.camera ||
      this.sockets("viewer")[0]?.deserializeAttachment()?.camera ||
      cameraSettings()
    );
  }
  appliedVersion() {
    return this.sockets("publisher")[0]?.deserializeAttachment()?.applied ?? this.httpSource?.applied ?? -1;
  }
  activeViewers() {
    const now = Date.now();
    return this.sockets("viewer").filter((s) => {
      const a = s.deserializeAttachment();
      return now - a.seen < PREVIEW_LEASE_MS && now < a.expires;
    });
  }
  control(extra = {}) {
    const viewers = this.activeViewers();
    const profile = viewers.some(
      (s) => s.deserializeAttachment().profile === "clear",
    )
      ? "clear"
      : viewers.some((s) => s.deserializeAttachment().profile === "balanced")
        ? "balanced"
        : "low";
    const publisher = this.sockets("publisher")[0];
    const caps = publisher?.deserializeAttachment()?.caps || this.httpSource?.caps || {};
    const codec =
      caps.codecs?.includes("h264") &&
      viewers.every((s) => s.deserializeAttachment().codecs?.includes("h264"))
        ? "h264"
        : "jpeg";
    return {
      type: "control",
      active: viewers.length > 0,
      viewers: viewers.length,
      lease_ms: PREVIEW_LEASE_MS,
      profile,
      ...PROFILES[profile],
      ...(caps.low_resource?{fps:profile==='low'?6:profile==='clear'?12:15}:{}),
      source_window:sourceCredit(caps.max_inflight_frames),
      codec,
      camera: this.currentCamera(),
      ...wantedFrames(viewers.map(socket=>socket.deserializeAttachment().view)),
      ...extra,
    };
  }
  updatePublisher(extra = {}) {
    const command = this.control(extra);
    for (const socket of this.sockets("publisher")) send(socket, command);
  }
  broadcast(value) {
    for (const socket of this.sockets("viewer")) send(socket, value);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/revoke") {
      this.httpSource = null; this.httpUntil = 0;
      for (const socket of this.ctx.getWebSockets())
        close(socket, 1008, "Device unbound");
      return json({ ok: true });
    }
    if (url.pathname === "/camera" && request.method === "POST") {
      this.camera = cameraSettings(await request.json());
      for (const socket of this.ctx.getWebSockets()) {
        const a = socket.deserializeAttachment();
        a.camera = this.camera;
        socket.serializeAttachment(a);
      }
      this.updatePublisher();
      this.broadcast({
        type: "camera",
        camera: this.camera,
        applied: this.appliedVersion(),
      });
      return json({ ok: true });
    }
    if (url.pathname === "/status")
      return json({
        publisher: this.publisherOnline(),
        viewers: this.activeViewers().length,
        applied_version: this.appliedVersion(),
      });
    if (url.pathname === '/http') {
      const camera = cameraSettings(JSON.parse(request.headers.get('X-PoseGuard-Camera')));
      if (camera.version >= this.currentCamera().version) this.camera = camera;
      const session = request.headers.get('X-PoseGuard-Stream');
      const lowResource=request.headers.get('X-PoseGuard-Low-Resource')==='1';
      const sourceWindow=sourceCredit(Number(request.headers.get('X-PoseGuard-Source-Window')));
      const changed = this.httpSource?.session !== session ||
        this.httpSource?.caps.pose !== (request.headers.get('X-PoseGuard-Pose') === '1') ||
        this.httpSource?.caps.low_resource!==lowResource || this.httpSource?.caps.max_inflight_frames!==sourceWindow;
      const wasOnline = this.publisherOnline();
      if (changed) {
        this.httpSource = {session, id: crypto.randomUUID(), role: 'publisher',
          device: request.headers.get('X-PoseGuard-Device'), roomSequence: 0,
          applied: -1, camera, caps: {codecs: ['jpeg'], camera: true,
            pose: request.headers.get('X-PoseGuard-Pose') === '1',low_resource:lowResource,max_inflight_frames:sourceWindow}};
      }
      for (const socket of this.sockets('publisher')) close(socket, 1000, 'HTTPS preview fallback');
      this.httpUntil = Date.now() + 15000;
      if (!wasOnline || changed) {
        this.broadcast({type: 'publisher', online: true});
        this.broadcast({type: 'capabilities', ...this.httpSource.caps});
      }
      let accepted;
      if (request.method === 'POST') {
        let frame;
        try {frame = parseFrame(await request.arrayBuffer());}
        catch {return json({error: 'Invalid preview frame'}, 400);}
        if (frame.meta.codec !== 'jpeg') return json({error: 'HTTPS fallback requires JPEG'}, 400);
        this.deliver(frame, this.httpSource, () => {});
        accepted = {type: 'frame_ack', sequence: frame.meta.sequence, epoch: frame.meta.source_epoch};
      }
      return json({...this.control(), accepted, poll_ms: this.activeViewers().length ? 1000 : 5000}, 200, {'Cache-Control': 'no-store'});
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    const role = request.headers.get("X-PoseGuard-Role");
    if (!["viewer", "publisher"].includes(role))
      return new Response("Invalid internal role", { status: 403 });
    const incoming = cameraSettings(
      JSON.parse(request.headers.get("X-PoseGuard-Camera") || "{}"),
    );
    this.camera =
      incoming.version >= this.currentCamera().version
        ? incoming
        : this.currentCamera();
    if (role === "publisher") {
      this.httpSource = null; this.httpUntil = 0;
      for (const old of this.sockets("publisher"))
        close(old, 1000, "Publisher reconnected");
    }
    if (role === 'viewer') {
      for (const old of this.sockets('viewer')) {
        const value = old.deserializeAttachment();
        if (Date.now() > value.expires || Date.now() - (value.seen || value.authAt) > PREVIEW_LEASE_MS)
          close(old, 4001, 'Preview lease expired');
      }
      if (this.sockets('viewer').length >= 8)
        return json({ error: '这台设备的预览人数已达到上限' }, 429);
    }
    const pair = new WebSocketPair();
    const a = {
      role,
      id: crypto.randomUUID(),
      device: request.headers.get("X-PoseGuard-Device"),
      user: request.headers.get("X-PoseGuard-User"),
      seen: 0,
      view: 'raw',
      expires: Date.now() + 5 * 60000,
      profile: "balanced",
      codecs: ["jpeg"],
      outstanding: [],
      sentAt: 0,
      waitingKey: true,
      caps: {},
      authAt: Date.now(),
      camera: this.camera,
      applied: -1,
      roomSequence: 0,
    };
    pair[1].serializeAttachment(a);
    this.ctx.acceptWebSocket(pair[1], [role]);
    send(pair[1], {
      type: "welcome",
      role,
      epoch: a.id,
      camera: this.camera,
      publisher: role === "publisher" || this.publisherOnline(),
      lease_ms: PREVIEW_LEASE_MS,
    });
    if (role === "publisher") {
      for (const viewer of this.sockets("viewer")) {
        const v = viewer.deserializeAttachment();
        v.outstanding = [];
        v.waitingKey = true;
        v.epoch = null;
        viewer.serializeAttachment(v);
      }
      this.broadcast({ type: "publisher", online: true });
      this.updatePublisher();
    } else this.updatePublisher();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(socket, message) {
    const a = socket.deserializeAttachment();
    if (!a) {
      close(socket, 1008);
      return;
    }
    if (Date.now() > a.expires && a.role === "viewer") {
      close(socket, 4001, "Refresh preview authorization");
      return;
    }
    try {
      if (typeof message === "string") {
        if (message.length > 8192) throw new Error("Control too large");
        const value = JSON.parse(message);
        if (a.role === "viewer") {
          if (value.type === "keepalive") {
            if(!Array.isArray(a.outstandingAt))clearCredits(a);
            a.seen = Date.now();
            a.view=previewView(value.view);
            a.jpegWindow=jpegCredit(value.jpeg_window);
            if (Object.hasOwn(PROFILES, value.profile))
              a.profile = value.profile;
            a.codecs = Array.isArray(value.codecs)
              ? value.codecs.filter((c) => ["jpeg", "h264"].includes(c))
              : ["jpeg"];
          } else if (
            value.type === "ack" &&
            Number.isSafeInteger(value.sequence)
          ) {
            if (value.epoch === a.epoch)consumeCredit(a,value.sequence,Date.now());
          } else if (value.type === "keyframe") {
            a.waitingKey = true;
          } else throw new Error("Invalid viewer control");
          socket.serializeAttachment(a);
          if (value.type === 'keepalive')
            send(socket, {type: 'keepalive_ack', server_ms: Date.now()});
          if (value.type !== "ack")
            this.updatePublisher({
              request_keyframe: value.type === "keyframe",
            });
        } else {
          if (value.type === "hello") {
            a.caps = {
              codecs: Array.isArray(value.codecs)
                ? value.codecs.filter((c) => ["jpeg", "h264"].includes(c))
                : ["jpeg"],
              pose: value.pose === true,
              camera: value.camera === true,
              frame_ack: value.frame_ack === true,
              max_inflight_frames:sourceCredit(value.max_inflight_frames),
              low_resource:value.low_resource===true,
            };
            socket.serializeAttachment(a);
            this.broadcast({ type: "capabilities", ...a.caps });
            this.updatePublisher();
          } else if (value.type === "status") {
            this.broadcast({
              type: "source_status",
              state: String(value.state || "").slice(0, 80),
              message: String(value.message || "").slice(0, 200),
            });
          } else if (
            value.type === "applied" &&
            Number.isSafeInteger(value.version)
          ) {
            a.applied = value.version;
            socket.serializeAttachment(a);
            this.broadcast({
              type: "camera",
              camera: this.currentCamera(),
              applied: a.applied,
            });
          } else throw new Error("Invalid publisher control");
        }
        return;
      }
      if (a.role !== "publisher")
        throw new Error("Only devices publish frames");
      if (Date.now() - a.authAt > 30000) {
        const row = await this.env.DB.prepare(
          "SELECT revoked_at FROM devices WHERE id=?",
        )
          .bind(a.device)
          .first();
        if (!row || row.revoked_at) {
          close(socket, 1008, "Device unbound");
          return;
        }
        a.authAt = Date.now();
        socket.serializeAttachment(a);
      }
      const frame = parseFrame(message);
      if (a.caps?.frame_ack)
        send(socket, {type: 'frame_ack', sequence: frame.meta.sequence,
                      epoch: frame.meta.source_epoch});
      this.deliver(frame, a, () => socket.serializeAttachment(a));
    } catch {
      close(socket, 1008, "Invalid preview message");
    }
  }
  deliver(frame, a, save) {
      const viewers = this.activeViewers();
      if (!viewers.length) { this.updatePublisher(); return; }
      a.applied = frame.meta.camera_applied_version ?? a.applied;
      a.roomSequence += 1;
      save();
      const epoch = a.id + "." + frame.meta.source_epoch;
      const delivered = packFrame(
        {
          ...frame.meta,
          source_sequence: frame.meta.sequence,
          sequence: a.roomSequence,
          stream_epoch: epoch,
        },
        frame.payload,
      );
      for (const viewer of viewers) {
        const v = viewer.deserializeAttachment();
        if(!acceptsFrame(v.view,frame.meta))continue;
        if (v.epoch !== epoch) {
          clearCredits(v);
          v.waitingKey = true;
          v.epoch = epoch;
        }
        if (!hasCredit(v,frame.meta.codec,delivered.byteLength)) {
          if (frame.meta.codec === "h264") v.waitingKey = true;
          // The first JPEG may still be crossing a slow route when an eager
          // timeout closes it. Keep the one-image limit and allow its ACK.
          const timeout = v.consumeRtt === undefined ? 20000
            : Math.min(30000, Math.max(8000, v.consumeRtt * 3 + 2000));
          if (Date.now() - v.sentAt > timeout)
            close(viewer, 4002, "Viewer is not consuming frames");
          viewer.serializeAttachment(v);
          continue;
        }
        if (frame.meta.codec === "h264" && v.waitingKey && !frame.meta.keyframe)
          continue;
        if (frame.meta.keyframe) v.waitingKey = false;
        spendCredit(v,a.roomSequence,delivered.byteLength,Date.now(),frame.meta.codec);
        v.lastSource = frame.meta.sequence;
        viewer.serializeAttachment(v);
        viewer.send(delivered);
      }
  }
  webSocketClose(socket, code) {
    const role = socket.deserializeAttachment()?.role;
    close(socket, [1005, 1006, 1015].includes(code) ? 1000 : code);
    if (role === "publisher")
      this.broadcast({ type: "publisher", online: this.publisherOnline() });
    this.updatePublisher();
  }
  webSocketError(socket) {
    this.webSocketClose(socket, 1011);
  }
}

const room = (env, device) =>
  env.PREVIEWS.get(env.PREVIEWS.idFromName(device.id));
export async function connectPreview(request, env, device, role, user) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    throw new ApiError(400, "需要 WebSocket 连接");
  if (role === "viewer") checkOrigin(request, env);
  const headers = new Headers(request.headers);
  headers.set("X-PoseGuard-Role", role);
  headers.set("X-PoseGuard-Device", device.id);
  headers.set("X-PoseGuard-User", user?.id || "");
  headers.set(
    "X-PoseGuard-Camera",
    JSON.stringify(cameraSettings(parse(device.config_json, {}).camera)),
  );
  return room(env, device).fetch(
    new Request("https://preview/connect", { method: "GET", headers }),
  );
}
export async function httpPreview(request, env, device) {
  const session = request.headers.get('X-PoseGuard-Stream') || '';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(session)) throw new ApiError(400, 'Invalid preview session');
  const headers = new Headers({
    'X-PoseGuard-Device': device.id, 'X-PoseGuard-Stream': session,
    'X-PoseGuard-Pose': request.headers.get('X-PoseGuard-Pose') === '1' ? '1' : '0',
    'X-PoseGuard-Low-Resource':request.headers.get('X-PoseGuard-Low-Resource')==='1'?'1':'0',
    'X-PoseGuard-Source-Window':String(sourceCredit(Number(request.headers.get('X-PoseGuard-Source-Window')))),
    'X-PoseGuard-Camera': JSON.stringify(cameraSettings(parse(device.config_json, {}).camera)),
  });
  let payload;
  if (request.method === 'POST') {
    const reader = request.body?.getReader(); const chunks = []; let length = 0;
    if (!reader) throw new ApiError(400, 'Missing preview frame');
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 600 * 1024) {await reader.cancel(); throw new ApiError(413, 'Preview frame too large');}
      chunks.push(value);
    }
    payload = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) {payload.set(chunk, offset); offset += chunk.byteLength;}
  }
  return room(env, device).fetch(new Request('https://preview/http', {
    method: request.method, headers, body: payload,
  }));
}
export async function cameraRoute(request, env, user, device) {
  if (request.method === "GET") {
    const status = await room(env, device)
      .fetch("https://preview/status")
      .then((r) => r.json());
    return json({
      camera: cameraSettings(parse(device.config_json, {}).camera),
      ...status,
    });
  }
  if (request.method !== "PUT") throw new ApiError(405, "操作不支持");
  ownerOnly(user);
  const input = await body(request, 2000);
  const config = parse(device.config_json, {});
  const previous = cameraSettings(config.camera);
  if (input.expected_version !== previous.version)
    throw new ApiError(409, "画面设置已更新，请刷新后重试");
  let settings;
  try {
    settings = cameraSettings({ ...input, version: previous.version + 1 });
  } catch (error) {
    throw new ApiError(400, error.message);
  }
  config.camera = settings;
  const updated = await env.DB.prepare(
    "UPDATE devices SET config_json=? WHERE id=? AND config_json=?",
  )
    .bind(JSON.stringify(config), device.id, device.config_json)
    .run();
  if (!updated.meta.changes)
    throw new ApiError(409, "设备设置已更新，请刷新后重试");
  await room(env, device).fetch("https://preview/camera", {
    method: "POST",
    body: JSON.stringify(settings),
  });
  await audit(env, user.email, "camera_settings_updated", device.id, settings);
  return json({ ok: true, camera: settings, applied: false });
}
export async function revokePreview(env, deviceId) {
  await room(env, { id: deviceId }).fetch("https://preview/revoke");
}
