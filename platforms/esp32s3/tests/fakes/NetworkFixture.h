#pragma once
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

using String = std::string;
struct IPAddress {
  std::array<uint8_t, 4> bytes{};
  IPAddress() = default;
  IPAddress(uint8_t a, uint8_t b, uint8_t c, uint8_t d) : bytes{a, b, c, d} {}
  explicit IPAddress(uint32_t value) { std::memcpy(bytes.data(), &value, 4); }
  explicit IPAddress(const uint8_t* input) {
    std::copy_n(input, 4, bytes.begin());
  }
  bool operator==(const IPAddress& other) const { return bytes == other.bytes; }
  bool operator!=(const IPAddress& other) const { return !(*this == other); }
};

namespace fixture {
inline const IPAddress primary{192, 0, 2, 10};
inline const IPAddress alternate{192, 0, 2, 11};
inline const IPAddress resolver{192, 0, 2, 53};
inline uint32_t now = 0;
inline unsigned dnsQueries = 0;
inline unsigned unsafeHostnameCalls = 0;
inline bool rejectPrimary = false;
inline bool truncateReply = false;
inline bool wrongTransaction = false;
struct Attempt {
  String host;
  String ca;
  IPAddress address;
};
inline std::vector<Attempt> attempts;
inline void reset() {
  rejectPrimary = truncateReply = wrongTransaction = false;
  dnsQueries = 0;
  unsafeHostnameCalls = 0;
  attempts.clear();
}
}  // namespace fixture

inline uint32_t millis() { return fixture::now; }
inline void delay(uint32_t duration) { fixture::now += duration; }
inline uint32_t esp_random() { return 0x1234; }
inline struct WiFiFixture {
  IPAddress dnsIP() const { return fixture::resolver; }
} WiFi;

class WiFiClientSecure {
 public:
  virtual ~WiFiClientSecure() = default;
  void setCACert(const char* ca) { ca_ = ca; }
  virtual int connect(const char* host, uint16_t port, int32_t timeout) {
    ++fixture::unsafeHostnameCalls;
    return connect(fixture::primary, port, host, ca_, nullptr, nullptr);
  }
  int connect(IPAddress address, uint16_t port, const char* host,
              const char* ca, const char*, const char*) {
    assert(port == 443);
    fixture::attempts.push_back({host, ca ? ca : "", address});
    if (fixture::rejectPrimary && address == fixture::primary) return 0;
    address_ = address;
    return 1;
  }
  IPAddress remoteIP() const { return address_; }

 protected:
  int32_t _timeout{};

 private:
  const char* ca_{};
  IPAddress address_;
};

class WiFiUDP {
 public:
  int begin(uint16_t) { return 1; }
  int beginPacket(IPAddress address, uint16_t port) {
    assert(address == fixture::resolver && port == 53);
    return 1;
  }
  size_t write(const uint8_t* bytes, size_t length) {
    packet_.assign(bytes, bytes + length);
    return length;
  }
  int endPacket() {
    ++fixture::dnsQueries;
    // DNS response: the original question followed by two compressed IN/A
    // answers. Addresses are RFC 5737 documentation ranges, never real hosts.
    packet_[2] = 0x81;
    packet_[3] = 0x80;
    packet_[7] = 2;
    for (auto address : {fixture::primary, fixture::alternate}) {
      const uint8_t answer[] = {0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4};
      packet_.insert(packet_.end(), std::begin(answer), std::end(answer));
      packet_.insert(packet_.end(), address.bytes.begin(), address.bytes.end());
    }
    if (fixture::truncateReply) packet_.resize(13);
    if (fixture::wrongTransaction) packet_[0] ^= 1;
    return 1;
  }
  int parsePacket() const { return consumed_ ? 0 : packet_.size(); }
  IPAddress remoteIP() const { return fixture::resolver; }
  uint16_t remotePort() const { return 53; }
  void clear() { consumed_ = true; }
  int read(uint8_t* bytes, size_t length) {
    assert(length <= packet_.size());
    std::copy_n(packet_.begin(), length, bytes);
    consumed_ = true;
    return length;
  }

 private:
  bool consumed_ = false;
  std::vector<uint8_t> packet_;
};
