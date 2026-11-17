// A slow detector can return a result for an older capture while the same
// connection continues carrying fresh raw images. Cache each role separately.
export function clearFrames(store) {
  for (const item of new Set([store.raw, store.pose])) item?.image.close?.();
  store.raw = store.pose = null;
}
export function storeFrame(store, item) {
  const version=item.meta.camera_applied_version;
  const newest=Math.max(...[store.raw,store.pose].map(frame=>Number.isSafeInteger(frame?.meta.camera_applied_version)?frame.meta.camera_applied_version:-1));
  if(Number.isSafeInteger(version)&&version<newest){item.image.close?.();return false;}
  const previous = new Set([store.raw, store.pose]);
  if (item.meta.frame_role === "raw") {
    store.raw = item;
    if (item.meta.detector_ready === false || (store.pose && store.pose.meta.camera_applied_version !== item.meta.camera_applied_version)) store.pose = null;
  } else if (item.meta.frame_role === "pose") store.pose = item;
  else store.raw = store.pose = item;
  for (const old of previous) if (old && old !== store.raw && old !== store.pose) old.image.close?.();
  return true;
}
export function selectFrame(store, overlay) {
  return (overlay ? store.pose : store.raw) || store.raw || store.pose;
}
export function frameIsStale(item, lastReceipt, now, wallTime) {
  const meta = item?.meta || {};
  const processing = Number(meta.processing_ms || 0);
  const statusAge = Number(meta.status_age_ms || 0);
  if (!Number.isFinite(processing) || !Number.isFinite(statusAge)) return true;
  const captured = Number(meta.captured_ms);
  if (Number.isFinite(captured) && captured > wallTime + 30000) return true;
  const wireAge = Number.isFinite(captured) && captured > 0 ? Math.max(0,wallTime-captured) : 0;
  return now-lastReceipt > Math.max(2500,processing*2.5) ||
    statusAge+wireAge > Math.max(3000,processing*2.5);
}
