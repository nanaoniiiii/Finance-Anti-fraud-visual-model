#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_timer.h>
#include <mbedtls/base64.h>

#include <memory>

#include "incident_counter.hpp"

// Transport adapter. Feed this from a real detector or an authenticated local
// gateway; this library does not pretend to run YOLO11 on an ESP32-S3.
class PoseGuardCloud {
 public:
  bool begin(const char* server, const char* rootCA) {
    server_ = server;
    ca_ = rootCA;
    if (!server_.startsWith("https://")) return false;
    lock_ = xSemaphoreCreateMutex();
    if (!lock_ || !LittleFS.begin(false)) return false;
    store_.begin("poseguard", false);
    token_ = store_.getString("token");
    device_ = store_.getString("device");
    session_ = randomID();
    LittleFS.mkdir("/outbox");
    LittleFS.mkdir("/evidence");
    LittleFS.mkdir("/commands");
    return true;
  }
  bool bind(const String& code) {
    if (WiFi.status() != WL_CONNECTED || time(nullptr) < 1704067200)
      return false;
    JsonDocument request, response;
    request["code"] = code;
    request["platform"] = "esp32s3";
    if (!post("/api/enroll", request, response, false)) return false;
    token_ = response["device_token"].as<String>();
    device_ = response["device_id"].as<String>();
    if (token_.isEmpty() || device_.isEmpty()) return false;
    store_.putString("token", token_);
    store_.putString("device", device_);
    return true;
  }
  bool bound() const { return !token_.isEmpty(); }
  void setHealth(float fps, int people, const String& mode = "running") {
    fps_ = fps;
    people_ = people;
    mode_ = mode;
  }
  // risk: 1 phone_to_ear, 2 multi_person, 3 lingering.
  // state: 0 normal, 1 orange candidate, 2 red alert; predicted frames use
  // fresh=false.
  void observe(int track, int risk, int state, bool fresh,
               const uint8_t* croppedJPEG = nullptr, size_t length = 0) {
    if (!lock_ || risk < 1 || risk > 3) return;
    Guard guard(lock_);
    auto change = counts_.observe(track, risk, state, millis64(), fresh);
    if (!change.counter) return;
    auto& c = *change.counter;
    size_t index = &c - counts_.slots.data();
    if (change.started) {
      ids_[index] = randomID();
      occurred_[index] = utc();
      local(c, "special_state_started");
    }
    if (change.report) {
      if (!queue(c, change.escalated ? "escalated" : "created", croppedJPEG,
                 length)) {
        c.reported = change.escalated;
        c.severity = change.escalated ? c.severity - 1 : 0;
        if (c.revision) --c.revision;
      } else if (change.staff_needed)
        local(c, "staff_intervention_requested");
    }
  }
  // Call frequently from the inference loop; it only touches local storage.
  void localTick() {
    if (!lock_) return;
    Guard guard(lock_);
    counts_.expire(millis64(), [&](auto& c) {
      local(c, "special_state_cleared");
      if (c.reported) {
        ++c.revision;
        queue(c, "resolved");
      }
    });
  }
  // Run in its own task. HTTPS requests may block while the link is down.
  void networkTick() {
    if (!bound() || WiFi.status() != WL_CONNECTED ||
        time(nullptr) < 1704067200 || millis() < retryAt_)
      return;
    if (millis() - lastHeartbeat_ >= 30000 || lastHeartbeat_ == 0) {
      JsonDocument request, response;
      request["mode"] = mode_;
      request["fps"] = fps_;
      request["people"] = people_;
      request["firmware"] = "poseguard-esp32s3/1.2.0";
      request["clock_synced"] = true;
      request["capabilities"]["external_detections"] = true;
      request["capabilities"]["local_evidence"] = true;
      if (!post("/api/device/heartbeat", request, response)) {
        backoff();
        return;
      }
      lastHeartbeat_ = millis();
      {
        Guard guard(lock_);
        auto rules = response["rules"];
        counts_.policy.threshold = rules["frame_threshold"] | 100;
        counts_.policy.escalation = rules["escalation_threshold"] | 300;
        counts_.policy.include_candidates = rules["include_candidates"] | true;
        counts_.policy.grace_ms =
            uint32_t((rules["clear_grace_seconds"] | 2.0) * 1000);
      }
      for (JsonObject command : response["pending_commands"].as<JsonArray>()) {
        String id = command["id"];
        String path = "/commands/" + id + ".json";
        {
          Guard guard(lock_);
          if (!LittleFS.exists(path)) {
            File f = LittleFS.open(path, "w");
            if (!f || serializeJson(command, f) == 0) return;
            f.flush();
            f.close();
            File log = LittleFS.open("/interventions.jsonl", "a");
            if (!log) return;
            serializeJson(command, log);
            log.println();
            log.flush();
            log.close();
            Serial.println("工作人员介入请求已记录：" + id);
          }
        }
        JsonDocument empty, ack;
        post("/api/device/commands/" + id + "/ack", empty, ack);
      }
    }
    String file;
    {
      Guard guard(lock_);
      File directory = LittleFS.open("/outbox");
      File item = directory.openNextFile();
      while (item) {
        String candidate = item.name();
        if (candidate.endsWith(".json") && (file.isEmpty() || candidate < file))
          file = candidate;
        item = directory.openNextFile();
      }
    }
    if (file.isEmpty()) return;
    String path = file.startsWith("/") ? file : "/outbox/" + file;
    JsonDocument payload, response;
    {
      Guard guard(lock_);
      File f = LittleFS.open(path, "r");
      if (!f || deserializeJson(payload, f)) return;
    }
    if (post("/api/device/events", payload, response) &&
        response["accepted"] == true) {
      Guard guard(lock_);
      File receipt = LittleFS.open("/receipts.jsonl", "a");
      if (!receipt) return;
      JsonDocument row;
      row["event_id"] = payload["event_id"];
      row["revision"] = payload["revision"];
      row["accepted_at"] = utc();
      serializeJson(row, receipt);
      receipt.println();
      receipt.flush();
      receipt.close();
      LittleFS.remove(path);
      failures_ = 0;
    } else
      backoff();
  }

