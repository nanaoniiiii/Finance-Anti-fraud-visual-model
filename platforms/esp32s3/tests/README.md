# ESP32 transport host regression

From the repository root on Linux with GCC:

```sh
mkdir -p build/esp32-host
g++ -std=c++17 -fsanitize=address,undefined -fno-omit-frame-pointer \
  -Iplatforms/esp32s3/tests/fakes -Iplatforms/esp32s3/PoseGuardCloud \
  platforms/esp32s3/tests/tls_routes_test.cpp -o build/esp32-host/tls_routes_test
build/esp32-host/tls_routes_test
```

These tests exercise the production route selection and DNS response parser
against fake network transports. They cover cached address tracking, switching
after an HTTP timeout, switching after a TLS failure, truncated DNS responses,
and unrelated DNS transaction IDs. They check that each attempted address keeps
the requested hostname and CA and avoids the legacy hostname resolver which
clears the shared DNS cache from a caller task. Actual TLS cryptography, Wi-Fi, router access and
cloud delivery require the separate device tests.
