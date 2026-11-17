import React, { useEffect, useRef, useState } from "react";
import {
  Camera,
  Gauge,
  Layers,
  Pause,
  Play,
  RotateCw,
  Wifi,
} from "lucide-react";
import { parseFrame } from "../shared/preview.js";
import { clearFrames, selectFrame, storeFrame, frameIsStale } from "./preview-frames.js";
import { previewRetryDelay } from './preview-reconnect.js';
import {previewForeground}from'./preview-foreground.js';
import "./preview.css";

const nativeViews = new Map();
const foreground=()=>previewForeground(window.PoseGuardNative,document.hidden);
window.__poseguardPreviewNative = (id, kind, value) =>
  nativeViews.get(id)?.(kind, value);
const labels = {
  phone_to_ear: "疑似通话",
  multi_person: "多人状态",
  lingering: "长时间停留",
};
const edges = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4],
  [3, 5],
  [4, 6],
  [5, 6],
  [5, 7],
  [7, 9],
  [6, 8],
  [8, 10],
  [5, 11],
  [6, 12],
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
];
const closeDecoder = (c) => {
  try {
    c.decoder?.close();
  } catch {}
  c.decoder = null;
  c.pending?.clear();
};

function connection(deviceId, event) {
  const id = crypto.randomUUID(),
    route = `/api/devices/${deviceId}/preview/connect`;
  if (window.PoseGuardNative?.openPreview) {
    nativeViews.set(id, (kind, value) => {
      if (kind === "binary") {
        const decoded = atob(value),
          bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++)
          bytes[i] = decoded.charCodeAt(i);
        event("binary", bytes);
      } else if (kind === "text") {
        try {
          event("text", JSON.parse(value));
        } catch {
          event("error", "预览响应格式错误");
        }
      } else event(kind, value);
    });
    window.PoseGuardNative.openPreview(id, route);
    return {
      send: (value) =>
        window.PoseGuardNative.sendPreview(id, JSON.stringify(value)),
      close: () => {
        nativeViews.delete(id);
        window.PoseGuardNative.closePreview(id);
      },
    };
  }
  const ws = new WebSocket(location.origin.replace(/^http/, "ws") + route);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => event("open");
  ws.onmessage = (m) => {
    if (typeof m.data === "string") {
      try {
        event("text", JSON.parse(m.data));
      } catch {
        event("error", "预览响应格式错误");
      }
    } else event("binary", new Uint8Array(m.data));
  };
  ws.onerror = () => event("error", "预览连接失败，可重试或选择省流模式");
  ws.onclose = (m) =>
    event("closed", JSON.stringify({ code: m.code, reason: m.reason }));
  return {
    send: (value) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(value));
    },
    close: () => ws.close(1000, "Viewer stopped"),
  };
}
async function bitmap(bytes) {
  const blob = new Blob([bytes], { type: "image/jpeg" });
  if (window.createImageBitmap) return createImageBitmap(blob);
  const url = URL.createObjectURL(blob),
    image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  image.close = () => URL.revokeObjectURL(url);
  return image;
}
function paint(canvas, item, overlay, fps, stale) {
  if (!canvas || !item) return;
  const rect = canvas.parentElement.getBoundingClientRect(),
    w = rect.width,
    h = rect.height;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1920 / w, 1440 / h);
  const cw = Math.round(w * dpr),
    ch = Math.round(h * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#101a29";
  ctx.fillRect(0, 0, w, h);
  const m = item.meta,
    angle = [90, 180, 270].includes(m.display_rotation)
      ? m.display_rotation
      : 0;
  const swap = angle === 90 || angle === 270,
    imageWidth = swap ? m.height : m.width,
    imageHeight = swap ? m.width : m.height;
  const scale = Math.min(w / imageWidth, h / imageHeight),
    dw = imageWidth * scale,
    dh = imageHeight * scale,
    dx = (w - dw) / 2,
    dy = (h - dh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.save();
  ctx.translate(dx + dw / 2, dy + dh / 2);
  ctx.scale(m.display_mirror ? -1 : 1, 1);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(
    item.image,
    (-m.width * scale) / 2,
    (-m.height * scale) / 2,
    m.width * scale,
    m.height * scale,
  );
  if (overlay) {
    ctx.translate((-m.width * scale) / 2, (-m.height * scale) / 2);
    const iw = m.width * scale,
      ih = m.height * scale;
    for (const track of m.tracks) {
      const risks = m.risks.filter((r) => r.id === track.id),
        alert = risks.some((r) => r.state === "alert"),
        candidate = risks.some((r) => r.state === "candidate");
      const color = alert ? "#ff6565" : candidate ? "#ffb54a" : "#c6fa70";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(
        track.predicted || track.confirmed === false ? [5, 4] : [],
      );
      const [x1, y1, x2, y2] = track.bbox;
      ctx.strokeRect(x1 * iw, y1 * ih, (x2 - x1) * iw, (y2 - y1) * ih);
      ctx.setLineDash([]);
      ctx.font = "12px sans-serif";
      ctx.fillText(
        `ID ${track.id}${track.predicted ? " · 保持" : ""}`,
        Math.max(2, x1 * iw + 3),
        Math.max(14, y1 * ih - 5),
      );
      for (const [a, b] of edges) {
        const p = track.keypoints[a],
          q = track.keypoints[b];
        if (!p || !q || p[2] < 0.45 || q[2] < 0.45) continue;
        ctx.beginPath();
        ctx.moveTo(p[0] * iw, p[1] * ih);
        ctx.lineTo(q[0] * iw, q[1] * ih);
        ctx.stroke();
      }
      for (const p of track.keypoints) {
        if (!p || p[2] < 0.45) continue;
        ctx.beginPath();
        ctx.arc(p[0] * iw, p[1] * ih, 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
  const risk =
    m.risks.find((r) => r.state === "alert") ||
    m.risks.find((r) => r.state === "candidate");
  const unavailable = m.observation_available === false;
  const qualityTitle = m.input_quality === "low_light" ? "光照不足 · 检测不可用" :
    m.input_quality === "overexposed" ? "画面过曝 · 检测不可用" :
    m.input_quality === "low_contrast" ? "画面对比度不足 · 检测不可用" : "画面不可用";
  const title = stale
    ? "检测状态已过期"
    : !m.detector_ready
      ? m.detector_paused ? "检测已暂停" : m.detector_present ? "检测器正在准备" : "相机预览 · 姿态未接入"
      : unavailable ? qualityTitle : risk
        ? labels[risk.kind] || "特殊状态"
        : m.people
          ? "正常"
          : "未检测到人员";
  const color = stale
    ? "#b6becb"
    : !m.detector_ready
      ? "#b7d4ff"
      : unavailable ? "#ffc568" : risk?.state === "alert"
        ? "#ff8585"
        : risk
          ? "#ffc568"
          : "#d4fa9b";
  const font = Math.max(10, Math.min(14, dw / 25));
  ctx.font = `600 ${font}px sans-serif`;
  const lines = [
    title,
    m.detector_ready ? unavailable ? "请调整照明或检查镜头" : `${m.people ?? m.tracks.length} 人${m.source_type === "video" ? " · 视频回放" : ""}` : "识别未启用",
  ];
  if (overlay)
    lines.push(
      `检测 ${Number(m.inference_fps || 0).toFixed(1)} · 预览 ${fps.toFixed(1)} FPS`,
    );
  const boxWidth = Math.min(
      dw - 12,
      Math.max(...lines.map((t) => ctx.measureText(t).width)) + 20,
    ),
    boxHeight = lines.length * (font + 6) + 12;
  const bx = dx + dw - boxWidth - 7,
    by = dy + 7;
  ctx.fillStyle = "rgba(9,19,32,.82)";
  ctx.fillRect(bx, by, boxWidth, boxHeight);
  ctx.fillStyle = color;
  lines.forEach((line, i) =>
    ctx.fillText(
      line,
      bx + 10,
      by + font + 8 + i * (font + 6),
      Math.max(1, boxWidth - 20),
    ),
  );
  ctx.restore();
}

export default function DevicePreview({
  device,
  user,
  onClose,
  api,
  Modal,
  Button,
}) {
  const [state, setState] = useState("请求预览通道"),
    [error, setError] = useState(""),
    [overlay, setOverlay] = useState(false),
    [profile, setProfile] = useState("balanced");
  const [camera, setCamera] = useState({
      rotation: "auto",
      mirror: false,
      version: 0,
    }),
    [applied, setApplied] = useState(-1),
    [saving, setSaving] = useState(false),
    [info, setInfo] = useState(null);
  const [stats, setStats] = useState({ fps: 0, kbps: 0, age: 0 }),
    [wanted, setWanted] = useState(true);
  const stage = useRef(null),
    canvas = useRef(null),
    owner = useRef({ mounted: false }),
    latest = useRef(null),
    frames = useRef({raw:null,pose:null}),
    overlayRef = useRef(false),
    profileRef = useRef("balanced"),
    retry = useRef({attempt:0,timer:null}),
    meter = useRef({
      frames: 0,
      bytes: 0,
      start: performance.now(),
      last: 0,
      fps: 0,
    });
  const supported = device.health?.capabilities?.preview === true;
  const cameraOnly = info ? info.detector_present === true ? false : info.detector_ready === false : device.health?.capabilities?.pose_overlay === false;
  const redraw = () =>
    paint(
      canvas.current,
      latest.current,
      overlayRef.current,
      meter.current.fps,
      frameIsStale(latest.current, meter.current.last, performance.now(), Date.now()),
    );
  const stop = () => {
    clearTimeout(retry.current.timer);
    retry.current.timer = null;
    const c = owner.current;
    c.wanted = false;
    c.mounted = false;
    c.connection?.close();
    c.connection = null;
    closeDecoder(c);
  };
  const start = async () => {
    stop();
    setError("");
    setWanted(true);
    setState("正在连接设备");
    const c = {
      mounted: true,
      wanted: true,
      id: crypto.randomUUID(),
      codecs: ["jpeg"],
    };
    owner.current = c;
    const id = c.id;
    if (window.VideoDecoder) {
      try {
        if (
          (
            await VideoDecoder.isConfigSupported({
              codec: "avc1.42E01E",
              optimizeForLatency: true,
            })
          ).supported
        )
          c.codecs.push("h264");
      } catch {}
    }
    if (!c.mounted || owner.current !== c || !c.wanted) return;
    c.pending = new Map();
    c.lastSequence = 0;
    c.jpegSequence = {};
    c.epoch = null;
    const send = (value) => {
      if (c.id === id && c.wanted) c.connection?.send(value);
    };
    const keep = () =>
      send({
        type: "keepalive",
        profile: profileRef.current,
        view:overlayRef.current?'pose':'raw',
        codecs: c.codecs,
        jpeg_window:8,
      });
    c.keep = keep;
    const ack = (m) =>
      send({ type: "ack", sequence: m.sequence, epoch: m.stream_epoch });
    const present = (image, m) => {
      if (!c.mounted || owner.current !== c || !c.wanted || c.id!==id) {
        if (!c.dropTraced) { console.info('PG_PREVIEW discarded after viewer stop'); c.dropTraced = true; }
        image.close?.();
        return;
      }
      const role=m.frame_role||"legacy";
      const epoch=m.stream_epoch||m.source_epoch;
      if(c.jpegEpoch!==epoch){clearFrames(frames.current);latest.current=null;c.jpegSequence={};c.jpegEpoch=epoch;}
      if(m.codec==="jpeg" && (c.jpegSequence[role]||0)>=m.sequence){image.close?.();ack(m);return;}
      c.jpegSequence[role]=m.sequence;
      const previous=latest.current;
      if(!storeFrame(frames.current,{image,meta:m})){ack(m);return;}
      retry.current.attempt = 0;
      latest.current=selectFrame(frames.current,overlayRef.current);
      if(latest.current!==previous){meter.current.frames++;meter.current.last=performance.now();}
      setState("实时画面");
      const signature = [
        m.width,
        m.height,
        m.codec,
        m.orientation,
        m.detector_ready,
        m.camera_applied_version,
      ].join(":");
      if (c.infoSignature !== signature) {
        c.infoSignature = signature;
        setInfo(m);
      }
      setApplied(m.camera_applied_version ?? -1);
      redraw();
      if (!c.presentTraced) { console.info('PG_PREVIEW presented ' + (m.frame_role || 'legacy')); c.presentTraced = true; }
      if (m.codec === "jpeg") ack(m);
    };
    const jpegFallback = () => {
      if (owner.current !== c || !c.mounted) return;
      closeDecoder(c);
      c.codecs = ["jpeg"];
      keep();
      setState("正在切换兼容画面");
    };
    c.connection = connection(device.id, async (kind, value) => {
      if (!c.mounted || owner.current !== c) return;
      if (kind === "open") {
        keep();
        setState("正在等待设备首帧");
        return;
      }
      if (kind === "error") {
        setError(typeof value === "string" ? value : "预览连接失败");
        return;
      }
      if (kind === "closed") {
        let close = {};
        try {
          close = JSON.parse(value || "{}");
        } catch {}
        if (close.code === 4002) {
          setError("画面接收过慢，预览已暂停；可选择省流模式后重新请求。");
        }
        const delay = c.wanted ? previewRetryDelay(close.code, retry.current.attempt,
                                                  close.reason, foreground()) : null;
        if (delay !== null) {
          const closedConnection = c.connection;
          c.connection = null;
          closedConnection?.close();
          closeDecoder(c);
          setError('');
          setState('连接中断，正在重新连接');
          clearTimeout(retry.current.timer);
          retry.current.attempt++;
          retry.current.timer = setTimeout(() => {
            if (owner.current === c && c.mounted && c.wanted && foreground()) start();
          }, delay);
          return;
        }
        clearTimeout(retry.current.timer);
        retry.current.timer = null;
        setState(
          close.reason === "app_background"
            ? "已暂停（应用在后台）"
            : "预览已停止",
        );
        setWanted(false);
        c.wanted = false;
        return;
      }
      if (kind === "text") {
        if (value.type === "welcome") {
          setCamera((old) =>
            value.camera.version >= old.version ? value.camera : old,
          );
          setState(
            value.publisher ? "正在等待设备首帧" : "等待设备连接预览通道",
          );
          keep();
        }
        if (value.type === "publisher")
          setState(
            value.online ? "正在等待新画面" : "设备预览通道已断开，等待恢复",
          );
        if (value.type === "source_status")
          setState(value.message || value.state);
        if (value.type === "camera") {
          setCamera((old) =>
            value.camera.version >= old.version ? value.camera : old,
          );
          setApplied(value.applied);
        }
        return;
      }
      if (kind !== "binary") return;
      const trace = !c.binaryTraced;
      c.binaryTraced = true;
      if (trace) console.info('PG_PREVIEW binary bytes=' + value.byteLength);
      let failedMeta;
      try {
        meter.current.bytes += value.byteLength;
        const { meta: m, payload } = parseFrame(value);
        if (trace) console.info('PG_PREVIEW parsed ' + (m.frame_role || 'legacy') + ' tracks=' + m.tracks.length);
        failedMeta = m;
        if (m.codec === "jpeg") {
          if (c.decoder) closeDecoder(c);
          const image = await bitmap(payload);
          if (trace) console.info('PG_PREVIEW decoded ' + image.width + 'x' + image.height);
          if (
            (image.width || image.naturalWidth) !== m.width ||
            (image.height || image.naturalHeight) !== m.height
          ) {
            image.close?.();
            throw new Error("画面尺寸与检测数据不一致");
          }
          present(image, m);
          return;
        }
        if (!window.VideoDecoder || !c.codecs.includes("h264")) {
          ack(m);
          jpegFallback();
          return;
        }
        const reset =
          c.epoch !== m.stream_epoch ||
          (c.lastSequence && m.sequence !== c.lastSequence + 1);
        if (reset && c.decoder) closeDecoder(c);
        c.epoch = m.stream_epoch;
        c.lastSequence = m.sequence;
        if (!c.decoder) {
          if (!m.keyframe) {
            ack(m);
            send({ type: "keyframe" });
            return;
          }
          c.decoder = new VideoDecoder({
            output: async (frame) => {
              if (owner.current !== c || !c.mounted) {
                frame.close();
                return;
              }
              const matched = c.pending.get(frame.timestamp);
              c.pending.delete(frame.timestamp);
              try {
                if (!matched) return;
                const image = await createImageBitmap(frame);
                present(image, matched);
              } catch {
                jpegFallback();
              } finally {
                frame.close();
              }
            },
            error: () => jpegFallback(),
          });
          c.decoder.configure({
            codec: m.codec_string,
            optimizeForLatency: true,
            hardwareAcceleration: "prefer-hardware",
          });
        }
        if (c.decoder.decodeQueueSize > 4 || c.pending.size >= 8) {
          ack(m);
          closeDecoder(c);
          send({ type: "keyframe" });
          return;
        }
        const timestamp = m.sequence * 1000;
        c.pending.set(timestamp, m);
        c.decoder.decode(
          new EncodedVideoChunk({
            type: m.keyframe ? "key" : "delta",
            timestamp,
            data: payload,
          }),
        );
        // Hardware decoders can retain several admitted pictures before output.
        // Credit admission to this bounded queue, not presentation; otherwise a
        // four-frame network window deadlocks the decoder waiting for input.
        ack(m);
      } catch (e) {
        if (trace) console.info('PG_PREVIEW frame_error ' + (e.name || 'Error'));
        if (failedMeta) ack(failedMeta);
        setError(e.message || "画面解码失败");
        send({ type: "keyframe" });
      }
    });
  };
  useEffect(() => {
    owner.current.mounted = true;
    api(`/devices/${device.id}/camera`)
      .then((r) => {
        if (owner.current.mounted) {
            setCamera(old => r.camera.version >= old.version ? r.camera : old);
          setApplied(r.applied_version);
        }
      })
      .catch((e) => setError(e.message));
    if (device.online && supported) start();
    else {
      setState(
        device.online
          ? "设备需要升级预览组件"
          : "设备离线，方向设置会在上线后应用",
      );
      setWanted(false);
    }
    const resize = new ResizeObserver(redraw);
    if (stage.current) resize.observe(stage.current);
    const hidden = () => {
      if (!foreground()) {
        stop();
        setWanted(false);
        setState("已暂停（页面在后台）");
      }
    };
    document.addEventListener("visibilitychange", hidden);
    const tick = setInterval(() => {
      const now = performance.now(),
        m = meter.current,
        seconds = (now - m.start) / 1000;
      if (seconds >= 1) {
        m.fps = m.frames / seconds;
        setStats({
          fps: m.fps,
          kbps: (m.bytes * 8) / seconds / 1000,
          age: m.last ? (now - m.last) / 1000 : 0,
        });
        m.frames = 0;
        m.bytes = 0;
        m.start = now;
      }
      owner.current.keep?.();
      redraw();
    }, 2000);
    return () => {
      owner.current.mounted = false;
      stop();
      resize.disconnect();
      clearInterval(tick);
      document.removeEventListener("visibilitychange", hidden);
      clearFrames(frames.current);
      latest.current = null;
    };
  }, [device.id]);
  const saveCamera = async (patch) => {
    setSaving(true);
    setError("");
    try {
      const r = await api(`/devices/${device.id}/camera`, {
        method: "PUT",
        body: JSON.stringify({
          ...camera,
          ...patch,
          expected_version: camera.version,
        }),
      });
      setCamera(r.camera);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    if (applied === camera.version) return;
    const poll = setInterval(
      () =>
        api(`/devices/${device.id}/camera`)
          .then((r) => setApplied(r.applied_version))
          .catch(() => {}),
      2000,
    );
    return () => clearInterval(poll);
  }, [applied, camera.version]);
  return (
    <Modal
      title={`实时预览 · ${device.name}`}
      onClose={() => {
        stop();
        onClose();
      }}
      wide
    >
      <div className="modal-body preview-dialog">
        <div className="preview-toolbar">
          <div className="preview-switch" aria-label="画面显示模式">
            <button
              type="button"
              className={!overlay ? "selected" : ""}
              onClick={() => {
                setOverlay(false);
                overlayRef.current = false;
                latest.current=selectFrame(frames.current,false);
                owner.current.keep?.();
                redraw();
              }}
            >
              <Camera size={17} />
              原始画面
            </button>
            <button
              type="button"
              className={overlay ? "selected" : ""}
              onClick={() => {
                setOverlay(true);
                overlayRef.current = true;
                latest.current=selectFrame(frames.current,true);
                owner.current.keep?.();
                redraw();
              }}
            >
              <Layers size={17} />
              姿态与帧率
            </button>
          </div>
          <div className="preview-stream-actions">
            <select
              aria-label="预览质量"
              value={profile}
              onChange={(e) => {
                setProfile(e.target.value);
                profileRef.current = e.target.value;
                owner.current.keep?.();
              }}
            >
              <option value="low">省流</option>
              <option value="balanced">均衡</option>
              <option value="clear">清晰</option>
            </select>
            <Button
              onClick={() => {
                if (wanted) {
                  stop();
                  setWanted(false);
                  setState("预览已暂停");
                } else start();
              }}
              disabled={!device.online || !supported}
            >
              {wanted ? <Pause size={16} /> : <Play size={16} />}{" "}
              {wanted ? "暂停预览" : "请求预览"}
            </Button>
          </div>
        </div>
        <div className="preview-stage" ref={stage}>
          <canvas ref={canvas} aria-label="设备实时画面" />
          {!info && (
            <div className="preview-empty">
              <Camera size={32} />
              <p>{state}</p>
              <span>点击观看后才上传画面</span>
            </div>
          )}
        </div>
        <div className="preview-health">
          <span>
            <i
              className={"status-dot " + (state === "实时画面" ? "" : "off")}
            />
            {state}
          </span>
          <span>
            <Gauge size={15} />
            {stats.fps.toFixed(1)} FPS 预览
          </span>
          <span>
            <Wifi size={15} />
            {Math.round(stats.kbps)} kbps 画面数据
          </span>
          {info && (
            <span>
              {info.width}×{info.height} ·{" "}
              {info.codec === "h264" ? "H.264" : "JPEG"}
            </span>
          )}
        </div>
        {error && <div className="form-message preview-error">{error}</div>}
        {info && !info.detector_ready && (
          <p className="preview-hint">
            {info.detector_paused ? "检测处于维护测试暂停状态，当前仅显示相机画面。" : info.detector_present ? "检测器正在加载或恢复，请稍候。" : "这台设备当前提供相机预览，尚未接入姿态检测器；帧率仍会显示。"}
          </p>
        )}
        <div className="preview-camera-settings">
          <div>
            <strong>
              <RotateCw size={17} />
              安装检测方向
            </strong>
            <p>
              {cameraOnly ? "这台设备尚未接入姿态模型，可手动旋转和镜像相机预览。" : "支持四种安装方向。自动模式根据人体判断；也可手动旋转画面至头部向上。校正会在模型检测前应用。"}
            </p>
          </div>
          <label>
            {cameraOnly ? "预览方向" : "检测前校正"}
            <select
              aria-label="安装检测方向"
              value={camera.rotation}
              disabled={saving || user.role !== "owner"}
              onChange={(e) => saveCamera({ rotation: e.target.value })}
            >
              <option value="auto" disabled={cameraOnly}>{cameraOnly ? "自动（需姿态模型）" : "自动识别安装方向"}</option>
              <option value="0">手动 · 不旋转（0°）</option>
              <option value="90">手动 · 顺时针 90°</option>
              <option value="180">手动 · 旋转 180°</option>
              <option value="270">手动 · 顺时针 270°</option>
            </select>
          </label>
          <label className="preview-mirror">
            <input
              type="checkbox"
              checked={camera.mirror}
              disabled={saving || user.role !== "owner"}
              onChange={(e) => saveCamera({ mirror: e.target.checked })}
            />
            水平镜像
          </label>
          <small>
            {saving
              ? "正在保存"
              : applied === camera.version
                ? `设备已应用${info ? ` · 当前校正 ${info.orientation ?? 0}°` : ""}`
                : "已保存，等待设备应用"}
          </small>
        </div>
        <p className="preview-hint">
          同一设备共用一路上传，只传送观看端需要的画面。关闭窗口或切到后台会停止观看。
        </p>
      </div>
    </Modal>
  );
}
