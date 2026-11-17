package tech.nanaoni.poseguard;

import android.os.SystemClock;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import okhttp3.Call;
import okhttp3.Connection;
import okhttp3.Dns;
import okhttp3.EventListener;
import okhttp3.Protocol;
import org.json.JSONArray;
import org.json.JSONObject;

// Expiring candidates come from this app's HTTPS origin. OkHttp still verifies
// the original hostname and certificate, independently of the selected address.
final class CloudDns implements Dns {
    static final CloudDns INSTANCE = new CloudDns();
    static final class Trace { volatile InetAddress peer; }
    private final List<InetAddress> hints = new ArrayList<>();
    private final HashMap<String, Long> failures = new HashMap<>();
    private long until;
    private String preferred;

    synchronized boolean fresh() { return !hints.isEmpty() && SystemClock.elapsedRealtime() < until; }
    synchronized void install(JSONObject value) throws Exception {
        if (!"poseguard.nanaoni.tech".equals(value.optString("host"))) return;
        long ttl = value.optLong("expires_unix") - System.currentTimeMillis() / 1000;
        if (ttl <= 0 || ttl > 3600) return;
        JSONArray values = value.optJSONArray("addresses");
        if (values == null) return;
        List<InetAddress> next = new ArrayList<>();
        for (int i = 0; i < values.length() && next.size() < 4; i++) {
            String text = values.optString(i);
            if (!text.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) continue;
            InetAddress address = InetAddress.getByName(text);
            if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
                || address.isSiteLocalAddress() || address.isMulticastAddress()) continue;
            if (!next.contains(address)) next.add(address);
        }
        if (next.isEmpty()) return;
        hints.clear(); hints.addAll(next);
        until = SystemClock.elapsedRealtime() + Math.min(300, ttl) * 1000;
    }
    private synchronized List<InetAddress> ranked(List<InetAddress> values) {
        List<InetAddress> ready = new ArrayList<>();
        long now = SystemClock.elapsedRealtime();
        for (InetAddress address : values)
            if (failures.getOrDefault(address.getHostAddress(), 0L) <= now) ready.add(address);
        if (ready.isEmpty()) ready.addAll(values);
        ready.sort((a,b) -> Boolean.compare(!a.getHostAddress().equals(preferred), !b.getHostAddress().equals(preferred)));
        return ready;
    }
    @Override public List<InetAddress> lookup(String hostname) throws UnknownHostException {
        if (!"poseguard.nanaoni.tech".equals(hostname)) return Dns.SYSTEM.lookup(hostname);
        Network.refreshRoutes();
        List<InetAddress> values;
        synchronized (this) { values = fresh() ? new ArrayList<>(hints) : new ArrayList<>(); }
        if (values.isEmpty()) values.addAll(Dns.SYSTEM.lookup(hostname));
        return ranked(values);
    }
    synchronized void failed(InetAddress address) {
        if (address == null) return;
        failures.put(address.getHostAddress(), SystemClock.elapsedRealtime() + 30000);
        if (address.getHostAddress().equals(preferred)) preferred = null;
    }
    private synchronized void good(InetAddress address) {
        if (address != null) { preferred = address.getHostAddress(); failures.remove(preferred); }
    }
    static EventListener listener() {
        return new EventListener() {
            InetAddress peer;
            @Override public void connectionAcquired(Call call, Connection connection) {
                peer = connection.route().socketAddress().getAddress();
                Trace trace = call.request().tag(Trace.class);
                if (trace != null) trace.peer = peer;
                INSTANCE.good(peer);
            }
            @Override public void connectFailed(Call call, InetSocketAddress address, Proxy proxy,
                                                 Protocol protocol, IOException error) {
                INSTANCE.failed(address.getAddress());
            }
            @Override public void callFailed(Call call, IOException error) { INSTANCE.failed(peer); }
        };
    }
}
