export function previewRetryDelay(code, attempt = 0, reason = '', visible = true) {
  if (!visible || reason === 'app_background' || reason === 'Viewer stopped') return null;
  if (code === 4001) return 0;
  if (![1001,1006,1011,1012,1013].includes(code)) return null;
  const delay = Math.min(8000, 500 * 2 ** Math.min(4, Math.max(0, attempt)));
  return code === 1013 ? Math.max(2000, delay) : delay;
}
