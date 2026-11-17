#pragma once
#include <mbedtls/sha256.h>
#include <sys/time.h>

#include <atomic>

#include "NativePreviewSocket.h"
#include "S3Pose.h"
#include "FrameWindow.h"

// Capture/preview and inference have separate schedules. Only a result packet
// carries the exact original JPEG used by that inference. Raw packets carry
// recent status but no stale skeleton coordinates.
class SenseCameraPreview {
 public:
  void begin(PoseGuardCloud& cloud, const char* ca) {
    cloud_ = &cloud;
    ca_ = ca;
    cameraLock_ = xSemaphoreCreateMutex();
    modelLock_ = xSemaphoreCreateMutex();
    resultLock_ = xSemaphoreCreateMutex();
    model_.uploadBuffer(3500000);
    Preferences saved;
    if (saved.begin("pg-camera", true)) {
      const String rotation = saved.getString("rotation", "auto");
      rotation_ = rotation == "auto" ? -1 : rotation.toInt();
      mirror_ = saved.getBool("mirror", false);
      version_ = saved.getUInt("version", 0);
      saved.end();
    }
    cloud.setPreviewAvailable(true);
    cloud.setObservationGrace(6000);
    xTaskCreatePinnedToCore(captureTask, "pg-capture", 4096, this, 2, nullptr,
                            0);
    xTaskCreatePinnedToCore(inferenceTask, "pg-infer", 16384, this, 1, nullptr,
                            1);
    xTaskCreatePinnedToCore(previewTask, "pg-preview", 14336, this, 3, nullptr,
                            0);
  }
  void printStatus() {
    Serial.printf(
        "s3_model=%d camera=%d captured_frames=%lu inference_frames=%lu "
        "preview_frames=%lu "
        "preview_bytes=%llu inference_ms=%.1f processing_ms=%.1f heap_free=%u "
        "heap_min=%u psram_free=%u test_mode=%d simd_internal_largest=%u benchmark_mode=%d\n",
        modelReady_.load(), cameraReady_.load(),
        static_cast<unsigned long>(captureId_.load()),
        static_cast<unsigned long>(inferences_.load()),
        static_cast<unsigned long>(previewFrames_.load()),
        static_cast<unsigned long long>(previewBytes_.load()),
        inferenceMs_.load(), processingMs_.load(), ESP.getFreeHeap(),
        ESP.getMinFreeHeap(), ESP.getFreePsram(), testMode_.load(),
        heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_SIMD),benchmarkMode_.load());
  }
  bool command(const String& line) {
    if (line == "BENCH_BEGIN" || line == "BENCH_END") {
      testMode_=true;
      take(modelLock_);
      if(!modelReady_){give(modelLock_);Serial.println("PG_BENCH_ERROR model_not_ready");return true;}
      cloud_->resetObservations("camera_benchmark");
      model_.resetTimeline();
      benchmarkMode_=line=="BENCH_BEGIN";
      testMode_=!benchmarkMode_;
      cloud_->setHealth(0,0,benchmarkMode_?"camera_benchmark":"video_test_paused");
      give(modelLock_);
      Serial.println(benchmarkMode_?"PG_BENCH_READY":"PG_BENCH_PAUSED");return true;
    }
    if (line.startsWith("PREPROCESS_LIMIT ")) {
      const unsigned limit=line.substring(17).toInt();
      if(limit!=0&&limit!=128&&limit!=256&&limit!=384&&limit!=640) {
        Serial.println("PG_PREPROCESS_ERROR invalid_limit");return true;
      }
      testMode_=true;
      take(modelLock_);
      benchmarkMode_=false;
      cloud_->resetObservations("preprocess_test_started");
      model_.preprocessLimit(limit);
      give(modelLock_);
      Serial.printf("PG_PREPROCESS_LIMIT %u\n",limit);return true;
    }
    if (line == "MODEL_PROFILE") {
      if (!testMode_) { Serial.println("PG_PROFILE_ERROR test_mode_required"); return true; }
      take(modelLock_);
      model_.profile();
      give(modelLock_);
      Serial.println("PG_PROFILE_END single_core_module_profile");
      return true;
    }
    if (line == "PREVIEW_DIAGNOSTIC") {
      captureDiagnostic_ = true;
      Serial.println("PG_DIAGNOSTIC_ARMED");
      return true;
    }
    if (line == "FS_INFO") {
      JsonDocument doc;
      doc["total_bytes"] = LittleFS.totalBytes();
      doc["used_bytes"] = LittleFS.usedBytes();
      File file = LittleFS.open("/pose-s3.espdl", "r");
      doc["saved_model_bytes"] = file ? file.size() : 0;
      if (file) {
        mbedtls_sha256_context hash;
        mbedtls_sha256_init(&hash);
        mbedtls_sha256_starts(&hash, 0);
        uint8_t block[1024];
        while (file.available()) {
          size_t length = file.read(block, sizeof(block));
          if (!length) break;
          mbedtls_sha256_update(&hash, block, length);
        }
        uint8_t digest[32];
        mbedtls_sha256_finish(&hash, digest);
        mbedtls_sha256_free(&hash);
        char hex[65];
        for (int i = 0; i < 32; ++i) sprintf(hex + 2 * i, "%02x", digest[i]);
        hex[64] = 0;
        doc["saved_model_sha256"] = hex;
      }
      String body;
      serializeJson(doc, body);
      Serial.println("PG_FS " + body);
      return true;
    }
    if (line == "TEST_INDEX" || line.startsWith("TEST_INDEX ")) {
      const String session = line.length() > 10 ? line.substring(11) : "";
      bool valid = session.length() < 20;
      for (char c : session) valid &= c >= '0' && c <= '9';
      if (!valid) {
        Serial.println("PG_FILE_ERROR session");
        return true;
      }
      File directory =
          LittleFS.open(session.length() ? "/tests/" + session : "/tests");
      JsonDocument doc;
      auto items = doc["items"].to<JsonArray>();
      if (directory)
        for (File file = directory.openNextFile(); file && items.size() < 40;
             file = directory.openNextFile()) {
          auto item = items.add<JsonObject>();
          item["path"] = file.path();
          item["bytes"] = file.size();
          item["directory"] = file.isDirectory();
        }
      String body;
      serializeJson(doc, body);
      Serial.println("PG_INDEX " + body);
      return true;
    }
    if (line.startsWith("TEST_READ ")) {
      char name[100]{};
      unsigned offset = 0;
      if (sscanf(line.c_str(), "TEST_READ %99s %u", name, &offset) != 2 ||
          !String(name).startsWith("/tests/") ||
          String(name).indexOf("..") >= 0) {
        Serial.println("PG_FILE_ERROR path");
        return true;
      }
      File file = LittleFS.open(name, "r");
      if (!file || offset > file.size()) {
        Serial.println("PG_FILE_ERROR missing");
        return true;
      }
      file.seek(offset);
      uint8_t bytes[768];
      const size_t count = file.read(bytes, sizeof(bytes));
      char encoded[1025];
      size_t written = 0;
      mbedtls_base64_encode(reinterpret_cast<uint8_t*>(encoded),
                            sizeof(encoded), &written, bytes, count);
      encoded[written] = 0;
      uint8_t digest[32];
      mbedtls_sha256(bytes, count, digest, 0);
      char hex[65];
      for (int i = 0; i < 32; ++i) sprintf(hex + 2 * i, "%02x", digest[i]);
      hex[64] = 0;
      JsonDocument doc;
      doc["offset"] = offset;
      doc["total"] = file.size();
      doc["data"] = encoded;
      doc["sha256"] = hex;
      String body;
      serializeJson(doc, body);
      Serial.println("PG_FILE " + body);
      return true;
    }
    if (line.startsWith("MODEL_OPTIONS ")) {
      int dual = 0; unsigned bytes = 0;
      if (sscanf(line.c_str(), "MODEL_OPTIONS %d %u", &dual, &bytes) != 2 ||
          (dual != 0 && dual != 1) || bytes > 98304) {
        Serial.println("PG_MODEL_OPTIONS_ERROR"); return true;
      }
      testMode_ = true;
      take(modelLock_);
      benchmarkMode_=false;
      cloud_->resetObservations("local_model_profile_test");
      model_.runtimeOptions(dual == 1, bytes);
      give(modelLock_);
      Serial.printf("PG_MODEL_OPTIONS %d %u\n", dual, bytes);
      return true;
    }
    if (line.startsWith("TEST_POLICY ")) {
      unsigned threshold = 0, escalation = 0;
      if (!testMode_ ||
          sscanf(line.c_str(), "TEST_POLICY %u %u", &threshold, &escalation) !=
              2 ||
          threshold < 1 || escalation <= threshold) {
        Serial.println("PG_TEST_ERROR policy");
        return true;
      }
      testCounts_.policy.threshold = threshold;
      testCounts_.policy.escalation = escalation;
      Serial.printf("PG_TEST_POLICY %u %u\n", threshold, escalation);
      return true;
    }
    if (line == "TEST_BEGIN") {
      testMode_ = true;
      take(modelLock_);
      benchmarkMode_=false;
      cloud_->resetObservations("local_test_started");
      cloud_->setHealth(0, 0, "video_test");
      model_.resetTimeline();
      testCounts_ = {};
      testCounts_.policy = cloud_->policy();
      testSession_ = String(millis());
      LittleFS.mkdir("/tests");
      LittleFS.mkdir("/tests/" + testSession_);
      give(modelLock_);
      Serial.println("PG_TEST_READY " + testSession_);
      return true;
    }
    if (line == "TEST_END" || line == "TEST_PAUSE") {
      testMode_=true;
      take(modelLock_);
      benchmarkMode_=false;
      testCounts_.reset([&](const auto& counter) {
        testRecord(counter, "test_stopped", lastTestMs_);
      });
      model_.resetTimeline();
      testMode_ = line == "TEST_PAUSE";
      give(modelLock_);
      if (testMode_) cloud_->setHealth(0, 0, "video_test_paused");
      Serial.println(testMode_ ? "PG_TEST_PAUSED" : "PG_TEST_END");
      return true;
    }
    if (line == "MODEL_SAVE" || line == "MODEL_SAVE_REPLACE") {
      testMode_ = true;
      take(modelLock_);
      benchmarkMode_=false;
      const bool ok =
          model_.saveFile("/pose-s3.espdl", line == "MODEL_SAVE_REPLACE");
      give(modelLock_);
      Serial.println(ok ? "PG_MODEL_SAVED"
                        : "PG_MODEL_SAVE_ERROR insufficient_space_or_io");
      return true;
    }
    if (line.startsWith("MODEL_RAM ")) {
      const int split = line.indexOf(' ', 10);
      if (split < 0) {
        Serial.println("PG_MODEL_ERROR header");
        return true;
      }
      const size_t length = line.substring(10, split).toInt();
      const String expected = line.substring(split + 1);
      if (length < 1024 || length > 3500000 || expected.length() != 64) {
        Serial.println("PG_MODEL_ERROR size_or_hash");
        return true;
      }
      testMode_ = true;
      take(modelLock_);
      benchmarkMode_=false;
      modelReady_ = false;
      cloud_->resetObservations("model_changed");
      cloud_->setHealth(0, 0, "model_test");
      cloud_->setDetectorAvailable(false);
      model_.unload();
      take(resultLock_);
      resultFrame_ = {};
      resultJson_ = "";
      resultId_ = 0;
      give(resultLock_);
      auto* buffer = model_.uploadBuffer(length);
      auto* bytes = buffer ? receive(length, buffer) : nullptr;
      bool ok = false;
      if (bytes) {
        uint8_t digest[32];
        mbedtls_sha256(bytes, length, digest, 0);
        char hex[65];
        for (int i = 0; i < 32; ++i) sprintf(hex + 2 * i, "%02x", digest[i]);
        hex[64] = 0;
        if (expected.equalsIgnoreCase(hex)) {
          ok = model_.loadOwned(bytes, length);
          bytes = nullptr;
        } else
          Serial.println("PG_MODEL_ERROR hash_mismatch");
      }
      modelReady_ = ok;
      cloud_->setDetectorAvailable(ok);
      give(modelLock_);
      Serial.println(ok ? "PG_MODEL_LOADED" : "PG_MODEL_ERROR load");
      return true;
    }
    if (line.startsWith("TEST_FRAME ")) {
      size_t length = 0;
      unsigned long long mediaMs = 0;
      int rotation = 0, mirror = 0;
      if (!testMode_ ||
          sscanf(line.c_str(), "TEST_FRAME %u %llu %d %d", &length, &mediaMs,
                 &rotation, &mirror) != 4 ||
          length < 32 || length > 160000 ||
          !(rotation == -1 || rotation == 0 || rotation == 90 ||
            rotation == 180 || rotation == 270)) {
        Serial.println("PG_TEST_ERROR header_or_mode");
        return true;
      }
      auto* bytes = receive(length);
      if (!bytes) {
        Serial.println("PG_TEST_ERROR transfer");
        return true;
      }
      take(modelLock_);
      S3PoseResult result;
      const bool ok = model_.infer(bytes, length, mediaMs / 1000., rotation,
                                   mirror != 0, result);
      JsonDocument report;
      if (ok) {
        model_.metadata(report, result);
        report["is_test"] = true;
        report["media_ms"] = mediaMs;
        report["free_psram"] = ESP.getFreePsram();
        report["min_heap"] = ESP.getMinFreeHeap();
        report["min_psram"] =
            heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM);
        lastTestMs_ = mediaMs;
        auto reports = report["event_updates"].to<JsonArray>();
        testCounts_.expire(mediaMs, [&](const auto& counter) {
          testRecord(counter, "signal_ended", mediaMs);
        });
        for (const auto& risk : result.risks) {
          const auto track = std::find_if(
              result.tracks.begin(), result.tracks.end(),
              [&](const auto& item) { return item.track_id == risk.track_id; });
          if (track == result.tracks.end() || track->predicted ||
              risk.state == poseguard::RiskState::Normal)
            continue;
          auto change = testCounts_.observe(risk.track_id, int(risk.kind),
                                            int(risk.state), mediaMs, true);
          if (change.started || change.report) {
            const char* type =
                change.report ? (change.escalated ? "escalated" : "reported")
                              : "special_state_started";
            testRecord(*change.counter, type, mediaMs);
            auto update = reports.add<JsonObject>();
            update["type"] = type;
            update["count"] = change.counter->count;
            update["risk"] = int(risk.kind);
            update["severity"] = change.counter->severity;
            if (change.started) {
              auto crop = S3PoseModel::crop(bytes, length, risk.bbox,
                                            result.rotation, result.mirror);
              if (crop.bytes) {
                File file = LittleFS.open("/tests/" + testSession_ + "/" +
                                              String(risk.track_id) + "-" +
                                              String(int(risk.kind)) + ".jpg",
                                          "w");
                if (file) file.write(crop.bytes.get(), crop.length);
              }
            }
          }
        }
      }
      give(modelLock_);
      heap_caps_free(bytes);
      if (ok) {
        String body;
        serializeJson(report, body);
        Serial.println("PG_RESULT " + body);
      } else
        Serial.println("PG_TEST_ERROR inference");
      return true;
    }
    return false;
  }

 private:
  struct Frame {
    S3Jpeg jpeg;
    int width{}, height{};
    uint64_t captured{};
    uint32_t id{}, cameraVersion{};
  };
  PoseGuardCloud* cloud_{};
  const char* ca_{};
  S3PoseModel model_;
  SemaphoreHandle_t cameraLock_{}, modelLock_{}, resultLock_{};
  std::atomic<bool> cameraReady_{false};
  std::atomic<bool> benchmarkMode_{false};
  std::atomic<bool> modelReady_{false}, testMode_{false};
  std::atomic<bool> viewing_{false};
  std::atomic<bool> captureDiagnostic_{false};
  std::atomic<int> rotation_{-1}, longSide_{320}, quality_{26};
  std::atomic<bool> mirror_{false};
  std::atomic<uint32_t> version_{};
  std::atomic<uint32_t> captureId_{}, inferences_{}, previewFrames_{};
  std::atomic<uint64_t> previewBytes_{};
  std::atomic<float> inferenceMs_{}, processingMs_{};
  Frame resultFrame_;
  Frame capturedFrame_;
  String resultJson_;
  uint32_t resultId_{};
  poseguard_cloud::Counters testCounts_;
  String testSession_;
  uint64_t lastTestMs_{};
  int previousRotation_{-1};
  bool previousMirror_{};
  static void take(SemaphoreHandle_t lock) {
    xSemaphoreTake(lock, portMAX_DELAY);
  }
  static void give(SemaphoreHandle_t lock) { xSemaphoreGive(lock); }
  static void inferenceTask(void* self) {
    static_cast<SenseCameraPreview*>(self)->detectLoop();
  }
  static void captureTask(void* self) {
    static_cast<SenseCameraPreview*>(self)->captureLoop();
  }
  static void previewTask(void* self) {
    static_cast<SenseCameraPreview*>(self)->previewLoop();
  }
  void testRecord(const poseguard_cloud::Counter& counter, const char* type,
                  uint64_t ms) {
    JsonDocument doc;
    doc["is_test"] = true;
    doc["type"] = type;
    doc["media_ms"] = ms;
    doc["recorded_unix"] = time(nullptr);
    doc["track_id"] = counter.track_id;
    doc["risk"] = counter.risk;
    doc["special_frames"] = counter.count;
    doc["severity"] = counter.severity;
    File file = LittleFS.open("/tests/" + testSession_ + "/events.jsonl", "a");
    if (file) {
      serializeJson(doc, file);
      file.println();
    }
  }
  uint8_t* receive(size_t length, uint8_t* supplied = nullptr) {
    auto* bytes = supplied
                      ? supplied
                      : static_cast<uint8_t*>(heap_caps_aligned_alloc(
                            16, length, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!bytes) {
      Serial.println("PG_RX_ERROR memory");
      return nullptr;
    }
    Serial.printf("PG_RX_READY %u\n", unsigned(length));
    size_t offset = 0;
    uint32_t last = millis();
    while (offset < length && millis() - last < 15000) {
      const size_t chunk = std::min(size_t(1024), length - offset);
      size_t have = 0;
      while (have < chunk && millis() - last < 15000) {
        const size_t n = Serial.read(bytes + offset + have, chunk - have);
        if (n) {
          have += n;
          last = millis();
        } else
          delay(1);
      }
      offset += have;
      Serial.printf("PG_RX %u\n", unsigned(offset));
    }
    if (offset != length) {
      if (!supplied) heap_caps_free(bytes);
      Serial.println("PG_RX_ERROR timeout");
      return nullptr;
    }
    return bytes;
  }
  bool openCamera() {
    camera_config_t c{};
    c.ledc_channel = LEDC_CHANNEL_0;
    c.ledc_timer = LEDC_TIMER_0;
    c.pin_d0 = 15;
    c.pin_d1 = 17;
    c.pin_d2 = 18;
    c.pin_d3 = 16;
    c.pin_d4 = 14;
    c.pin_d5 = 12;
    c.pin_d6 = 11;
    c.pin_d7 = 48;
    c.pin_xclk = 10;
    c.pin_pclk = 13;
    c.pin_vsync = 38;
    c.pin_href = 47;
    c.pin_sccb_sda = 40;
    c.pin_sccb_scl = 39;
    c.pin_pwdn = -1;
    c.pin_reset = -1;
    c.xclk_freq_hz = 20000000;
    c.pixel_format = PIXFORMAT_JPEG;
    c.frame_size = longSide_ > 432 ? FRAMESIZE_VGA : FRAMESIZE_QVGA;
    c.jpeg_quality = quality_;
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
    c.grab_mode = CAMERA_GRAB_LATEST;
    const esp_err_t error = esp_camera_init(&c);
    cameraReady_ = error == ESP_OK;
    Serial.printf("s3_camera_init=0x%x psram_free=%u\n", error,
                  ESP.getFreePsram());
    return cameraReady_;
  }
  Frame grab() {
    Frame frame;
    take(cameraLock_);
    if (!cameraReady_ && !openCamera()) {
      give(cameraLock_);
      return frame;
    }
    camera_fb_t* source = esp_camera_fb_get();
    if (source) {
      auto* bytes = static_cast<uint8_t*>(
          heap_caps_malloc(source->len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      if (bytes) {
        memcpy(bytes, source->buf, source->len);
        frame.jpeg = {std::shared_ptr<uint8_t>(
                          bytes, [](uint8_t* p) { heap_caps_free(p); }),
                      source->len};
        frame.width = source->width;
        frame.height = source->height;
        frame.captured = esp_timer_get_time() / 1000;
        frame.id = ++captureId_;
      }
      esp_camera_fb_return(source);
    }
    give(cameraLock_);
    return frame;
  }
  void detectLoop() {
    take(modelLock_);
    modelReady_ = model_.loadFile();
    if (!modelReady_) cloud_->setHealth(0, 0, "fault");
    cloud_->setDetectorAvailable(modelReady_);
    give(modelLock_);
    uint32_t previousCapture = 0;
    uint32_t previousCameraVersion=UINT32_MAX;
    uint64_t previousResultUs = 0;
    while (true) {
      if (testMode_ || !modelReady_) {
        previousResultUs = 0;
        vTaskDelay(pdMS_TO_TICKS(100));
        continue;
      }
      take(resultLock_);
      Frame frame = capturedFrame_;
      give(resultLock_);
      if (!frame.jpeg.bytes || frame.id == previousCapture) {
        vTaskDelay(pdMS_TO_TICKS(5));
        continue;
      }
      take(modelLock_);
      if (testMode_) {
        give(modelLock_);
        continue;
      }
      previousCapture = frame.id;
      S3PoseResult result;
      take(resultLock_);
      const int requestedRotation = rotation_.load();
      const bool requestedMirror = mirror_.load();
      frame.cameraVersion = version_.load();
      give(resultLock_);
      if(frame.cameraVersion!=previousCameraVersion) {
        model_.resetTimeline();
        cloud_->resetObservations("camera_config_changed");
        previousRotation_=-1;
        previousCameraVersion=frame.cameraVersion;
      }
      const bool ok = model_.infer(frame.jpeg.bytes.get(), frame.jpeg.length,
                                   frame.captured / 1000., requestedRotation,
                                   requestedMirror, result);
      if (ok) {
        inferenceMs_ = result.inferenceMs;
        if (previousRotation_ >= 0 && (previousRotation_ != result.rotation ||
                                       previousMirror_ != result.mirror))
          cloud_->resetObservations("camera_orientation_changed");
        previousRotation_ = result.rotation;
        previousMirror_ = result.mirror;
        processingMs_ = result.processingMs;
        ++inferences_;
        int people = 0;
        for (const auto& track : result.tracks) people += !track.predicted&&track.confirmed;
        const uint64_t finishedUs = esp_timer_get_time();
        const float liveFps = previousResultUs
                                  ? 1000000.f / (finishedUs - previousResultUs)
                                  : 1000.f / std::max(1.f, result.processingMs);
        previousResultUs = finishedUs;
        cloud_->setHealth(liveFps, people,benchmarkMode_?"camera_benchmark":
            result.imageQuality.usable()?"running":result.imageQuality.name());
        for (const auto& track : result.tracks) {
          if (benchmarkMode_) continue;
          if (track.predicted) continue;
          S3Jpeg crop;
          for (const auto& risk : result.risks)
            if (risk.track_id == track.track_id &&
                risk.state != poseguard::RiskState::Normal) {
              cloud_->observe(track.track_id, int(risk.kind), int(risk.state),
                              true, nullptr, 0, [&](const uint8_t*& bytes, size_t& length) {
                                if (!crop.bytes)
                                  crop = S3PoseModel::crop(frame.jpeg.bytes.get(),
                                          frame.jpeg.length, track.bbox,
                                          result.rotation, result.mirror);
                                bytes = crop.bytes.get();
                                length = crop.length;
                              });
            }
        }
        JsonDocument metadata;
        model_.metadata(metadata, result);
        metadata["is_test"] = benchmarkMode_.load();
        metadata["inference_fps"] = liveFps;
        metadata["orientation_mode"] =
            requestedRotation < 0 ? "auto" : String(requestedRotation);
        String json;
        serializeJson(metadata, json);
        take(resultLock_);
        resultFrame_ = frame;
        resultJson_ = json;
        ++resultId_;
        give(resultLock_);
      } else
        cloud_->setHealth(0, 0, "inference_error");
      give(modelLock_);
      vTaskDelay(pdMS_TO_TICKS(1));
    }
  }
  void text(NativePreviewSocket& ws, const JsonDocument& value) {
    String body;
    serializeJson(value, body);
    ws.send(body);
  }
  bool packet(NativePreviewSocket& ws, const Frame& frame, JsonDocument& meta,
              uint32_t& sequence, const String& epoch) {
    if (!frame.jpeg.bytes) return false;
    meta["sequence"] = ++sequence;
    meta["source_epoch"] = epoch;
    meta["codec"] = "jpeg";
    meta["keyframe"] = true;
    meta["width"] = frame.width;
    meta["height"] = frame.height;
    timeval wall{};gettimeofday(&wall,nullptr);
    meta["captured_ms"] = uint64_t(wall.tv_sec)*1000+wall.tv_usec/1000 -
                          (esp_timer_get_time() / 1000 - frame.captured);
    meta["camera_applied_version"] = frame.cameraVersion;
    if (!meta["orientation_mode"].is<const char*>())
      meta["orientation_mode"] =
          rotation_ < 0 ? "auto" : String(rotation_.load());
    meta["source_type"] = "camera";
    meta["jpeg_quality"] = quality_.load();
    meta["capture_id"] = frame.id;
    String json;
    serializeJson(meta, json);
    const size_t length = 8 + json.length() + frame.jpeg.length;
    if (length > 600 * 1024) return false;
    auto* bytes = static_cast<uint8_t*>(
        heap_caps_malloc(length, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!bytes) return false;
    memcpy(bytes, "PGV1", 4);
    const uint32_t n = json.length();
    bytes[4] = n >> 24;
    bytes[5] = n >> 16;
    bytes[6] = n >> 8;
    bytes[7] = n;
    memcpy(bytes + 8, json.c_str(), n);
    memcpy(bytes + 8 + n, frame.jpeg.bytes.get(), frame.jpeg.length);
    if (captureDiagnostic_.exchange(false)) {
      LittleFS.mkdir("/tests");
      File diagnostic = LittleFS.open("/tests/preview-wire.pgv", "w");
      if (diagnostic) diagnostic.write(bytes, length);
    }
    const bool sent = ws.sendBinary(reinterpret_cast<const char*>(bytes), length);
    if (sent) {
      ++previewFrames_;
      previewBytes_ += length;
    }
    heap_caps_free(bytes);
    return sent;
  }
  void previewLoop() {
    unsigned failures = 0;
    for (;;) {
      viewing_ = false;
      String server, device, token;
      if (WiFi.status() != WL_CONNECTED || time(nullptr) < 1704067200 ||
          !cloud_->previewIdentity(server, device, token)) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        continue;
      }
      const String host = server.substring(8);
      if (!server.startsWith("https://") || host.indexOf('/') >= 0 ||
          host.indexOf(':') >= 0) {
        vTaskDelay(pdMS_TO_TICKS(10000));
        continue;
      }
      NativePreviewSocket ws;
      uint32_t lease = 0;
      int fps = 6;
      bool wantRaw = true, wantPose = true;
      const String epoch = String(esp_random(), HEX) + "_" + String(millis());
      uint32_t sequence = 0;
      uint32_t lastApplied=UINT32_MAX;
      poseguard_preview::FrameWindow inFlight;
      bool preferPose = true;
      ws.onMessage([&](const String& message) {
        if (message.length() > 8192) return;
        JsonDocument doc;
        if (deserializeJson(doc, message)) return;
        if (doc["type"] == "frame_ack") {
          if (doc["epoch"] == epoch)inFlight.acknowledge(doc["sequence"] | 0U);
          return;
        }
        if (doc["type"] != "control") return;
        lease = doc["active"] == true
                    ? millis() + constrain(doc["lease_ms"] | 8000, 0, 10000)
                    : 0;
        viewing_ = doc["active"] == true;
        const bool nextRaw=doc["want_raw"] | true,nextPose=doc["want_pose"] | true;
        const int nextFps=constrain(doc["fps"] | 6,1,20);
        if(nextRaw!=wantRaw||nextPose!=wantPose||nextFps!=fps)
          Serial.printf("s3_preview_control fps=%d raw=%d pose=%d window=%u viewers=%u\n",
              nextFps,nextRaw,nextPose,unsigned(doc["source_window"]|1U),unsigned(doc["viewers"]|0U));
        wantRaw=nextRaw;wantPose=nextPose;fps=nextFps;
        inFlight.limit(doc["source_window"] | 1U);
        const String profile = doc["profile"] | "balanced";
        const int side = profile == "clear" ? 640 : 320,
                  quality = profile == "clear" ? 14
                            : profile == "low" ? 32
                                               : 26;
        if (doc["active"] == true &&
            (side != longSide_ || quality != quality_)) {
          take(cameraLock_);
          if (cameraReady_) {
            esp_camera_deinit();
            cameraReady_ = false;
          }
          longSide_ = side;
          quality_ = quality;
          give(cameraLock_);
        }
        const String rotation = doc["camera"]["rotation"] | "auto";
        if (rotation != "auto" && rotation != "0" && rotation != "90" &&
            rotation != "180" && rotation != "270")
          return;
        const uint32_t version = doc["camera"]["version"] | 0U;
        const int angle = rotation == "auto" ? -1 : rotation.toInt();
        const bool mirror = doc["camera"]["mirror"] == true;
        if (version != version_ || angle != rotation_ || mirror != mirror_) {
          take(resultLock_);
          rotation_ = angle;
          mirror_ = mirror;
          version_ = version;
          give(resultLock_);
          Preferences saved;
          if (saved.begin("pg-camera", false)) {
            saved.putString("rotation", rotation);
            saved.putBool("mirror", mirror);
            saved.putUInt("version", version);
            saved.end();
          }
        }
        if (!modelReady_ && lastApplied!=version_.load()) {
          JsonDocument applied;
          applied["type"] = "applied";
          applied["version"] = version_.load();
          text(ws, applied);
          lastApplied=version_.load();
        }
      });
      if (!ws.connect("wss://" + host + "/api/device/preview/connect", token,
                      ca_)) {
        vTaskDelay(pdMS_TO_TICKS(std::min(30000U, 2000U * ++failures)));
        continue;
      }
      failures = 0;
      Serial.println("s3_preview=connected");
      JsonDocument hello;
      hello["type"] = "hello";
      hello["codecs"].to<JsonArray>().add("jpeg");
      hello["pose"] = modelReady_.load();
      hello["camera"] = true;
      hello["frame_ack"] = true;
      hello["max_inflight_frames"] = poseguard_preview::FrameWindow::capacity;
      hello["low_resource"] = true;
      text(ws, hello);
      uint32_t lastPose = 0, lastRaw = 0, next = 0, nextPose = 0,
               ping = millis();
      while (ws.available() && WiFi.status() == WL_CONNECTED) {
        ws.poll();
        const uint32_t now = millis();
        if (inFlight.expired(now)) {
            Serial.println("s3_preview_ack=timeout");
            ws.preferHttp();
            break;
        }
        if (!inFlight.available()) {
          vTaskDelay(pdMS_TO_TICKS(5));
          continue;
        }
        if (lease && static_cast<int32_t>(lease - now) > 0) {
          take(resultLock_);
          const uint32_t current = resultId_;
          const bool poseDue=wantPose&&(!wantRaw||preferPose)&&(!nextPose||static_cast<int32_t>(now-nextPose)>=0)&&current!=lastPose&&resultFrame_.jpeg.bytes&&!testMode_;
          const bool rawDue=(wantRaw||!modelReady_||testMode_)&&(!next||static_cast<int32_t>(now-next)>=0);
          if(!poseDue&&!rawDue) {
            give(resultLock_);vTaskDelay(pdMS_TO_TICKS(5));continue;
          }
          Frame processed = resultFrame_;
          String metadata = resultJson_;
          give(resultLock_);
          if (poseDue) {
            JsonDocument meta;
            if (!deserializeJson(meta, metadata)) {
              meta["frame_role"] = "pose";
              if (packet(ws, processed, meta, sequence, epoch)) {
                inFlight.add(sequence,millis());
                nextPose=millis()+std::max(0,1000/fps-int(millis()-now));
                preferPose = false;
              }
              if(lastApplied!=processed.cameraVersion) {
                JsonDocument applied;
                applied["type"] = "applied";
                applied["version"] = processed.cameraVersion;
                text(ws, applied);lastApplied=processed.cameraVersion;
              }
              lastPose = current;
            }
          }
          if (inFlight.available() && rawDue) {
            take(resultLock_);
            Frame raw = capturedFrame_;
            give(resultLock_);
            if (!raw.jpeg.bytes || raw.id == lastRaw) {
              vTaskDelay(pdMS_TO_TICKS(5));
              continue;
            }
            lastRaw = raw.id;
            raw.cameraVersion = modelReady_ && !testMode_
                                    ? processed.cameraVersion
                                    : version_.load();
            JsonDocument meta;
            if (metadata.length()) deserializeJson(meta, metadata);
            meta["frame_role"] = "raw";
            meta["detector_ready"] = modelReady_.load() && !testMode_;
            meta["detector_present"] = true;
            meta["detector_paused"] = testMode_.load();
            meta["tracks"].to<JsonArray>();
            if(!meta["detector_ready"].as<bool>()) {
              meta["inference_fps"]=0;
              meta["people"]=0;
              meta["risks"].to<JsonArray>();
            }
            if (!meta["risks"].is<JsonArray>()) meta["risks"].to<JsonArray>();
            if (!meta["inference_fps"].is<float>()) meta["inference_fps"] = 0;
            if (rotation_ >= 0) {
              meta["display_rotation"] = rotation_.load();
              meta["display_mirror"] = mirror_.load();
            }
            meta["status_age_ms"] =
                processed.jpeg.bytes
                    ? esp_timer_get_time() / 1000 - processed.captured
                    : 0;
            if (packet(ws, raw, meta, sequence, epoch)) {
              inFlight.add(sequence,millis());
              preferPose = true;
            }
            next = millis() + std::max(0, 1000 / fps - int(millis() - now));
          }
        }
        if (!lease || static_cast<int32_t>(lease - now) <= 0) viewing_ = false;
        if (now - ping > 25000) {
          ws.ping();
          ping = now;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
      }
      ws.close();
      vTaskDelay(pdMS_TO_TICKS(2000));
    }
  }
  void captureLoop() {
    for (;;) {
      if ((!modelReady_ || testMode_) && !viewing_) {
        take(cameraLock_);
        if (cameraReady_) {
          esp_camera_deinit();
          cameraReady_ = false;
        }
        give(cameraLock_);
        take(resultLock_);
        capturedFrame_ = {};
        give(resultLock_);
        vTaskDelay(pdMS_TO_TICKS(100));
        continue;
      }
      const uint32_t started = millis();
      Frame frame = grab();
      if (frame.jpeg.bytes) {
        take(resultLock_);
        capturedFrame_ = frame;
        give(resultLock_);
      } else {
        cloud_->setHealth(0, 0, "camera_error");
        vTaskDelay(pdMS_TO_TICKS(1000));
      }
      vTaskDelay(pdMS_TO_TICKS(std::max(1, 50 - int(millis() - started))));
    }
  }
};
