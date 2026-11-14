#if defined(POSEGUARD_CAMERA_XIAO)
#include <ArduinoWebsockets.h>
#endif
#include <Preferences.h>
#include <WiFi.h>
#include <esp_wifi.h>

#include <atomic>

#include "PoseGuardCloud.h"
#include "RootCA.h"
#include "CameraPreview.h"

namespace {
PoseGuardCloud cloud;
#if defined(POSEGUARD_CAMERA_XIAO)
SenseCameraPreview cameraPreview;
#endif
bool ready = false;
String configuredSsid;
String configuredPassword;
bool configuredSelectAccessPoint = false;
int8_t configuredTxPower = WIFI_POWER_19_5dBm;
uint32_t networkRecoveryAt = 45000;
unsigned networkRecoveries = 0;
std::atomic<int> disconnectReason{0};
std::atomic<unsigned> disconnectSequence{0};

void networkTask(void*) {
  for (;;) {
    cloud.networkTick();
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

void printStatus() {
  const auto status = WiFi.status();
  wifi_ap_record_t accessPoint{};
  const bool associated = esp_wifi_sta_get_ap_info(&accessPoint) == ESP_OK;
  Serial.printf(
      "WiFi=%d storage=%d bound=%d status=%d disconnect=%d clock_synced=%d "
      "ip=%s cloud_http=%d heartbeat_age_s=%lu associated=%d recoveries=%u "
      "tx_qdbm=%d key_length=%u temperature_c=%.1f\n",
      status == WL_CONNECTED, ready, cloud.bound(), status,
      disconnectReason.load(), time(nullptr) >= 1704067200,
      WiFi.localIP().toString().c_str(), cloud.lastHttpStatus(),
      static_cast<unsigned long>(cloud.lastHeartbeatAgeSeconds()), associated,
      networkRecoveries, WiFi.getTxPower(), configuredPassword.length(),
      temperatureRead());
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

void stopConnectionAttempt() {
  // Arduino's disconnect() skips a station that is still authenticating.
  // Cancel through IDF as well, otherwise set_config can fail with
  // "sta is connecting" while automatic retry races a profile change.
  WiFi.setAutoReconnect(false);
  const unsigned previous = disconnectSequence.load();
  if (esp_wifi_disconnect() == ESP_OK) {
    const uint32_t started = millis();
    while (disconnectSequence.load() == previous && millis() - started < 250)
      delay(10);
  }
}

void connectNetwork(const String& ssid, const String& password, int channel = 0,
                    const uint8_t* bssid = nullptr) {
  stopConnectionAttempt();
  disconnectReason.store(0);
  const auto status =
      WiFi.begin(ssid.c_str(), password.c_str(), channel, bssid);
  WiFi.setTxPower(static_cast<wifi_power_t>(configuredTxPower));
  if (status == WL_CONNECT_FAILED)
    Serial.println("wifi_begin=failed; saved profile will retry");
}

void connectStoredNetwork(const String& ssid, const String& password,
                          bool selectAccessPoint) {
  if (!selectAccessPoint) {
    connectNetwork(ssid, password);
    return;
  }

  stopConnectionAttempt();
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
      settings.putString("password", password) == password.length() &&
      settings.putBool("select_ap", pinAccessPoint) == 1;
  settings.end();
  if (!saved) {
    Serial.println("保存 Wi-Fi 失败，请检查 NVS 分区");
    return;
  }
  configuredSsid = ssid;
  configuredPassword = password;
  configuredSelectAccessPoint = pinAccessPoint;
  connectStoredNetwork(ssid, password, pinAccessPoint);
  networkRecoveryAt = millis() + 45000;
  Serial.println("Wi-Fi 已保存，正在连接");
}

void recoverNetworkIfStalled() {
  const uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED || configuredSsid.isEmpty()) {
    networkRecoveryAt = now + 45000;
    return;
  }
  if (static_cast<int32_t>(now - networkRecoveryAt) < 0) return;

  // AutoReconnect reacts to disconnect events, but an association without
  // a DHCP address can otherwise remain idle indefinitely. Reapply the saved
  // profile without destroying the interface or persistent device state.
  ++networkRecoveries;
  Serial.printf("wifi_recovery=%u\n", networkRecoveries);
  connectStoredNetwork(configuredSsid, configuredPassword,
                       configuredSelectAccessPoint);
  networkRecoveryAt = millis() + 45000;
}

void configurePower(const String& level) {
  int8_t power;
  if (level == "AUTO" || level == "19.5")
    power = WIFI_POWER_19_5dBm;
  else if (level == "8.5")
    power = WIFI_POWER_8_5dBm;
  else if (level == "2")
    power = WIFI_POWER_2dBm;
  else {
    Serial.println("TXPOWER accepts AUTO, 8.5 or 2 dBm");
    return;
  }
  Preferences settings;
  const bool saved = settings.begin("pg-network", false) &&
                     settings.putChar("tx_power", power) == 1;
  settings.end();
  if (!saved) {
    Serial.println("Saving radio configuration failed");
    return;
  }
  configuredTxPower = power;
  connectStoredNetwork(configuredSsid, configuredPassword,
                       configuredSelectAccessPoint);
  networkRecoveryAt = millis() + 45000;
  Serial.printf("tx_power_qdbm=%d\n", configuredTxPower);
}
}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(1000);
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      disconnectReason.store(info.wifi_sta_disconnected.reason);
      disconnectSequence.fetch_add(1);
    } else if (event == ARDUINO_EVENT_WIFI_STA_CONNECTED ||
               event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
      disconnectReason.store(0);
    }
  });
  // Credentials are owned by pg-network Preferences; avoid SDK NVS writes.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  WiFi.setSleep(false);
  Preferences settings;
  if (settings.begin("pg-network", true)) {
    configuredSsid = settings.getString("ssid");
    configuredPassword = settings.getString("password");
    configuredSelectAccessPoint =
        settings.getBool("select_ap", configuredPassword.length() == 64);
    configuredTxPower = settings.getChar("tx_power", WIFI_POWER_19_5dBm);
    if (configuredTxPower != WIFI_POWER_19_5dBm &&
        configuredTxPower != WIFI_POWER_8_5dBm &&
        configuredTxPower != WIFI_POWER_2dBm)
      configuredTxPower = WIFI_POWER_19_5dBm;
    settings.end();
  }
  ready = cloud.begin("https://poseguard.nanaoni.tech", POSEGUARD_ROOT_CA);
  // Finish flash/storage setup before starting authentication with the AP.
  if (!configuredSsid.isEmpty())
    connectStoredNetwork(configuredSsid, configuredPassword,
                         configuredSelectAccessPoint);
  configTime(0, 0, "time.cloudflare.com", "pool.ntp.org", "ntp.aliyun.com");
  if (ready) xTaskCreate(networkTask, "pg-cloud", 16384, nullptr, 1, nullptr);
#if defined(POSEGUARD_CAMERA_XIAO)
  if (ready) cameraPreview.begin(cloud, POSEGUARD_ROOT_CA);
#endif
  Serial.println(
      "PoseGuard ESP32-S3 1.3.0 "
      "已启动。可用命令：WIFI、TXPOWER、BIND、STATUS、SCAN、INIT_STORAGE");
}

void loop() {
  if (ready) cloud.localTick();
  recoverNetworkIfStalled();
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    if (line.endsWith("\r")) line.remove(line.length() - 1);
    if (line.startsWith("WIFI ")) {
      configureNetwork(line);
    } else if (line.startsWith("WIFI_AP ")) {
      configureNetwork("WIFI " + line.substring(8), true);
    } else if (line.startsWith("TXPOWER ")) {
      configurePower(line.substring(8));
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
