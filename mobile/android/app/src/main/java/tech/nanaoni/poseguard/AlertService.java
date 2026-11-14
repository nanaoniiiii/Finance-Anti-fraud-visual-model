package tech.nanaoni.poseguard;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

public final class AlertService extends Service {
    private ScheduledExecutorService timer;
    private long cursor;
    private boolean bootstrapped = false;
    private NotificationManager manager;
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
    @Override
    public void onCreate() {
        super.onCreate();
        manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel status = new NotificationChannel(
                "receiver-status", "告警接收服务", NotificationManager.IMPORTANCE_LOW);
            status.setDescription("正在接收已绑定设备的风险通知");
            manager.createNotificationChannel(status);
            NotificationChannel alert =
                new NotificationChannel("risk-alerts", "设备紧急预警", NotificationManager.IMPORTANCE_HIGH);
            alert.enableVibration(true);
            manager.createNotificationChannel(alert);
        }
        cursor = getSharedPreferences("receiver", 0).getLong("cursor", 0);
        bootstrapped = getSharedPreferences("receiver", 0).getBoolean("bootstrapped", false);
    }
    private Notification.Builder builder(String channel) {
        return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel)
                                           : new Notification.Builder(this);
    }
    private PendingIntent open(String path) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setData(android.net.Uri.parse(Network.ORIGIN + path));
        intent.setFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
            this, path.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            stopReceiving();
            return START_NOT_STICKY;
        }
        Intent stop = new Intent(this, AlertService.class).setAction("stop");
        PendingIntent stopAction = PendingIntent.getService(
            this, 0, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification ongoing =
            builder("receiver-status")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("PoseGuard 告警接收已开启")
                .setContentText("保持设备预警同步；点击可进入管理台")
                .setOngoing(true)
                .setContentIntent(open("/notifications"))
                .addAction(new Notification.Action.Builder(null, "停止接收", stopAction).build())
                .build();
        startForeground(1, ongoing);
        getSharedPreferences("receiver", 0).edit().putBoolean("enabled", true).commit();
        if (timer == null) {
            timer = Executors.newSingleThreadScheduledExecutor();
            timer.scheduleWithFixedDelay(this::poll, 0, 6, TimeUnit.SECONDS);
        }
        return START_STICKY;
    }
    private void poll() {
        String token = SecureStore.get(this);
        if (token.isEmpty()) {
            stopReceiving();
            return;
        }
        try {
            String route = "/api/mobile/changes?after=" + cursor + (!bootstrapped ? "&bootstrap=1" : "");
            Network.Reply reply = Network.request(route, "GET", "", token);
            if (reply.status == 401) {
                stopReceiving();
                return;
            }
            if (reply.status != 200)
                return;
            JSONObject data = new JSONObject(reply.body);
            JSONArray changes = data.optJSONArray("changes");
            if (changes != null)
                for (int i = 0; i < changes.length(); i++) {
                    JSONObject change = changes.getJSONObject(i);
                    long sequence = change.getLong("seq");
                    if (sequence <= cursor)
                        continue;
                    if (sequence > getSharedPreferences("receiver", 0).getLong("posted_cursor", 0)) {
                        if (!postNotification(change))
                            return;
                        getSharedPreferences("receiver", 0)
                            .edit()
                            .putLong("posted_cursor", sequence)
                            .commit();
                    }
                    Network.Reply ack = Network.request(
                        "/api/mobile/ack", "POST", new JSONObject().put("seq", sequence).toString(), token);
                    // A concurrent edit of the device filter can make a
                    // previously fetched notification ineligible for receipt.
                    if (ack.status != 200 && ack.status != 404)
                        return;
                    cursor = sequence;
                    getSharedPreferences("receiver", 0).edit().putLong("cursor", cursor).commit();
                }
            cursor = data.optLong("cursor", cursor);
            getSharedPreferences("receiver", 0)
                .edit()
                .putLong("cursor", cursor)
                .putBoolean("bootstrapped", true)
                .commit();
            bootstrapped = true;
        } catch (Exception error) {
            android.util.Log.w("PoseGuard", "Alert sync retry: " + error.getClass().getSimpleName());
        }
    }
    private boolean postNotification(JSONObject change) throws Exception {
        if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled())
            return false;
        JSONObject data = change.getJSONObject("data");
        String category = change.optString("category"), entity = change.optString("entity_id");
        String risk = data.optString("risk_kind");
        String label = "phone_to_ear".equals(risk) ? "疑似通话姿态"
            : "multi_person".equals(risk)          ? "多人进入"
                                                     : "长时间停留";
        String title =
            data.optString("title", (data.optBoolean("test") ? "测试 · " : "") + "PoseGuard · " + label);
        String body = data.optString("body",
            data.optString("message",
                data.optString("device_name", "设备预警") + "，累计 " + data.optLong("observed_frames")
                    + " 帧，请核查。"));
        String path = "event".equals(category) ? "/events/" + entity : data.optString("url", "/devices");
        if (!path.startsWith("/") || path.startsWith("//"))
            path = "/";
        JSONObject local = new JSONObject()
                               .put("received_at", System.currentTimeMillis())
                               .put("seq", change.getLong("seq"))
                               .put("event", data);
        try (FileOutputStream stream = openFileOutput("received-events.jsonl", MODE_APPEND)) {
            stream.write((local.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            stream.getFD().sync();
        }
        Notification notification = builder("risk-alerts")
                                        .setSmallIcon(R.drawable.ic_notification)
                                        .setContentTitle(title)
                                        .setContentText(body)
                                        .setStyle(new Notification.BigTextStyle().bigText(body))
                                        .setCategory(Notification.CATEGORY_ALARM)
                                        .setPriority(Notification.PRIORITY_HIGH)
                                        .setAutoCancel(true)
                                        .setContentIntent(open(path))
                                        .build();
        manager.notify(1000 + (entity.hashCode() & 0x0fffffff), notification);
        return true;
    }
    private void stopReceiving() {
        getSharedPreferences("receiver", 0).edit().putBoolean("enabled", false).apply();
        stopSelf();
    }
    @Override
    public void onDestroy() {
        if (timer != null)
            timer.shutdownNow();
        stopForeground(true);
        super.onDestroy();
    }
}
