// Android Activity state is authoritative for its embedded WebView. Some OEM
// WebViews deliver delayed page visibility changes after waking the display.
export function previewForeground(native,hidden) {
  if(typeof native?.isForeground==='function') {
    try{return native.isForeground()===true;}catch{}
  }
  return !hidden;
}
