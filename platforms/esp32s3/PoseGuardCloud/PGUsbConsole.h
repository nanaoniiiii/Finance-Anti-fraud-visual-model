#pragma once
#if defined(POSEGUARD_S3_MODEL)
#include <Arduino.h>
#include <driver/usb_serial_jtag.h>
#include <driver/usb_serial_jtag_vfs.h>

// Use one ESP-IDF USB driver for console logging and binary uploads. Mixing
// Arduino HWCDC's byte queues with the IDF console on the same peripheral can
// lose RX data. Baud-rate arguments are immaterial to this native USB
// transport.
class PGUsbConsole : public Stream {
 public:
  size_t setRxBufferSize(size_t size) {
    rxSize_ = size;
    return size;
  }
  size_t setTxBufferSize(size_t size) {
    txSize_ = size;
    return size;
  }
  void begin(unsigned long) {
    if (!usb_serial_jtag_is_driver_installed()) {
      usb_serial_jtag_driver_config_t config{.tx_buffer_size = txSize_,
                                             .rx_buffer_size = rxSize_};
      ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&config));
    }
    usb_serial_jtag_vfs_use_driver();
  }
  int available() override {
    if (peeked_ >= 0) return 1;
    uint8_t byte;
    if (usb_serial_jtag_read_bytes(&byte, 1, 0) == 1) {
      peeked_ = byte;
      return 1;
    }
    return 0;
  }
  int peek() override { return available() ? peeked_ : -1; }
  int read() override {
    if (peeked_ >= 0) {
      int byte = peeked_;
      peeked_ = -1;
      return byte;
    }
    uint8_t byte;
    return usb_serial_jtag_read_bytes(&byte, 1, 0) == 1 ? byte : -1;
  }
  size_t read(uint8_t* destination, size_t length) {
    size_t used = 0;
    if (length && peeked_ >= 0) {
      destination[used++] = peeked_;
      peeked_ = -1;
    }
    if (used < length) {
      const int count =
          usb_serial_jtag_read_bytes(destination + used, length - used, 0);
      if (count > 0) used += count;
    }
    return used;
  }
  size_t write(uint8_t byte) override { return write(&byte, 1); }
  size_t write(const uint8_t* data, size_t length) override {
    const int sent =
        usb_serial_jtag_write_bytes(data, length, pdMS_TO_TICKS(100));
    return sent > 0 ? sent : 0;
  }
  void flush() override { usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(200)); }

 private:
  size_t rxSize_{8192}, txSize_{4096};
  int peeked_{-1};
};
inline PGUsbConsole pgUsbConsole;
#ifdef Serial
#undef Serial
#endif
#define Serial pgUsbConsole
#endif
