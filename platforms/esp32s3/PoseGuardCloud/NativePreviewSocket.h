#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_transport_ssl.h>
#include <esp_transport_ws.h>
#include <esp_tls.h>
#include <esp_websocket_client.h>
#include <lwip/sockets.h>
#include <lwip/tcp.h>

#include <atomic>
#include <functional>
#include <memory>

#include "CloudTlsClient.h"
#include "BoundedHttpJson.h"

// ESP-IDF owns framing, TLS reads, ping/pong, and the receive task. Controls
// use a bounded mailbox and are applied in the preview
// task, so camera reconfiguration never blocks the TLS event callback.
class NativePreviewSocket {
 public:
  ~NativePreviewSocket() { close(); }
  void onMessage(std::function<void(const String&)> callback) {
    callback_ = std::move(callback);
  }
  bool connect(const String& uri, const String& token, const char* ca) {
    uri_ = uri; token_ = token; ca_ = ca;
    const int pathAt = uri_.indexOf('/', 6);
    if (!uri_.startsWith("wss://") || pathAt <= 6) return false;
    authority_ = uri_.substring(6, pathAt);
    const int colon = authority_.indexOf(':');
    host_ = colon < 0 ? authority_ : authority_.substring(0, colon);
    const long port = colon < 0 ? 443L : authority_.substring(colon + 1).toInt();
    if (host_.isEmpty() || port < 1 || port > 65535) return false;
    port_ = static_cast<int>(port);
    if (serverWaitHost_==host_) {
      if (serverWaitUntil_ && int32_t(serverWaitUntil_-millis())>0) return false;
      serverWaitUntil_=0;serverWaitHost_="";
    }
    ownRouteRevision_ = CloudTlsClient::routeRevision();
    if (ownRouteRevision_ != seenRouteRevision_) {
      seenRouteRevision_ = ownRouteRevision_; httpUntil_ = 0;
    }
    if (int32_t(httpUntil_ - millis()) > 0) return startHttp();
    if (connectWebSocket(uri, token, ca)) return true;
    close();
    preferHttp();
    return startHttp();
  }
  void preferHttp() {
    httpUntil_ = millis() + 5 * 60000;
    if (!httpMode_) CloudTlsClient::routeFailed(host_, peer_);
  }
  bool connectWebSocket(const String& uri, const String& token, const char* ca) {
    // Upstream's failed-upgrade log can contain the entire Authorization
    // request. Report bounded client diagnostics without dumping credentials.
    esp_log_level_set("transport_ws", ESP_LOG_NONE);
    uri_ = uri;
    headers_ = "Authorization: Bearer " + token + "\r\n";
    ca_ = ca;
    const int pathAt = uri_.indexOf('/', 6);
    ssl_ = esp_transport_ssl_init();
    mapped_ = esp_transport_init();
    if (!ssl_ || !mapped_) return false;
    esp_transport_ssl_set_cert_data(ssl_, ca, strlen(ca) + 1);
    esp_transport_ssl_set_common_name(ssl_, host_.c_str());
    esp_transport_ssl_set_addr_family(ssl_, ESP_TLS_AF_INET);
    esp_transport_set_context_data(mapped_, this);
    esp_transport_set_func(
        mapped_,
        [](esp_transport_handle_t transport, const char* hostname, int port,
           int timeout) {
          auto* self = static_cast<NativePreviewSocket*>(
              esp_transport_get_context_data(transport));
          const auto routes = CloudTlsClient::routeCandidates(hostname);
          for (const auto& address : routes) {
            const String ip = address.toString();
            Serial.printf("s3_native_route=%s port=%d\n", ip.c_str(), port);
            if (esp_transport_connect(
                    self->ssl_, ip.c_str(), port,
                    std::min(5000, std::max(1000, timeout))) == 0) {
              self->peer_ = address;
              // A WS fragment has a separate small header. Avoid waiting for
              // delayed TCP acknowledgements between that header and the JPEG.
              const int socket = esp_transport_get_socket(self->ssl_);
              const int enabled = 1;
              if (socket >= 0)
                setsockopt(socket, IPPROTO_TCP, TCP_NODELAY, &enabled,
                           sizeof(enabled));
              return 0;
            }
            esp_transport_close(self->ssl_);
          }
          return -1;
        },
        [](esp_transport_handle_t t, char* b, int n, int timeout) {
          auto* self = static_cast<NativePreviewSocket*>(
              esp_transport_get_context_data(t));
          const int received = esp_transport_read(self->ssl_, b, n, timeout);
          return received;
        },
        [](esp_transport_handle_t t, const char* b, int n, int timeout) {
          auto* self = static_cast<NativePreviewSocket*>(
              esp_transport_get_context_data(t));
          // A short TLS write must finish the SAME WS fragment. Starting a
          // continuation after a short payload would corrupt its declared size.
          const uint32_t began = millis();
          int sent = 0;
          while (sent < n && millis() - began < uint32_t(timeout)) {
            const int remaining = timeout - int(millis() - began);
            const int result = esp_transport_write(self->ssl_, b + sent,
                                                    n - sent, remaining);
            if (result > 0) sent += result;
            else if (result != 0 && result != ESP_TLS_ERR_SSL_WANT_READ &&
                     result != ESP_TLS_ERR_SSL_WANT_WRITE) return -1;
            else vTaskDelay(pdMS_TO_TICKS(2));
          }
          if (sent != n)
            Serial.printf("s3_preview_tls_write=timeout sent=%d expected=%d\n", sent, n);
          return sent == n ? sent : -1;
        },
        [](esp_transport_handle_t t) {
          return esp_transport_close(static_cast<NativePreviewSocket*>(
                                         esp_transport_get_context_data(t))
                                         ->ssl_);
        },
        [](esp_transport_handle_t t, int timeout) {
          return esp_transport_poll_read(static_cast<NativePreviewSocket*>(
                                             esp_transport_get_context_data(t))
                                             ->ssl_,
                                         timeout);
        },
        [](esp_transport_handle_t t, int timeout) {
          return esp_transport_poll_write(static_cast<NativePreviewSocket*>(
                                              esp_transport_get_context_data(t))
                                              ->ssl_,
                                          timeout);
        },
        [](esp_transport_handle_t) { return 0; });
    esp_transport_set_parent_transport_func(
        mapped_, [](esp_transport_handle_t t) {
          return static_cast<NativePreviewSocket*>(
                     esp_transport_get_context_data(t))
              ->ssl_;
        });
    websocket_ = esp_transport_ws_init(mapped_);
    if (!websocket_) return false;
    esp_transport_set_default_port(websocket_, port_);
    const String endpointPath = uri_.substring(pathAt);
    esp_transport_ws_config_t wsConfig{};
    wsConfig.ws_path = endpointPath.c_str();
    wsConfig.headers = headers_.c_str();
    wsConfig.user_agent = "PoseGuard-ESP32-S3/1.6.0";
    wsConfig.propagate_control_frames = true;
    esp_transport_ws_set_config(websocket_, &wsConfig);
    mailbox_ = xQueueCreate(32, sizeof(char*));
    if (!mailbox_) return false;
    esp_websocket_client_config_t config{};
    config.uri = uri_.c_str();
    config.port = port_;
    config.ext_transport = websocket_;
    config.headers = headers_.c_str();
    config.cert_pem = ca;
    config.skip_cert_common_name_check = false;
    config.disable_auto_reconnect = true;
    config.network_timeout_ms = 5000;
    config.buffer_size = 16384;
    config.task_stack = 8192;
    config.task_prio = 4;
    config.task_core_id_set = true;
    config.task_core_id = 0;
    config.ping_interval_sec = 20;
    config.pingpong_timeout_sec = 15;
    config.keep_alive_enable = true;
    config.user_agent = "PoseGuard-ESP32-S3/1.6.0";
    client_ = esp_websocket_client_init(&config);
    if (!client_) {
      Serial.println("s3_native_init=failed");
      return false;
    }
    esp_websocket_register_events(client_, WEBSOCKET_EVENT_ANY, event, this);
    const esp_err_t startResult = esp_websocket_client_start(client_);
    if (startResult != ESP_OK) {
      Serial.printf("s3_native_start=0x%x\n", startResult);
      return false;
    }
    const uint32_t began = millis();
    while (!connected_ && !failed_ && millis() - began < 18000)
      vTaskDelay(pdMS_TO_TICKS(20));
    if (!available()) Serial.println("s3_native_connect=timeout_or_error");
    return available();
  }
  bool available() const {
    return (httpMode_ || client_) && connected_ && !failed_ &&
      (!httpMode_ || ownRouteRevision_ == CloudTlsClient::routeRevision());
  }
  void poll() {
    char* body = nullptr;
    while (mailbox_ && xQueueReceive(mailbox_, &body, 0) == pdTRUE) {
      if (callback_) callback_(String(body));
      heap_caps_free(body);
    }
    if (httpMode_ && available() && int32_t(millis() - nextPoll_) >= 0)
      httpRequest(nullptr, 0);
  }
  bool send(const String& body) {
    if (!available()) return false;
    if (httpMode_) {
      JsonDocument value;
      if (!deserializeJson(value, body) && value["type"] == "hello") {
        httpPose_ = value["pose"] == true;
        httpLowResource_=value["low_resource"]==true;
        httpWindow_=std::clamp(value["max_inflight_frames"]|1U,1U,12U);
      }
      return true;
    }
    const int sent = esp_websocket_client_send_text(
        client_, body.c_str(), body.length(), pdMS_TO_TICKS(8000));
    if (sent != int(body.length())) {
      Serial.printf("s3_preview_send=text sent=%d expected=%u\n", sent,
                    unsigned(body.length()));
      failed_ = true;
      preferHttp();
    }
    return !failed_;
  }
  bool sendBinary(const char* bytes, size_t length) {
    if (!available()) return false;
    if (httpMode_) return httpRequest(bytes, length);
    const uint32_t began = millis();
    const int sent = esp_websocket_client_send_bin(client_, bytes, length,
                                                   pdMS_TO_TICKS(8000));
    if (sent != int(length)) {
      Serial.printf("s3_preview_send=jpeg sent=%d expected=%u elapsed_ms=%u\n",
                    sent, unsigned(length), unsigned(millis() - began));
      failed_ = true;
      preferHttp();
    }
    return !failed_;
  }
  void ping() {}  // ESP-IDF performs protocol ping/pong in its receive task.
  void close() {
    if (httpTls_) {
      http_->setReuse(false); http_->end(); http_.reset();
      httpTls_->stop(); httpTls_.reset();
    }
    httpMode_ = false;
    if (client_) {
      esp_websocket_client_stop(client_);
      esp_websocket_client_destroy(client_);
      client_ = nullptr;
    }
    connected_ = false;
    if (websocket_) {
      esp_transport_destroy(websocket_);
      websocket_ = nullptr;
    }
    if (mapped_) {
      esp_transport_destroy(mapped_);
      mapped_ = nullptr;
    }
    if (ssl_) {
      esp_transport_destroy(ssl_);
      ssl_ = nullptr;
    }
    heap_caps_free(assembly_);
    assembly_ = nullptr;
    if (mailbox_) {
      char* body = nullptr;
      while (xQueueReceive(mailbox_, &body, 0) == pdTRUE) heap_caps_free(body);
      vQueueDelete(mailbox_);
      mailbox_ = nullptr;
    }
  }

