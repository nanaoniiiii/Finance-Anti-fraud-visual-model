#pragma once

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>
#include <esp_random.h>
#include <lwip/inet.h>
#include <lwip/netdb.h>

#include <array>

// The Arduino resolver may return just one address. Ask the router's DNS
// server for all IPv4 candidates after a failed TLS or HTTP request.
// Every candidate is still verified against the original host and CA.
class CloudTlsClient : public WiFiClientSecure {
 public:
  explicit CloudTlsClient(const char* ca) : ca_(ca) { setCACert(ca_); }

  int connect(const char* host, uint16_t port, int32_t timeout) override {
    selected_ = IPAddress();
    selectedHost_ = host;
    // A server can complete TLS but then stop replying to HTTP. Try another
    // verified address before reusing that route after a transport failure.
    if (failedHost_ == host && failed_ != IPAddress()) {
      const auto alternatives = queryRouter(host);
      for (size_t i = 0; i < alternatives.count; ++i) {
        const auto address = alternatives.items[i];
        if (address != failed_ && tryAddress(address, host, port, timeout)) {
          remember(host, address);
          return 1;
        }
      }
    }
    if (preferredHost_ == host && preferred_ != IPAddress() &&
        tryAddress(preferred_, host, port, timeout)) {
      remember(host, preferred_);
      return 1;
    }
    // Network.hostByName in Core 3.3.2 can clear the shared DNS cache from
    // the calling task, invoking an SNTP callback outside the TCP/IP core.
    // Resolve through the thread-safe BSD API and retain host verification.
    const auto defaults = resolveSystem(host);
    for (size_t i = 0; i < defaults.count; ++i) {
      const auto address = defaults.items[i];
      if (tryAddress(address, host, port, timeout)) {
        remember(host, address);
        return 1;
      }
    }

    const auto candidates = queryRouter(host);
    for (size_t i = 0; i < candidates.count; ++i) {
      const auto address = candidates.items[i];
      if (tryAddress(address, host, port, timeout)) {
        remember(host, address);
        return 1;
      }
    }
    preferred_ = IPAddress();
    return 0;
  }

  IPAddress connectedAddress() const { return selected_; }

  void noteHttpResult(int status) {
    if (status <= 0) {
      if (selected_ != IPAddress()) {
        failedHost_ = selectedHost_;
        failed_ = selected_;
      }
      preferred_ = IPAddress();
    } else {
      // HTTP errors still demonstrate a working transport. Authentication,
      // rate limits and server errors are handled by the calling adapter.
      failed_ = IPAddress();
    }
  }

 private:
  struct Addresses {
    std::array<IPAddress, 4> items{};
    size_t count = 0;
  };

  const char* ca_;
  String selectedHost_;
  IPAddress selected_;
  inline static String preferredHost_;
  inline static IPAddress preferred_;
  inline static String failedHost_;
  inline static IPAddress failed_;

  bool tryAddress(IPAddress address, const char* host, uint16_t port,
                  int32_t timeout) {
    _timeout = timeout;
    return WiFiClientSecure::connect(address, port, host, ca_, nullptr,
                                     nullptr) == 1;
  }

  void remember(const char* host, IPAddress address) {
    selectedHost_ = host;
    selected_ = address;
    preferredHost_ = host;
    preferred_ = address;
  }

  static uint16_t word(const uint8_t* bytes) {
    return (static_cast<uint16_t>(bytes[0]) << 8) | bytes[1];
  }

  static Addresses resolveSystem(const char* host) {
    Addresses result;
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* addresses = nullptr;
    if (lwip_getaddrinfo(host, nullptr, &hints, &addresses) != 0) return result;
    for (const addrinfo* item = addresses;
         item && result.count < result.items.size(); item = item->ai_next) {
      if (item->ai_family != AF_INET || !item->ai_addr ||
          item->ai_addrlen < sizeof(sockaddr_in))
        continue;
      const auto* address = reinterpret_cast<const sockaddr_in*>(item->ai_addr);
      result.items[result.count++] = IPAddress(address->sin_addr.s_addr);
    }
    lwip_freeaddrinfo(addresses);
    return result;
  }

  static bool skipName(const uint8_t* packet, size_t size, size_t& cursor) {
    while (cursor < size) {
      const uint8_t label = packet[cursor++];
      if (!label) return true;
      if ((label & 0xc0) == 0xc0) {
        if (cursor == size) return false;
        ++cursor;
        return true;
      }
      if (label > 63 || label > size - cursor) return false;
      cursor += label;
    }
    return false;
  }

  static Addresses queryRouter(const char* host) {
    Addresses result;
    const IPAddress resolver = WiFi.dnsIP();
    if (resolver == IPAddress() || strlen(host) > 253) return result;

    const uint16_t id = static_cast<uint16_t>(esp_random());
    uint8_t packet[512]{};
    packet[0] = id >> 8;
    packet[1] = id & 0xff;
    packet[2] = 1;  // Recursion desired.
    packet[5] = 1;  // One question.
    size_t cursor = 12;
    for (const char* label = host; *label;) {
      const char* end = strchr(label, '.');
      const size_t length =
          end ? static_cast<size_t>(end - label) : strlen(label);
      if (length == 0 || length > 63 || cursor + length + 6 > sizeof(packet))
        return result;
      packet[cursor++] = length;
      memcpy(packet + cursor, label, length);
      cursor += length;
      label += length + (end ? 1 : 0);
    }
    packet[cursor++] = 0;  // End of name.
    packet[cursor++] = 0;
    packet[cursor++] = 1;  // A record.
    packet[cursor++] = 0;
    packet[cursor++] = 1;  // IN class.

    WiFiUDP udp;
    if (!udp.begin(0) || !udp.beginPacket(resolver, 53) ||
        udp.write(packet, cursor) != cursor || !udp.endPacket())
      return result;

    const uint32_t started = millis();
    while (millis() - started < 1500) {
      const int size = udp.parsePacket();
      if (size <= 0) {
        delay(10);
        continue;
      }
      if (size < 12 || size > static_cast<int>(sizeof(packet)) ||
          udp.remoteIP() != resolver || udp.remotePort() != 53) {
        udp.clear();
        continue;
      }
      if (udp.read(packet, size) != size || word(packet) != id ||
          !(packet[2] & 0x80) || (packet[2] & 0x02) || (packet[3] & 0x0f) ||
          word(packet + 4) != 1)
        continue;

      cursor = 12;
      if (!skipName(packet, size, cursor) || cursor + 4 > size) return result;
      cursor += 4;
      const uint16_t answerCount = word(packet + 6);
      for (uint16_t i = 0;
           i < answerCount && result.count < result.items.size(); ++i) {
        if (!skipName(packet, size, cursor) || cursor + 10 > size) break;
        const uint16_t type = word(packet + cursor);
        const uint16_t recordClass = word(packet + cursor + 2);
        const uint16_t length = word(packet + cursor + 8);
        cursor += 10;
        if (length > size - cursor) break;
        if (type == 1 && recordClass == 1 && length == 4) {
          result.items[result.count++] = IPAddress(packet + cursor);
        }
        cursor += length;
      }
      return result;
    }
    return result;
  }
};
