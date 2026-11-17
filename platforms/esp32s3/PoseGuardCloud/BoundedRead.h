#pragma once
#include <algorithm>
#include <cstdint>
#include <cstddef>

namespace poseguard_network {
enum class BodyState { waiting, complete, invalid };
// One deadline for the entire response, including short/zero reads. Consumers
// can finish a JSON body before an HTTP/1.0 peer closes its TCP connection.
template <class Socket, class Clock, class Wait, class Consumer>
bool read_body(Socket& socket, int expected, std::size_t limit,
               std::uint32_t timeout, Clock now, Wait wait, Consumer consume) {
  if (expected > 0 && std::size_t(expected) > limit) return false;
  const std::uint32_t began = now();
  std::size_t used = 0;
  while (std::uint32_t(now() - began) < timeout) {
    const int available = socket.available();
    if (available > 0) {
      if (used >= limit) return false;
      std::uint8_t bytes[256];
      const auto wanted = std::min({std::size_t(available), sizeof(bytes), limit-used});
      const int received = socket.read(bytes, wanted);
      if (received < 0 || std::size_t(received) > wanted) return false;
      used += received;
      const auto result = consume(bytes, received, expected < 0 || used >= std::size_t(expected));
      if (result != BodyState::waiting) return result == BodyState::complete;
    } else if (!socket.connected()) {
      if (expected >= 0 && used < std::size_t(expected)) return false;
      return consume(nullptr, 0, true) == BodyState::complete;
    }
    wait();
  }
  return false;
}
// TLS can split a WebSocket header at any byte. Do not hand an incomplete
// header to a parser, and do not spin forever when a payload stops arriving.
template <class Socket, class Clock, class Wait>
std::uint32_t read_exact(Socket& socket, std::uint8_t* bytes,
                         std::uint32_t length, std::uint32_t timeout, Clock now,
                         Wait wait) {
  const std::uint32_t start = now();
  std::uint32_t offset = 0;
  while (offset < length && socket.connected() &&
         std::uint32_t(now() - start) < timeout) {
    const int available = socket.available();
    if (available > 0) {
      const auto wanted = std::min(length - offset, std::uint32_t(available));
      const int received = socket.read(bytes + offset, wanted);
      if (received < 0 || std::uint32_t(received) > wanted) {
        socket.stop();
        return 0;
      }
      offset += received;
    }
    if (offset < length) wait();
  }
  if (offset == length) return length;
  socket.stop();
  return 0;
}
}  // namespace poseguard_network