 private:
  esp_websocket_client_handle_t client_{};
  esp_transport_handle_t ssl_{}, mapped_{}, websocket_{};
  const char* ca_{};
  QueueHandle_t mailbox_{};
  std::atomic<bool> connected_{false}, failed_{false};
  String uri_, headers_, authority_, host_, token_, httpSession_;
  int port_{443};
  IPAddress peer_;
  std::unique_ptr<HTTPClient> http_;
  std::unique_ptr<CloudTlsClient> httpTls_;
  bool httpMode_{}, httpPose_{},httpLowResource_{};
  unsigned httpWindow_{1};
  uint32_t nextPoll_{};
  inline static uint32_t httpUntil_{};
  inline static uint32_t seenRouteRevision_{};
  inline static uint32_t serverWaitUntil_{};
  inline static String serverWaitHost_;
  uint32_t ownRouteRevision_{};
  std::function<void(const String&)> callback_;
  char* assembly_{};
  int expected_{}, received_{};
  void enqueue(const String& message) {
    if (!mailbox_ || message.length() > 8192) return;
    char* body = static_cast<char*>(heap_caps_malloc(message.length() + 1,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!body) {failed_ = true; return;}
    memcpy(body, message.c_str(), message.length() + 1);
    char* previous = nullptr;
    if (uxQueueSpacesAvailable(mailbox_) == 0 && xQueueReceive(mailbox_, &previous, 0) == pdTRUE)
      heap_caps_free(previous);
    if (xQueueSend(mailbox_, &body, 0) != pdTRUE) heap_caps_free(body);
  }
  bool startHttp() {
    failed_ = false; connected_ = true; httpMode_ = true;
    mailbox_ = xQueueCreate(8, sizeof(char*));
    if (!mailbox_) {failed_ = true; return false;}
    httpTls_ = std::make_unique<CloudTlsClient>(ca_);
    http_ = std::make_unique<HTTPClient>();
    httpTls_->setHandshakeTimeout(5); httpTls_->setTimeout(8000);
    httpSession_ = String(esp_random(), HEX) + "_" + String(millis());
    Serial.println("s3_preview_transport=https_fallback");
    return httpRequest(nullptr, 0);
  }
  bool httpRequest(const char* bytes, size_t length) {
    // Some gateways silently discard idle reused TLS connections. Each fallback
    // request is independent, as in the device's durable event uploader.
    http_->setReuse(false); http_->setConnectTimeout(5000); http_->setTimeout(8000);
    http_->useHTTP10(true);
    const String endpoint = "https://" + authority_ + "/api/device/preview/" + (bytes ? "frame" : "control");
    if (!http_->begin(*httpTls_, endpoint)) {failed_ = true; return false;}
    http_->setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    const char* retryHeaders[]={"Retry-After"};
    http_->collectHeaders(retryHeaders,1);
    http_->setUserAgent("PoseGuard-ESP32-S3/1.6.0");
    http_->addHeader("Authorization", "Bearer " + token_);
    http_->addHeader("X-PoseGuard-Stream", httpSession_);
    http_->addHeader("X-PoseGuard-Pose", httpPose_ ? "1" : "0");
    http_->addHeader("X-PoseGuard-Low-Resource",httpLowResource_?"1":"0");
    http_->addHeader("X-PoseGuard-Source-Window",String(httpWindow_));
    if (bytes) http_->addHeader("Content-Type", "application/octet-stream");
    const int status = bytes ? http_->POST(reinterpret_cast<uint8_t*>(const_cast<char*>(bytes)), length) : http_->GET();
    httpTls_->noteHttpResult(status);
    if (status != 200 || http_->getSize() > 8192) {
      if(status==503) {
        const long seconds=http_->header("Retry-After").toInt();
        if(seconds>0) {
          const uint32_t delaySeconds=std::min(300L,seconds);
          serverWaitHost_=host_;serverWaitUntil_=millis()+delaySeconds*1000;
          Serial.printf("s3_preview_server_backoff_s=%lu\n",static_cast<unsigned long>(delaySeconds));
        }
      }
      Serial.printf("s3_preview_https=%d\n", status);
      http_->setReuse(false); http_->end(); failed_ = true; return false;
    }
    JsonDocument response;
    const bool parsed = readBoundedHttpJson(*http_, response, 8000, 8192);
    http_->end();
    if (!parsed || response["type"] != "control") {
      httpTls_->noteHttpResult(-101); failed_ = true; return false;
    }
    String body; serializeJson(response, body);
    Serial.printf("s3_preview_https=200 active=%d raw=%d pose=%d bytes=%u\n",
                  response["active"] == true, response["want_raw"] == true,
                  response["want_pose"] == true, unsigned(length));
    nextPoll_ = millis() + constrain(response["poll_ms"] | 1000, 1000, 5000);
    if (response["accepted"].is<JsonObject>()) {
      String accepted; serializeJson(response["accepted"], accepted); enqueue(accepted);
    }
    enqueue(body);
    return true;
  }
  static void event(void* context, esp_event_base_t, int32_t id, void* value) {
    static_cast<NativePreviewSocket*>(context)->handle(
        id, static_cast<esp_websocket_event_data_t*>(value));
  }
  void handle(int32_t id, const esp_websocket_event_data_t* data) {
    if (id == WEBSOCKET_EVENT_CONNECTED) {
      connected_ = true;
      Serial.println("s3_native_connected=1");
      return;
    }
    if (id == WEBSOCKET_EVENT_DISCONNECTED || id == WEBSOCKET_EVENT_CLOSED) {
      connected_ = false;
      Serial.printf("s3_preview_connection=closed event=%d\n", int(id));
      return;
    }
    if (id == WEBSOCKET_EVENT_ERROR) {
      failed_ = true;
      preferHttp();
      Serial.println("s3_preview_transport=error");
      return;
    }
    if (id == WEBSOCKET_EVENT_DATA && data && data->op_code == 10) {
      Serial.println("s3_preview_pong=received");
      return;
    }
    if (id != WEBSOCKET_EVENT_DATA || !data ||
        (data->op_code != 1 && data->op_code != 0))
      return;
    if (data->payload_len == 0 && data->data_len == 0) return;
    if (data->payload_len < 0 || data->payload_len > 8192 ||
        data->payload_offset < 0 || data->data_len < 0) {
      failed_ = true;
      return;
    }
    if (data->payload_offset == 0) {
      heap_caps_free(assembly_);
      expected_ = data->payload_len;
      received_ = 0;
      assembly_ = static_cast<char*>(heap_caps_malloc(
          size_t(expected_) + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      if (!assembly_) {
        failed_ = true;
        return;
      }
    }
    if (!assembly_ || data->payload_offset != received_ ||
        received_ + data->data_len > expected_) {
      failed_ = true;
      return;
    }
    memcpy(assembly_ + received_, data->data_ptr, data->data_len);
    received_ += data->data_len;
    if (received_ == expected_) {
      assembly_[received_] = 0;
      char* previous = nullptr;
      if (uxQueueSpacesAvailable(mailbox_) == 0 &&
          xQueueReceive(mailbox_, &previous, 0) == pdTRUE)
        heap_caps_free(previous);
      char* completed = assembly_;
      assembly_ = nullptr;
      if (xQueueSend(mailbox_, &completed, 0) != pdTRUE)
        heap_caps_free(completed);
    }
  }
};
