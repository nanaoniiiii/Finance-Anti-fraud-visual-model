package tech.nanaoni.poseguard;
import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.util.HashMap;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private WebView web;
    private boolean migratingAssets;
    private final ExecutorService requests = Executors.newFixedThreadPool(4);
    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(16, 26, 41));
        getWindow().setNavigationBarColor(Color.rgb(16, 26, 41));
        web = new WebView(this);
        web.setFitsSystemWindows(true);
        setContentView(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new NativeAPI(), "PoseGuardNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !trusted(request.getUrl());
            }
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return bundled(request);
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                if (trusted(Uri.parse(url)) && !migratingAssets
                    && !getPreferences(0).getBoolean("native_assets_v2", false)) {
                    migratingAssets = true;
                    view.evaluateJavascript(
                        "(async()=>{try{if('serviceWorker'in navigator){for(const r of await "
                        + "navigator.serviceWorker.getRegistrations())await r.unregister();}if('caches'in "
                        + "window){for(const key of await "
                        + "caches.keys())if(key.startsWith('poseguard-'))await "
                        + "caches.delete(key);}}finally{window.PoseGuardNative.assetsMigrated();}})()",
                        null);
                }
            }
        });
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return bundled(request);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR)
                    android.util.Log.e(
                        "PoseGuardWeb", message.message() + " at line " + message.lineNumber());
                return true;
            }
        });
        if (Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> {
                    if (web.canGoBack())
                        web.goBack();
                    else
                        finish();
                });
        open(getIntent());
        if (getSharedPreferences("receiver", 0).getBoolean("enabled", false)
            && getSystemService(android.app.NotificationManager.class).areNotificationsEnabled()) {
            Intent service = new Intent(this, AlertService.class);
            if (Build.VERSION.SDK_INT >= 26)
                startForegroundService(service);
            else
                startService(service);
        }
    }
    private boolean trusted(Uri uri) {
        return "https".equals(uri.getScheme()) && "poseguard.nanaoni.tech".equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }
    private WebResourceResponse bundled(WebResourceRequest request) {
        if (!"GET".equals(request.getMethod()) || !trusted(request.getUrl()))
            return null;
        String path = request.getUrl().getPath();
        if (path != null && path.startsWith("/api/snapshots/")) {
            try {
                return Network.snapshot(path);
            } catch (Exception error) {
                android.util.Log.w("PoseGuard", "Snapshot load failed: " + error.getClass().getSimpleName());
                return null;
            }
        }
        if (path == null || path.contains("..") || path.startsWith("/api/") || path.startsWith("/downloads/")
            || path.startsWith("/.well-known/"))
            return null;
        String asset = path.startsWith("/assets/") || path.startsWith("/icons/") || path.equals("/icon.svg")
                || path.equals("/boot-check.js") || path.equals("/manifest.webmanifest")
            ? path.substring(1)
            : "index.html";
        String mime = asset.endsWith(".js")  ? "application/javascript"
            : asset.endsWith(".css")         ? "text/css"
            : asset.endsWith(".png")         ? "image/png"
            : asset.endsWith(".svg")         ? "image/svg+xml"
            : asset.endsWith(".webmanifest") ? "application/manifest+json"
                                             : "text/html";
        try {
            HashMap<String, String> headers = new HashMap<>();
            headers.put("Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' "
                + "data: blob:; connect-src 'self' wss://poseguard.nanaoni.tech; frame-src 'none'; "
                + "object-src 'none'");
            return new WebResourceResponse(
                mime, "UTF-8", 200, "OK", headers, getAssets().open("hub/" + asset));
        } catch (java.io.IOException error) {
            return null;
        }
    }
    private void open(Intent intent) {
        Uri uri = intent.getData();
        web.loadUrl(uri != null && trusted(uri) ? uri.toString() : Network.ORIGIN);
    }
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        open(intent);
    }
    @Override
    public void onBackPressed() {
        if (web.canGoBack())
            web.goBack();
        else
            super.onBackPressed();
    }
    @Override
    protected void onDestroy() {
        requests.shutdownNow();
        if (web != null) {
            web.removeJavascriptInterface("PoseGuardNative");
            web.destroy();
        }
        super.onDestroy();
    }
    private void startAlerts() {
        Intent service = new Intent(this, AlertService.class);
        if (Build.VERSION.SDK_INT >= 26)
            startForegroundService(service);
        else
            startService(service);
        Toast.makeText(this, "告警接收已开启，可在常驻通知中停止", Toast.LENGTH_LONG).show();
    }
    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 42 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED)
            startAlerts();
    }
    final class NativeAPI {
        @JavascriptInterface
        public boolean notificationsEnabled() {
            return getSharedPreferences("receiver", 0).getBoolean("enabled", false)
                && getSystemService(android.app.NotificationManager.class).areNotificationsEnabled();
        }
        @JavascriptInterface
        public void assetsMigrated() {
            getPreferences(0).edit().putBoolean("native_assets_v2", true).commit();
            runOnUiThread(() -> web.reload());
        }
        @JavascriptInterface
        public String installationId() {
            String id = getPreferences(0).getString("installation_id", "");
            if (id.isEmpty()) {
                id = UUID.randomUUID().toString();
                getPreferences(0).edit().putString("installation_id", id).commit();
            }
            return id;
        }
        @JavascriptInterface
        public void request(String id, String route, String method, String body) {
            if (!id.matches("[A-Za-z0-9-]{1,80}"))
                return;
            requests.execute(() -> {
                int status = 0;
                String result = "{\"error\":\"网络连接失败，请稍后重试\"}";
                try {
                    Network.Reply reply = Network.request(route, method, body, null);
                    status = reply.status;
                    result = reply.body;
                } catch (Exception error) {
                    android.util.Log.w(
                        "PoseGuard", "Native API request failed: " + error.getClass().getSimpleName());
                }
                final String script = "window.__poseguardNativeResult&&window.__poseguardNativeResult("
                    + JSONObject.quote(id) + "," + status + "," + JSONObject.quote(result) + ")";
                runOnUiThread(() -> {
                    if (!isFinishing())
                        web.evaluateJavascript(script, null);
                });
            });
        }
        @JavascriptInterface
        public void enableNotifications(String token, long cursor) {
            if (!token.matches("pgm_[A-Za-z0-9_-]{30,100}"))
                return;
            try {
                SecureStore.put(MainActivity.this, token);
                getSharedPreferences("receiver", 0)
                    .edit()
                    .putLong("cursor", cursor)
                    .putBoolean("bootstrapped", true)
                    .commit();
            } catch (Exception error) {
                return;
            }
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED)
                    requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 42);
                else
                    startAlerts();
            });
        }
    }
}
