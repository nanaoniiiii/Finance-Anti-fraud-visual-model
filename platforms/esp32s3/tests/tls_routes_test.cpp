#include <iostream>

#include "CloudTlsClient.h"

static void verifyIdentity(const char* host) {
  assert(!fixture::attempts.empty());
  assert(fixture::unsafeHostnameCalls == 0);
  for (const auto& attempt : fixture::attempts) {
    assert(attempt.host == host);
    assert(attempt.ca == "fixture-root");
  }
}

int main() {
  // Every request, including a cached route, must retain its selected address
  // so a later HTTP timeout can invalidate it.
  fixture::reset();
  CloudTlsClient first("fixture-root");
  assert(first.connect("cache.test", 443, 6500) == 1);
  first.noteHttpResult(200);
  assert(first.connectedAddress() == fixture::primary);
  CloudTlsClient cached("fixture-root");
  assert(cached.connect("cache.test", 443, 6500) == 1);
  assert(cached.connectedAddress() == fixture::primary);
  assert(fixture::dnsQueries == 0);
  verifyIdentity("cache.test");

  // A completed TLS handshake does not imply HTTP success. A read timeout on
  // the cached route must choose the other DNS address on the next request.
  cached.noteHttpResult(-11);
  CloudTlsClient retry("fixture-root");
  assert(retry.connect("cache.test", 443, 6500) == 1);
  assert(retry.connectedAddress() == fixture::alternate);
  assert(fixture::dnsQueries == 1);
  verifyIdentity("cache.test");
  retry.noteHttpResult(200);

  fixture::reset();
  fixture::rejectPrimary = true;
  CloudTlsClient tlsRetry("fixture-root");
  assert(tlsRetry.connect("handshake.test", 443, 6500) == 1);
  assert(tlsRetry.connectedAddress() == fixture::alternate);
  verifyIdentity("handshake.test");

  // Reject truncated or unrelated DNS replies without reading past the end.
  fixture::reset();
  fixture::rejectPrimary = fixture::truncateReply = true;
  CloudTlsClient truncated("fixture-root");
  assert(truncated.connect("truncated.test", 443, 6500) == 0);
  verifyIdentity("truncated.test");
  fixture::reset();
  fixture::rejectPrimary = fixture::wrongTransaction = true;
  CloudTlsClient unrelated("fixture-root");
  const auto started = millis();
  assert(unrelated.connect("unrelated.test", 443, 6500) == 0);
  assert(millis() - started <= 1500);
  verifyIdentity("unrelated.test");
  std::cout << "ESP32 TLS route regressions: 6 passed\n";
}
