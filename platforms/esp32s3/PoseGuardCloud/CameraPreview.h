#pragma once

// Only the XIAO ESP32-S3 Sense pin map is enabled by this build option.
#if defined(POSEGUARD_CAMERA_XIAO)
#include <ArduinoWebsockets.h>
#include <esp_camera.h>
#include <esp_heap_caps.h>
#include <memory>

#include "CloudTlsClient.h"
#include "PoseGuardCloud.h"

class PreviewTlsTransport : public websockets::network::TcpClient {
 public:
  explicit PreviewTlsTransport(const char* ca) : tls_(ca) {}
  bool connect(const websockets::WSString& host, int port) override {
    tls_.setTimeout(2500);
    tls_.setHandshakeTimeout(8);
    return tls_.connect(host.c_str(), port, 3500) == 1;
  }
  bool poll() override { return tls_.available() > 0; }
  bool available() override { return tls_.connected(); }
  void close() override { tls_.stop(); }
  void send(const websockets::WSString& data) override {
    send(reinterpret_cast<const uint8_t*>(data.data()), data.size());
  }
  void send(const websockets::WSString&& data) override { send(data); }
  void send(const uint8_t* data, uint32_t length) override {
    uint32_t offset = 0;
    const uint32_t start = millis();
    while (offset < length && tls_.connected() && millis() - start < 2500) {
      const size_t n = tls_.write(data + offset, length - offset);
      if (!n) break;
      offset += n;
      taskYIELD();
    }
    if (offset != length) close();
  }
  websockets::WSString readLine() override {
    websockets::WSString line;
    const uint32_t start = millis();
    while (available() && millis() - start < 3500 && line.size() < 2048) {
      const int ch = tls_.read();
      if (ch >= 0) { line += static_cast<char>(ch); if (ch == '\n') break; }
      else vTaskDelay(1);
    }
    return line;
  }
  uint32_t read(uint8_t* buffer, uint32_t length) override {
    const int n = tls_.read(buffer, length);
    return n > 0 ? n : 0;
  }
 protected:
  int getSocket() const override { return -1; }
 private:
  CloudTlsClient tls_;
};

class SenseCameraPreview {
 public:
  void begin(PoseGuardCloud& cloud, const char* ca) {
    cloud_ = &cloud;
    ca_ = ca;
    cloud.setPreviewAvailable(true);
    xTaskCreate(task, "pg-preview", 14336, this, 1, nullptr);
  }
 private:
  PoseGuardCloud* cloud_{};
  const char* ca_{};
  bool cameraReady_{};
  uint32_t leaseUntil_{}, nextFrame_{}, pingAt_{};
  int fps_{3}, longSide_{320}, quality_{20};
  String rotation_{"auto"}, epoch_;
  bool mirror_{};
  uint32_t version_{}, sequence_{};

