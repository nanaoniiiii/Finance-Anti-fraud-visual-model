// Keep a useful retry screen if a slow or failed module download prevents React
// from mounting. No credentials or private incident data are cached here.
(() => {
  const fallback = document.querySelector('[data-pg-boot]');
  if (!fallback) return;
  const root = fallback.parentElement;
  function failed() {
    if (!root.contains(fallback)) return;
    fallback.querySelector('p').textContent =
      '页面加载较慢，请检查网络后重试。';
    fallback.querySelector('button').hidden = false;
  }
  fallback
    .querySelector('button')
    .addEventListener('click', () => location.reload());
  window.addEventListener('error', failed);
  window.addEventListener('unhandledrejection', failed);
  setTimeout(failed, 15000);
})();
