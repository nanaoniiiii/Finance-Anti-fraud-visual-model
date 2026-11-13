#pragma once
#include "poseguard/types.hpp"
#include <cstdint>
#include <memory>
#include <string>

namespace poseguard {
class DisplaySink {
 public:
  DisplaySink();
  ~DisplaySink();
  DisplaySink(const DisplaySink&) = delete;
  DisplaySink& operator=(const DisplaySink&) = delete;
  bool show(const Frame& frame);
  std::uint64_t rendered_frames() const;
  const std::string& last_error() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace poseguard
