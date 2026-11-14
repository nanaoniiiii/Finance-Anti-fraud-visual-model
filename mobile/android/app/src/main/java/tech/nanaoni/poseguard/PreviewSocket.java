package tech.nanaoni.poseguard;

import android.util.Base64;
import android.util.Log;
import android.webkit.CookieManager;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

// A first-party socket for the embedded UI. Frames use the native Android
// network stack and remain binary on the network; Base64 is only the JNI bridge.
final class PreviewSocket {
    interface Events {
        void emit(String id, String kind, String payload);
    }
    private final Events events;
    private final OkHttpClient client = new OkHttpClient.Builder()
                                            .connectTimeout(12, TimeUnit.SECONDS)
                                            .readTimeout(12, TimeUnit.SECONDS)
                                            .pingInterval(20, TimeUnit.SECONDS)
                                            .followRedirects(false)
                                            .followSslRedirects(false)
                                            .build();
    private String current;
    private WebSocket socket;
    PreviewSocket(Events events) {
        this.events = events;
    }

    synchronized void open(String id, String path) {
        if (!id.matches("[A-Za-z0-9-]{1,80}")
            || !path.matches("/api/devices/[0-9a-fA-F-]{36}/preview/connect"))
            return;
        close(null, "replaced");
        current = id;
        Request.Builder request = new Request.Builder()
                                      .url("wss://poseguard.nanaoni.tech" + path)
                                      .header("Origin", Network.ORIGIN)
                                      .header("User-Agent", "PoseGuard-Android/1.3.0");
        String cookie = CookieManager.getInstance().getCookie(Network.ORIGIN);
        if (cookie != null)
            request.header("Cookie", cookie);
        socket = client.newWebSocket(request.build(), new WebSocketListener() {
            private boolean active() {
                synchronized (PreviewSocket.this) {
                    return id.equals(current);
                }
            }
            @Override
            public void onOpen(WebSocket ws, Response response) {
                Log.i("PoseGuardPreview", "connected");
                if (active())
                    events.emit(id, "open", "");
                else
                    ws.close(1000, "replaced");
            }
            @Override
            public void onMessage(WebSocket ws, String text) {
                if (text.length() > 8192) {
                    ws.close(1009, "Control too large");
                    return;
                }
                if (active())
                    events.emit(id, "text", text);
            }
            @Override
            public void onMessage(WebSocket ws, ByteString bytes) {
                if (bytes.size() > 614400) {
                    ws.close(1009, "Frame too large");
                    return;
                }
                if (active())
                    events.emit(
                        id, "binary", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
            }
            @Override
            public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(code, reason);
            }
            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                Log.i("PoseGuardPreview", "closed code=" + code + " reason=" + reason);
                if (active())
                    events.emit(id, "closed", closeJSON(code, reason));
            }
            @Override
            public void onFailure(WebSocket ws, Throwable error, Response response) {
                Log.i("PoseGuardPreview", "failed=" + error.getClass().getSimpleName()
                    + " http=" + (response == null ? 0 : response.code()));
                if (active()) {
                    String message = response != null && response.code() == 401
                        ? "登录已过期，请重新进入工作台"
                        : "预览连接中断，可点击请求预览重试";
                    events.emit(id, "error", message);
                    events.emit(id, "closed", closeJSON(1006, "network_error"));
                }
            }
        });
    }
    synchronized void send(String id, String text) {
        if (!id.equals(current) || text.length() > 2048 || socket == null)
            return;
        try {
            String type = new JSONObject(text).optString("type");
            if (type.equals("keepalive") || type.equals("ack") || type.equals("keyframe"))
                socket.send(text);
        } catch (Exception ignored) {
        }
    }
    synchronized void close(String id, String reason) {
        if (id != null && !id.equals(current))
            return;
        if (socket != null) {
            String previous = current;
            socket.close(1000, reason);
            if (previous != null)
                events.emit(previous, "closed", closeJSON(1000, reason));
        }
        socket = null;
        current = null;
    }
    void destroy() {
        close(null, "page_closed");
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
    }
    private static String closeJSON(int code, String reason) {
        try {
            return new JSONObject().put("code", code).put("reason", reason).toString();
        } catch (Exception ignored) {
            return "{}";
        }
    }
}
