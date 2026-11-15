package tech.nanaoni.poseguard;

import android.webkit.CookieManager;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

final class Network {
    static final String ORIGIN = "https://poseguard.nanaoni.tech";
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
        .writeTimeout(12, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).build();
    static final class Reply {
        final int status;
        final String body;
        Reply(int status, String body) { this.status = status; this.body = body; }
    }
    private static final class RawReply {
        final int status;
        final String mime;
        final byte[] bytes;
        RawReply(int status, String mime, byte[] bytes) {
            this.status = status; this.mime = mime; this.bytes = bytes;
        }
    }
    private static RawReply execute(String route, String method, String body, String receiverToken)
        throws Exception {
        if (!route.startsWith("/api/") || route.contains("\\") || route.contains("..")
            || route.contains("#") || route.length() > 500)
            throw new IllegalArgumentException("Invalid API route");
        if (!method.matches("GET|POST|PUT|PATCH|DELETE") || body.length() > 420000)
            throw new IllegalArgumentException("Invalid request");
        Request.Builder request = new Request.Builder().url(ORIGIN + route)
            .header("User-Agent", "PoseGuard-Android/1.5.0")
            .header("Accept", "application/json").header("Origin", ORIGIN);
        if (receiverToken != null) request.header("Authorization", "Bearer " + receiverToken);
        else {
            String cookie = CookieManager.getInstance().getCookie(ORIGIN);
            if (cookie != null) request.header("Cookie", cookie);
        }
        request.method(method, "GET".equals(method) ? null : RequestBody.create(body, JSON));
        try (Response response = HTTP.newCall(request.build()).execute()) {
            if (receiverToken == null) {
                for (String cookie : response.headers("Set-Cookie"))
                    CookieManager.getInstance().setCookie(ORIGIN, cookie);
                if (!response.headers("Set-Cookie").isEmpty()) CookieManager.getInstance().flush();
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (response.body() != null) try (InputStream input = response.body().byteStream()) {
                byte[] block = new byte[8192]; int count;
                while ((count = input.read(block)) != -1) {
                    if (bytes.size() + count > 1048576) throw new java.io.IOException("Response too large");
                    bytes.write(block, 0, count);
                }
            }
            String mime = response.header("Content-Type", "application/octet-stream").split(";")[0];
            return new RawReply(response.code(), mime, bytes.toByteArray());
        }
    }
    static Reply request(String route, String method, String body, String receiverToken) throws Exception {
        RawReply reply = execute(route, method, body, receiverToken);
        return new Reply(reply.status, new String(reply.bytes, StandardCharsets.UTF_8));
    }
    static android.webkit.WebResourceResponse snapshot(String route) throws Exception {
        if (!route.matches("/api/snapshots/[A-Za-z0-9_-]{1,100}")) return null;
        RawReply reply = execute(route, "GET", "", null);
        HashMap<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new android.webkit.WebResourceResponse(reply.mime, null, reply.status,
            reply.status == 200 ? "OK" : "Error", headers, new ByteArrayInputStream(reply.bytes));
    }
}
