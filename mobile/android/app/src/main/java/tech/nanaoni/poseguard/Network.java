package tech.nanaoni.poseguard;
import android.webkit.CookieManager;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

final class Network {
    static final String ORIGIN = "https://poseguard.nanaoni.tech";
    static final class Reply {
        final int status;
        final String body;
        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }
    static android.webkit.WebResourceResponse snapshot(String route) throws Exception {
        if (!route.matches("/api/snapshots/[A-Za-z0-9_-]{1,100}"))
            return null;
        HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + route).openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(15000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("User-Agent", "PoseGuard-Android/1.2.0");
        String cookie = CookieManager.getInstance().getCookie(ORIGIN);
        if (cookie != null)
            connection.setRequestProperty("Cookie", cookie);
        try {
            int status = connection.getResponseCode();
            String mime = connection.getContentType();
            if (mime == null)
                mime = "application/octet-stream";
            mime = mime.split(";")[0];
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (stream != null)
                try (InputStream input = stream) {
                    byte[] block = new byte[8192];
                    int count;
                    while ((count = input.read(block)) != -1) {
                        if (bytes.size() + count > 1048576)
                            throw new java.io.IOException("Image too large");
                        bytes.write(block, 0, count);
                    }
                }
            java.util.HashMap<String, String> headers = new java.util.HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new android.webkit.WebResourceResponse(mime, null, status, status == 200 ? "OK" : "Error",
                headers, new java.io.ByteArrayInputStream(bytes.toByteArray()));
        } finally {
            connection.disconnect();
        }
    }
    static Reply request(String route, String method, String body, String receiverToken) throws Exception {
        if (!route.startsWith("/api/") || route.contains("\\") || route.contains("..") || route.contains("#")
            || route.length() > 500)
            throw new IllegalArgumentException("Invalid API route");
        if (!method.matches("GET|POST|PUT|PATCH|DELETE"))
            throw new IllegalArgumentException("Invalid method");
        if (body.length() > 420000)
            throw new IllegalArgumentException("Payload too large");
        HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + route).openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(15000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        connection.setRequestProperty("User-Agent", "PoseGuard-Android/1.2.0");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Origin", ORIGIN);
        if (receiverToken != null)
            connection.setRequestProperty("Authorization", "Bearer " + receiverToken);
        else {
            String cookie = CookieManager.getInstance().getCookie(ORIGIN);
            if (cookie != null)
                connection.setRequestProperty("Cookie", cookie);
        }
        try {
            if (!body.isEmpty() || !method.equals("GET")) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = (body.isEmpty() ? "{}" : body).getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
            }
            int status = connection.getResponseCode();
            if (receiverToken == null) {
                for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                    if ("Set-Cookie".equalsIgnoreCase(entry.getKey()))
                        for (String cookie : entry.getValue())
                            CookieManager.getInstance().setCookie(ORIGIN, cookie);
                }
                CookieManager.getInstance().flush();
            }
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (stream != null)
                try (InputStream input = stream) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > 1048576)
                            throw new java.io.IOException("Response too large");
                        output.write(buffer, 0, count);
                    }
                }
            return new Reply(status, output.toString("UTF-8"));
        } finally {
            connection.disconnect();
        }
    }
}