  static void task(void* value) { static_cast<SenseCameraPreview*>(value)->run(); }
  void stopCamera() {
    if (cameraReady_) { esp_camera_deinit(); cameraReady_ = false; Serial.println("preview_camera=idle"); }
  }
  bool openCamera() {
    camera_config_t c{};
    c.ledc_channel=LEDC_CHANNEL_0; c.ledc_timer=LEDC_TIMER_0;
    c.pin_d0=15; c.pin_d1=17; c.pin_d2=18; c.pin_d3=16;
    c.pin_d4=14; c.pin_d5=12; c.pin_d6=11; c.pin_d7=48;
    c.pin_xclk=10; c.pin_pclk=13; c.pin_vsync=38; c.pin_href=47;
    c.pin_sccb_sda=40; c.pin_sccb_scl=39; c.pin_pwdn=-1; c.pin_reset=-1;
    c.xclk_freq_hz=10000000; c.pixel_format=PIXFORMAT_JPEG;
    c.frame_size=longSide_>432 ? FRAMESIZE_VGA : FRAMESIZE_QVGA;
    c.jpeg_quality=quality_; c.fb_count=2;
    c.fb_location=CAMERA_FB_IN_PSRAM; c.grab_mode=CAMERA_GRAB_LATEST;
    const esp_err_t result=esp_camera_init(&c);
    cameraReady_=result==ESP_OK;
    Serial.printf("preview_camera_init=0x%x psram_free=%u\n", result, ESP.getFreePsram());
    return cameraReady_;
  }
  void text(websockets::WebsocketsClient& ws, const JsonDocument& value) {
    String body; serializeJson(value, body); ws.send(body);
  }
  void control(websockets::WebsocketsClient& ws, const String& body) {
    if (body.length()>8192) { ws.close(); return; }
    JsonDocument doc;
    if (deserializeJson(doc, body) || doc["type"] != "control") return;
    const String profile=doc["profile"] | "balanced";
    const int nextSide=profile=="clear" ? 640 : 320;
    const int nextQuality=profile=="clear" ? 14 : profile=="low" ? 26 : 20;
    if ((nextSide>432)!=(longSide_>432) || nextQuality!=quality_) stopCamera();
    longSide_=nextSide; quality_=nextQuality;
    fps_=constrain(doc["fps"] | 3,1,3);
    leaseUntil_=doc["active"] == true ? millis()+constrain(doc["lease_ms"] | 8000,0,10000) : 0;
    const String nextRotation=doc["camera"]["rotation"] | "auto";
    if (nextRotation!="auto" && nextRotation!="0" && nextRotation!="90" && nextRotation!="180" && nextRotation!="270") return;
    const uint32_t nextVersion=doc["camera"]["version"] | 0U;
    const bool nextMirror=doc["camera"]["mirror"] == true;
    if (nextVersion!=version_ || nextRotation!=rotation_ || nextMirror!=mirror_) {
      rotation_=nextRotation; mirror_=nextMirror; version_=nextVersion;
      Preferences saved;
      if (saved.begin("pg-camera",false)) {
        saved.putString("rotation",rotation_); saved.putBool("mirror",mirror_); saved.putUInt("version",version_); saved.end();
      }
    }
    JsonDocument applied; applied["type"]="applied"; applied["version"]=version_; text(ws,applied);
  }
  void frame(websockets::WebsocketsClient& ws) {
    if (!cameraReady_ && !openCamera()) {
      JsonDocument status; status["type"]="status"; status["state"]="camera_error";
      status["message"]="XIAO Sense camera initialization failed"; text(ws,status);
      nextFrame_=millis()+5000; return;
    }
    camera_fb_t* f=esp_camera_fb_get();
    if (!f) { nextFrame_=millis()+1000; return; }
    JsonDocument meta;
    meta["sequence"]=++sequence_; meta["source_epoch"]=epoch_;
    meta["codec"]="jpeg"; meta["keyframe"]=true;
    meta["width"]=f->width; meta["height"]=f->height;
    meta["captured_ms"]=static_cast<uint64_t>(time(nullptr))*1000;
    meta["inference_fps"]=0; meta["detector_ready"]=false;
    meta["source_type"]="camera"; meta["people"]=0;
    meta["camera_applied_version"]=version_;
    meta["orientation"]=rotation_=="auto" ? 0 : rotation_.toInt();
    meta["display_rotation"]=rotation_=="auto" ? 0 : rotation_.toInt();
    meta["display_mirror"]=mirror_;
    meta["orientation_mode"]=rotation_; meta["orientation_available"]=false;
    meta["tracks"].to<JsonArray>(); meta["risks"].to<JsonArray>();
    String json; serializeJson(meta,json);
    const size_t length=8+json.length()+f->len;
    uint8_t* packet=length<=600*1024 ? static_cast<uint8_t*>(heap_caps_malloc(length,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT)) : nullptr;
    if (packet) {
      memcpy(packet,"PGV1",4); const uint32_t n=json.length();
      packet[4]=n>>24; packet[5]=n>>16; packet[6]=n>>8; packet[7]=n;
      memcpy(packet+8,json.c_str(),n); memcpy(packet+8+n,f->buf,f->len);
      ws.sendBinary(reinterpret_cast<const char*>(packet),length); heap_caps_free(packet);
    }
    esp_camera_fb_return(f);
    nextFrame_=millis()+1000/fps_;
  }
  void run() {
    Preferences saved;
    if (saved.begin("pg-camera",true)) {
      rotation_=saved.getString("rotation","auto"); mirror_=saved.getBool("mirror",false); version_=saved.getUInt("version",0); saved.end();
    }
    unsigned failures=0;
    for (;;) {
      String server,device,token;
      if (WiFi.status()!=WL_CONNECTED || time(nullptr)<1704067200 || !cloud_->previewIdentity(server,device,token)) { stopCamera(); vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
      if (!server.startsWith("https://")) { vTaskDelay(pdMS_TO_TICKS(10000)); continue; }
      const String host=server.substring(8);
      if (host.indexOf('/')>=0 || host.indexOf(':')>=0) { vTaskDelay(pdMS_TO_TICKS(10000)); continue; }
      auto transport=std::make_shared<PreviewTlsTransport>(ca_);
      websockets::WebsocketsClient ws(transport);
      ws.addHeader("Authorization", "Bearer "+token);
      ws.onMessage([&](websockets::WebsocketsMessage message) { if (message.isText()) control(ws,message.data()); });
      if (!ws.connect(host,443,"/api/device/preview/connect")) {
        stopCamera(); Serial.println("preview_wss=retry");
        vTaskDelay(pdMS_TO_TICKS(std::min(30000U,2000U*(++failures)))); continue;
      }
      failures=0; leaseUntil_=0; pingAt_=millis();
      epoch_=String(esp_random(),HEX)+"_"+String(millis());
      JsonDocument hello; hello["type"]="hello"; hello["codecs"].to<JsonArray>().add("jpeg"); hello["pose"]=false; hello["camera"]=true; text(ws,hello);
      Serial.println("preview_wss=connected");
      while (ws.available() && WiFi.status()==WL_CONNECTED) {
        ws.poll();
        const uint32_t now=millis();
        if (leaseUntil_ && static_cast<int32_t>(leaseUntil_-now)>0) {
          if (static_cast<int32_t>(now-nextFrame_)>=0) frame(ws);
        } else stopCamera();
        if (now-pingAt_>25000) { ws.ping(); pingAt_=now; }
        vTaskDelay(pdMS_TO_TICKS(10));
      }
      ws.close(); stopCamera(); leaseUntil_=0; vTaskDelay(pdMS_TO_TICKS(2000));
    }
  }
};
#endif
