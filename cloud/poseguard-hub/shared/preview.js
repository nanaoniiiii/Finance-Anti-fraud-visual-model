// One clean encoded image and the detections belonging to that exact image.
// Neither a second annotated stream nor camera credentials are sent to viewers.
export const FRAME_MAGIC = 0x50475631; // PGV1
export const MAX_FRAME_BYTES = 600 * 1024;
export const MAX_META_BYTES = 24 * 1024;
export const PREVIEW_LEASE_MS = 8000;
export const PROFILES = Object.freeze({
  low: { long_side: 432, fps: 3, quality: 45, bitrate: 180000 },
  balanced: { long_side: 640, fps: 6, quality: 55, bitrate: 420000 },
  clear: { long_side: 960, fps: 10, quality: 70, bitrate: 900000 },
});
const finite = (n, min, max) =>
  typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
const integer = (n, min, max) =>
  Number.isSafeInteger(n) && n >= min && n <= max;
export function cameraSettings(input = {}) {
  const rotation = String(input.rotation ?? "auto");
  if (!["auto", "0", "90", "180", "270"].includes(rotation))
    throw new Error("画面方向不正确");
  if (input.mirror !== undefined && typeof input.mirror !== "boolean")
    throw new Error("镜像设置不正确");
  if (
    input.version !== undefined &&
    !integer(input.version, 0, Number.MAX_SAFE_INTEGER)
  )
    throw new Error("画面设置版本不正确");
  return {
    rotation,
    mirror: input.mirror === true,
    version: integer(input.version, 0, Number.MAX_SAFE_INTEGER)
      ? input.version
      : 0,
  };
}
export function parseFrame(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength < 12 || bytes.byteLength > MAX_FRAME_BYTES)
    throw new Error("Invalid preview frame size");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0) !== FRAME_MAGIC)
    throw new Error("Invalid preview frame version");
  const size = header.getUint32(4);
  if (size < 2 || size > MAX_META_BYTES || size + 8 >= bytes.byteLength)
    throw new Error("Invalid preview metadata size");
  const meta = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(8, 8 + size),
    ),
  );
  if (
    !integer(meta.sequence, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(meta.width, 16, 1920) ||
    !integer(meta.height, 16, 1920) ||
    !["jpeg", "h264"].includes(meta.codec) ||
    !finite(meta.inference_fps ?? 0, 0, 1000) ||
    typeof meta.source_epoch !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(meta.source_epoch) ||
    !Array.isArray(meta.tracks) ||
    meta.tracks.length > 8 ||
    !Array.isArray(meta.risks) ||
    meta.risks.length > 24
  )
    throw new Error("Invalid preview metadata");
  if (
    meta.camera_applied_version !== undefined &&
    !integer(meta.camera_applied_version, 0, Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Invalid camera version");
  for (const track of meta.tracks) {
    if (
      !integer(track.id, 0, 2147483647) ||
      !Array.isArray(track.bbox) ||
      track.bbox.length !== 4 ||
      !track.bbox.every((n) => finite(n, -1, 2)) ||
      !Array.isArray(track.keypoints) ||
      track.keypoints.length !== 17 ||
      !track.keypoints.every(
        (p) =>
          p === null ||
          (Array.isArray(p) &&
            p.length === 3 &&
            finite(p[0], -1, 2) &&
            finite(p[1], -1, 2) &&
            finite(p[2], 0, 1)),
      )
    )
      throw new Error("Invalid preview pose");
  }
  for (const risk of meta.risks) {
    if (
      !integer(risk.id, 0, 2147483647) ||
      !["phone_to_ear", "multi_person", "lingering"].includes(risk.kind) ||
      !["candidate", "alert", "normal"].includes(risk.state)
    )
      throw new Error("Invalid preview risk");
  }
  const payload = bytes.subarray(8 + size);
  if (
    meta.codec === "jpeg" &&
    (payload.length < 4 || payload[0] !== 255 || payload[1] !== 216)
  )
    throw new Error("Invalid JPEG");
  if (
    meta.codec === "h264" &&
    (payload.length < 5 ||
      payload[0] !== 0 ||
      payload[1] !== 0 ||
      !(payload[2] === 1 || (payload[2] === 0 && payload[3] === 1)) ||
      !/^avc1\.[0-9a-fA-F]{6}$/.test(meta.codec_string || ""))
  )
    throw new Error("Invalid H.264 access unit");
  return { meta, payload, bytes };
}
export function packFrame(meta, payload) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const bytes = new Uint8Array(8 + json.length + payload.byteLength);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, FRAME_MAGIC);
  header.setUint32(4, json.length);
  bytes.set(json, 8);
  bytes.set(
    new Uint8Array(
      payload.buffer ?? payload,
      payload.byteOffset ?? 0,
      payload.byteLength,
    ),
    8 + json.length,
  );
  if (bytes.length > MAX_FRAME_BYTES || json.length > MAX_META_BYTES)
    throw new Error("Preview frame too large");
  return bytes;
}
