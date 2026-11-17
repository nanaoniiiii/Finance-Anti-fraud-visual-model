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

#include <atomic>
#include <algorithm>
#include <functional>
#include <memory>
#include <vector>

#include "CloudTlsClient.h"
#include "BoundedHttpJson.h"
#include "incident_counter.hpp"

// Durable event/transport adapter. Sense builds run their model locally through
// S3Pipeline; generic adapters can supply observations from their own detector.
class PoseGuardCloud {
 public:
  bool begin(const char* server, const char* rootCA) {
    server_ = server;
    ca_ = rootCA;
    if (!server_.startsWith("https://")) return false;
    lock_ = xSemaphoreCreateMutex();
    transportLock_ = xSemaphoreCreateMutex();
    if (!lock_ || !transportLock_ || !LittleFS.begin(false)) return false;
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
    const String token = response["device_token"].as<String>();
    const String device = response["device_id"].as<String>();
    if (token.isEmpty() || device.isEmpty()) return false;
    Guard guard(lock_);
    token_ = token; device_ = device;
    store_.putString("token", token_);
    store_.putString("device", device_);
    return true;
  }
  bool bound() const { if (!lock_) return false; Guard guard(lock_); return !token_.isEmpty(); }
  bool previewIdentity(String& server, String& device, String& token) const {
    if (!lock_) return false;
    Guard guard(lock_);
    server = server_; device = device_; token = token_;
    return !token.isEmpty() && !device.isEmpty();
  }
  void setPreviewAvailable(bool available) { if (!lock_) return; Guard guard(lock_); previewAvailable_ = available; }
  void setDetectorAvailable(bool available) { if (!lock_) return; Guard guard(lock_); detectorAvailable_=available; }
  void setObservationGrace(uint32_t ms) { if (!lock_) return; Guard guard(lock_); counts_.policy.grace_ms=constrain(ms,2000U,15000U); }
  poseguard_cloud::Policy policy() const { Guard guard(lock_); return counts_.policy; }
  int lastHttpStatus() const { return lastHttpStatus_.load(); }
  uint32_t lastHeartbeatAgeSeconds() const {
    const auto heartbeat = lastHeartbeat_.load();
    return heartbeat ? (millis() - heartbeat) / 1000 : UINT32_MAX;
  }
  void setHealth(float fps, int people, const String& mode = "running") {
    if (!lock_) return;
    Guard guard(lock_);
    fps_ = fps;
    people_ = people;
    mode_ = mode;
  }
  // risk: 1 phone_to_ear, 2 multi_person, 3 lingering.
  // state: 0 normal, 1 orange candidate, 2 red alert; predicted frames use
  // fresh=false.
  void observe(int track, int risk, int state, bool fresh,
               const uint8_t* croppedJPEG = nullptr, size_t length = 0,
               const std::function<void(const uint8_t*&, size_t&)>& snapshot = {}) {
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
      // Decode/crop/encode evidence only when this observation will be queued.
      if (snapshot) snapshot(croppedJPEG, length);
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
  void resetObservations(const char* reason) {
    if(!lock_)return;
    Guard guard(lock_);
    counts_.reset([&](auto& counter){
      local(counter,reason);
      if(counter.reported){++counter.revision;queue(counter,"resolved");}
    });
  }
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
    const uint32_t now = millis();
    if (!bound() || WiFi.status() != WL_CONNECTED ||
        time(nullptr) < 1704067200 ||
        (retryAt_ && static_cast<int32_t>(now - retryAt_) < 0))
      return;
    const auto heartbeat = lastHeartbeat_.load();
    if (!heartbeat || now - heartbeat >= 30000) {
      JsonDocument request, response;
      {
        Guard guard(lock_);
        request["mode"] = mode_;
        request["fps"] = fps_;
        request["people"] = people_;
        request["outbox_pending"] = pendingCountUnlocked();
        request["capabilities"]["preview"] = previewAvailable_;
        request["capabilities"]["pose_overlay"] = detectorAvailable_;
        request["capabilities"]["camera_orientation"] = previewAvailable_;
#if defined(POSEGUARD_S3_MODEL)
        request["capabilities"]["external_detections"] = false;
#else
        request["capabilities"]["external_detections"] = true;
#endif
      }
      request["firmware"] = "poseguard-esp32s3/1.6.0";
      request["clock_synced"] = true;
      request["capabilities"]["local_evidence"] = true;
      if (!post("/api/device/heartbeat", request, response)) {
        backoff();
        return;
      }
      lastHeartbeat_ = millis();
      failures_ = 0;
      retryAt_ = 0;
      {
        Guard guard(lock_);
        auto rules = response["rules"];
        counts_.policy.threshold = rules["frame_threshold"] | 100;
        queueScanAfter_=0;
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
    if(queueScanAfter_ && int32_t(millis()-queueScanAfter_.load())<0)return;
    String file;
    std::vector<String> candidates;
    uint32_t generation=0,threshold=0;
    {
      Guard guard(lock_);
      generation=queueRevision_.load();threshold=counts_.policy.threshold;
      File directory = LittleFS.open("/outbox");
      File item = directory.openNextFile();
      while (item) {
        String candidate = item.name();
        if(!item.isDirectory()&&candidate.endsWith(".json"))candidates.push_back(candidate);
        item = directory.openNextFile();
      }
    }
    std::sort(candidates.begin(),candidates.end());
    for(const auto& candidate:candidates) {
      File item=LittleFS.open(candidate.startsWith("/")?candidate:"/outbox/"+candidate,"r");
      JsonDocument metadata;
      if(readStoredJson(item,metadata,true)&&(metadata["observed_frames"]|0U)>threshold) {
        file=candidate;break;
      }
    }
    if(file.isEmpty()) {
      Guard guard(lock_);
      queueScanAfter_=queueRevision_.load()==generation?millis()+30000:0;
      return;
    }
    String path = file.startsWith("/") ? file : "/outbox/" + file;
    JsonDocument payload, response;
    File pending=LittleFS.open(path,"r");
    if(!readStoredJson(pending,payload))return;
    pending.close();
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
  SemaphoreHandle_t transportLock_{};
  String server_, token_, device_, session_, mode_{"transport_ready"};
  const char* ca_{};
  float fps_{};
  int people_{};
  bool previewAvailable_{};
  bool detectorAvailable_{};
  std::atomic<uint32_t> lastHeartbeat_{0};
  std::atomic<int> lastHttpStatus_{0};
  std::atomic<uint32_t> queueScanAfter_{0};
  std::atomic<uint32_t> queueRevision_{0};
  uint32_t retryAt_{};
  int failures_{};
  bool readStoredJson(File& file,JsonDocument& output,bool framesOnly=false) const {
    const size_t size=file?file.size():0;
    if(!size||size>512*1024)return false;
    std::unique_ptr<char,decltype(&free)> bytes(static_cast<char*>(malloc(size)),free);
    if(!bytes)return false;
    size_t used=0;
    while(used<size) {
      const size_t count=file.read(reinterpret_cast<uint8_t*>(bytes.get()+used),size-used);
      if(!count)return false;
      used+=count;
    }
    JsonDocument filter;filter["observed_frames"]=true;
    const char* data=bytes.get(); // Read-only input makes JSON strings own their storage.
    const auto error=framesOnly?deserializeJson(output,data,size,DeserializationOption::Filter(filter)):
                                deserializeJson(output,data,size);
    return !error;
  }
  uint32_t pendingCountUnlocked() const {
    uint32_t count=0;
    File directory=LittleFS.open("/outbox");
    for(File file=directory.openNextFile();file;file=directory.openNextFile())
      if(!file.isDirectory()&&String(file.name()).endsWith(".json"))++count;
    return count;
  }
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
    queueRevision_.fetch_add(1);queueScanAfter_=0;
    local(c, type);
    return true;
  }
  bool post(const String& route, JsonDocument& input, JsonDocument& output,
            bool authenticated = true) {
    Guard guard(transportLock_);
    CloudTlsClient tls(ca_);
    tls.setHandshakeTimeout(8);
    tls.setTimeout(12000);
    HTTPClient http;
    http.setConnectTimeout(6500);
    http.setTimeout(12000);
    // New connections also work after a NAT, interface or source IP change.
    http.setReuse(false);
    http.useHTTP10(true);
    if (!http.begin(tls, server_ + route)) {
      lastHttpStatus_ = -100;
      return false;
    }
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    const char* retryHeaders[]={"Retry-After"};
    http.collectHeaders(retryHeaders,1);
    http.addHeader("Content-Type", "application/json");
    http.setUserAgent("PoseGuard/1.3.0");
    if (authenticated) { Guard guard(lock_); http.addHeader("Authorization", "Bearer " + token_); }
    String text;
    serializeJson(input, text);
    int status = http.POST(text);
    tls.noteHttpResult(status);
    char tlsError[96]{};
    const int tlsCode = min(0, tls.lastError(tlsError, sizeof tlsError));
    Serial.printf("cloud_http=%d cloud_ip=%s tls_error=%d\n", status,
                  tls.connectedAddress().toString().c_str(), tlsCode);
    if (status <= 0) Serial.printf("cloud_transport_error=%s\n", tlsError);
    lastHttpStatus_ = status;
    if(status==503) {
      const long seconds=http.header("Retry-After").toInt();
      if(seconds>0)retryAt_=millis()+std::min(300L,seconds)*1000;
    }
    if (status >= 200 && status < 300) {
      const bool error = !readBoundedHttpJson(http, output, 12000);
      if (!error && output["network"]["host"].is<const char*>()) {
        const String host = server_.substring(8);
        if (output["network"]["host"] == host) {
          std::vector<IPAddress> addresses;
          const JsonArray candidates = output["network"]["addresses"].as<JsonArray>();
          for (JsonVariant value : candidates) {
            if (!value.is<const char*>()) continue;
            IPAddress ip; if (ip.fromString(value.as<const char*>())) addresses.push_back(ip);
          }
          CloudTlsClient::setRouteHints(host, addresses, output["network"]["expires_unix"] | uint64_t(0));
        }
      }
      if (error) {
        http.setReuse(false);
        tls.noteHttpResult(-101);
        lastHttpStatus_ = -101;
      }
      http.end();
      return !error;
    }
    http.setReuse(false);
    http.end();
    return false;
  }
  void backoff() {
    failures_ = min(4, failures_ + 1);
    const uint32_t candidate=millis()+(1000UL<<failures_);
    if(!retryAt_ || int32_t(candidate-retryAt_)>0)retryAt_=candidate;
  }
};
