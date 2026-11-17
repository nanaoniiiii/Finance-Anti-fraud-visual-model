#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include "BoundedRead.h"

// HTTPClient::getString() can repeatedly restart a read timeout after a
// truncated response. Use HTTP/1.0 (no chunked encoding) and one absolute
// deadline, yielding even while bytes arrive. Callers close the connection.
inline bool readBoundedHttpJson(HTTPClient& http, JsonDocument& output,
                                uint32_t timeoutMs, size_t limit = 65536) {
  if (http.getSize() > int(limit)) return false;
  NetworkClient* stream = http.getStreamPtr();
  if (!stream) return false;
  String body;
  if (!body.reserve(std::min(size_t(4096), limit))) return false;
  return poseguard_network::read_body(*stream, http.getSize(), limit, timeoutMs,
      [] {return millis();}, [] {vTaskDelay(pdMS_TO_TICKS(2));},
      [&](const uint8_t* bytes, size_t length, bool parse) {
        using State = poseguard_network::BodyState;
        if (length && !body.concat(reinterpret_cast<const char*>(bytes), length)) return State::invalid;
        if (!parse) return State::waiting;
        const auto error = deserializeJson(output, body);
        if (!error) return State::complete;
        return error == DeserializationError::IncompleteInput || error == DeserializationError::EmptyInput
                   ? State::waiting : State::invalid;
      });
}