 private:
  struct Guard {
    SemaphoreHandle_t lock;
    explicit Guard(SemaphoreHandle_t l) : lock(l) {
      xSemaphoreTake(lock, portMAX_DELAY);
    }
    ~Guard() { xSemaphoreGive(lock); }
  };
  poseguard_cloud::Counters counts_;
  String ids_[24], occurred_[24];
  Preferences store_;
  SemaphoreHandle_t lock_{};
  String server_, token_, device_, session_, mode_{"transport_ready"};
  const char* ca_{};
  float fps_{};
  int people_{};
  uint32_t lastHeartbeat_{}, retryAt_{};
  int failures_{};
  static uint64_t millis64() { return uint64_t(esp_timer_get_time() / 1000); }
  static String randomID() {
    char value[33];
    snprintf(value, sizeof value, "%08lx%08lx%08lx%08lx",
             (unsigned long)esp_random(), (unsigned long)esp_random(),
             (unsigned long)esp_random(), (unsigned long)esp_random());
    return value;
  }
  static String utc() {
    time_t value = time(nullptr);
    tm fields{};
    gmtime_r(&value, &fields);
    char result[30];
    strftime(result, sizeof result, "%Y-%m-%dT%H:%M:%SZ", &fields);
    return result;
  }
  void fields(JsonDocument& d, const poseguard_cloud::Counter& c) {
    size_t index = &c - counts_.slots.data();
    d["event_id"] = ids_[index];
    d["session_id"] = session_;
    d["track_id"] = c.track_id;
    d["revision"] = c.revision;
    d["risk_kind"] = c.risk == 1   ? "phone_to_ear"
                     : c.risk == 2 ? "multi_person"
                                   : "lingering";
    d["model_state"] = c.state == 2 ? "alert" : "candidate";
    d["confirmed_seen"] = c.confirmed;
    d["observed_frames"] = c.count;
    d["severity"] = c.severity;
    d["occurred_at"] = occurred_[index];
    d["updated_at"] = utc();
    d["clock_synced"] = time(nullptr) >= 1704067200;
  }
  void local(const poseguard_cloud::Counter& c, const char* action) {
    JsonDocument doc;
    fields(doc, c);
    doc["action"] = action;
    File file = LittleFS.open("/incidents.jsonl", "a");
    if (file) {
      serializeJson(doc, file);
      file.println();
      file.flush();
      file.close();
    }
  }
  bool queue(const poseguard_cloud::Counter& c, const char* type,
             const uint8_t* jpeg = nullptr, size_t length = 0) {
    JsonDocument doc;
    fields(doc, c);
    doc["update_type"] = type;
    if (jpeg && length > 0 && length <= 60000) {
      String file = "/evidence/" + doc["event_id"].as<String>() + "-" +
                    String(c.revision) + ".jpg";
      File image = LittleFS.open(file, "w");
      if (image) {
        image.write(jpeg, length);
        image.flush();
        image.close();
      }
      size_t capacity = 4 * ((length + 2) / 3) + 1;
      std::unique_ptr<unsigned char[]> encoded(
          new (std::nothrow) unsigned char[capacity]);
      size_t output = 0;
      if (encoded && mbedtls_base64_encode(encoded.get(), capacity, &output,
                                           jpeg, length) == 0) {
        encoded[output] = 0;
        doc["snapshot"]["data_base64"] =
            String(reinterpret_cast<const char*>(encoded.get()));
        doc["snapshot"]["captured_at"] = utc();
      }
    }
    char revision[16];
    snprintf(revision, sizeof revision, "-r%06lu", (unsigned long)c.revision);
    String file =
        "/outbox/" + doc["event_id"].as<String>() + revision + ".json";
    String temporary = file + ".new";
    File out = LittleFS.open(temporary, "w");
    if (!out) return false;
    size_t expected = measureJson(doc);
    size_t written = serializeJson(doc, out);
    out.flush();
    out.close();
    if (written != expected || doc.overflowed() ||
        !LittleFS.rename(temporary, file)) {
      Serial.println("本地告警存储失败，请检查剩余空间");
      return false;
    }
    local(c, type);
    return true;
  }
  bool post(const String& route, JsonDocument& input, JsonDocument& output,
            bool authenticated = true) {
    WiFiClientSecure tls;
    tls.setCACert(ca_);
    tls.setTimeout(12000);
    HTTPClient http;
    http.setTimeout(12000);
    if (!http.begin(tls, server_ + route)) return false;
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    http.addHeader("Content-Type", "application/json");
    http.setUserAgent("PoseGuard/1.2.0");
    if (authenticated) http.addHeader("Authorization", "Bearer " + token_);
    String text;
    serializeJson(input, text);
    int status = http.POST(text);
    if (status >= 200 && status < 300) {
      auto error = deserializeJson(output, http.getString());
      http.end();
      return !error;
    }
    http.end();
    return false;
  }
  void backoff() {
    failures_ = min(6, failures_ + 1);
    retryAt_ = millis() + min(60000UL, 1000UL << failures_);
  }
};
