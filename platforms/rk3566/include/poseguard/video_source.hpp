#pragma once

#include "poseguard/types.hpp"

#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace poseguard {

struct UvcDevice {
  std::string path{};
  std::string name{};
};

using CapabilityProbe = std::function<bool(const std::string&)>;

std::vector<UvcDevice> discover_uvc_devices(
    const std::filesystem::path& sysfs_root,
    const CapabilityProbe& capability_probe);
bool probe_video_capture(const std::string& device_path);

enum class VideoSourceKind { File, UsbCamera };

struct VideoSourceConfig {
  VideoSourceKind kind{VideoSourceKind::UsbCamera};
  std::string path{};
  std::string preferred_device{};
  std::filesystem::path sysfs_root{"/sys/class/video4linux"};
  int rescan_interval_ms{2000};
};

class VideoSource {
 public:
  explicit VideoSource(VideoSourceConfig config);
  ~VideoSource();

  VideoSource(VideoSource&&) noexcept;
  VideoSource& operator=(VideoSource&&) noexcept;
  VideoSource(const VideoSource&) = delete;
  VideoSource& operator=(const VideoSource&) = delete;

  bool read(Frame& frame, int timeout_ms = 1000);
  bool waiting_for_camera() const;
  bool end_of_stream() const;
  const std::string& active_device() const;
  const std::string& last_error() const;
  void close();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace poseguard
