export function previewView(value) { return value==='raw'||value==='pose'?value:'both'; }
export function wantedFrames(views) {
  return {want_raw:views.some(view=>previewView(view)!=='pose'),want_pose:views.some(view=>previewView(view)!=='raw')};
}
export function acceptsFrame(view,meta) {
  if(!meta.frame_role||previewView(view)==='both')return true;
  if(meta.frame_role==='raw')return previewView(view)==='raw'||meta.detector_ready===false;
  return meta.frame_role==='pose'&&previewView(view)==='pose';
}
