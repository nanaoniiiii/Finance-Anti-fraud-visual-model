#include <Preferences.h>
#include <WiFi.h>

#include <atomic>

#include "PoseGuardCloud.h"
#include "RootCA.h"

namespace {
PoseGuardCloud cloud;
bool ready = false;
String configuredSsid;
std::atomic<int> disconnectReason{0};

void networkTask(void*) {
  for (;;) {
    cloud.networkTick();
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

void printStatus() {
  const auto status = WiFi.status();
  Serial.printf(
      "WiFi=%d storage=%d bound=%d status=%d disconnect=%d clock_synced=%d "
      "ip=%s\n",
      status == WL_CONNECTED, ready, cloud.bound(), status,
      disconnectReason.load(), time(nullptr) >= 1704067200,
      WiFi.localIP().toString().c_str());
}

void scanConfiguredNetwork() {
  const int count = WiFi.scanNetworks();
  for (int i = 0; i < count; ++i) {
    if (WiFi.SSID(i) == configuredSsid) {
      Serial.printf("configured_network channel=%d rssi=%d security=%d\n",
                    WiFi.channel(i), WiFi.RSSI(i), WiFi.encryptionType(i));
    }
  }
  Serial.printf("scan_complete count=%d\n", count);
  WiFi.scanDelete();
}

void connectNetwork(const String& ssid, const String& password, int channel = 0,
                    const uint8_t* bssid = nullptr) {
  WiFi.disconnect();
  disconnectReason.store(0);
  WiFi.begin(ssid.c_str(), password.c_str(), channel, bssid);
}

void configureNetwork(const String& line, bool pinAccessPoint = false) {
  const int separator = line.indexOf('|', 5);
  if (separator <= 5) {
    Serial.println("用法：WIFI 网络名|密码");
    return;
  }
  const String ssid = line.substring(5, separator);
  const String password = line.substring(separator + 1);
  bool rawPsk = password.length() == 64;
  for (size_t i = 0; rawPsk && i < password.length(); ++i) {
    rawPsk = isxdigit(static_cast<unsigned char>(password[i])) != 0;
  }
  if (ssid.length() > 32 || password.length() < 8 ||
      (password.length() > 63 && !rawPsk)) {
    Serial.println("Wi-Fi 名称或密码长度无效");
    return;
  }
  Preferences settings;
  const bool saved =
      settings.begin("pg-network", false) &&
      settings.putString("ssid", ssid) == ssid.length() &&
      settings.putString("password", password) == password.length();
  settings.end();
  if (!saved) {
    Serial.println("保存 Wi-Fi 失败，请检查 NVS 分区");
    return;
  }
  configuredSsid = ssid;
  if (pinAccessPoint) {
    WiFi.disconnect();
    const int count = WiFi.scanNetworks();
    int strongest = -1;
    for (int i = 0; i < count; ++i) {
      if (WiFi.SSID(i) == ssid &&
          (strongest < 0 || WiFi.RSSI(i) > WiFi.RSSI(strongest))) {
        strongest = i;
      }
    }
    if (strongest >= 0) {
      uint8_t bssid[6];
      memcpy(bssid, WiFi.BSSID(strongest), sizeof(bssid));
      connectNetwork(ssid, password, WiFi.channel(strongest), bssid);
    } else {
      connectNetwork(ssid, password);
    }
    WiFi.scanDelete();
  } else {
    connectNetwork(ssid, password);
  }
  Serial.println("Wi-Fi 已保存，正在连接");
}
}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(1000);
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      disconnectReason.store(info.wifi_sta_disconnected.reason);
    } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
      disconnectReason.store(0);
    }
  });
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  Preferences settings;
  if (settings.begin("pg-network", true)) {
    configuredSsid = settings.getString("ssid");
    const String password = settings.getString("password");
    settings.end();
    if (!configuredSsid.isEmpty())
      WiFi.begin(configuredSsid.c_str(), password.c_str());
  }
  configTime(0, 0, "time.cloudflare.com", "pool.ntp.org", "ntp.aliyun.com");
  ready = cloud.begin("https://poseguard.nanaoni.tech", POSEGUARD_ROOT_CA);
  if (ready) xTaskCreate(networkTask, "pg-cloud", 16384, nullptr, 1, nullptr);
  Serial.println(
      "PoseGuard ESP32-S3 1.2.0 "
      "已启动。可用命令：WIFI、BIND、STATUS、SCAN、INIT_STORAGE");
}

void loop() {
  if (ready) cloud.localTick();
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    if (line.endsWith("\r")) line.remove(line.length() - 1);
    if (line.startsWith("WIFI ")) {
      configureNetwork(line);
    } else if (line.startsWith("WIFI_AP ")) {
      configureNetwork("WIFI " + line.substring(8), true);
    } else if (line.startsWith("BIND ") && ready) {
      Serial.println(cloud.bind(line.substring(5))
                         ? "设备已绑定"
                         : "绑定失败，请检查联网、NTP 时间和一次性绑定码");
    } else if (line == "STATUS") {
      printStatus();
    } else if (line == "SCAN") {
      scanConfiguredNetwork();
    } else if (line == "INIT_STORAGE" && !ready && LittleFS.format()) {
      Serial.println("存储初始化成功，设备重启");
      ESP.restart();
    }
  }
  delay(10);
}
// Integrate a real detector in your inference task:
// cloud.observe(trackId, riskKind, state, fresh, croppedJPEG, jpegLength);
// cloud.setHealth(detectorFPS, currentPeople);
// This sketch sends health and staff-command receipts, and produces no fake
// risks.
