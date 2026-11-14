#pragma once
#include <netdb.h>

#include "NetworkFixture.h"

inline int lwip_getaddrinfo(const char*, const char*, const addrinfo*,
                            addrinfo** output) {
  static sockaddr_in address{};
  static addrinfo result{};
  address.sin_family = AF_INET;
  std::memcpy(&address.sin_addr.s_addr, fixture::primary.bytes.data(), 4);
  result.ai_family = AF_INET;
  result.ai_socktype = SOCK_STREAM;
  result.ai_addrlen = sizeof address;
  result.ai_addr = reinterpret_cast<sockaddr*>(&address);
  *output = &result;
  return 0;
}

inline void lwip_freeaddrinfo(addrinfo*) {}
