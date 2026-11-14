#pragma once
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "poseguard/types.hpp"

namespace poseguard {
struct CameraSettings {
  std::string rotation{"auto"};
  bool mirror{};
  std::uint64_t version{};
};
class PreviewStream {
 public:
  PreviewStream(std::string directory, CameraSettings initial,
                std::string source_type = "camera");
  ~PreviewStream();
  PreviewStream(const PreviewStream&) = delete;
  PreviewStream& operator=(const PreviewStream&) = delete;
  void control(const std::map<std::string, std::string>& query);
  CameraSettings camera() const;
  void applied(std::uint64_t version, int rotation, bool mirror, bool changed);
  void offer(const Frame& frame, const std::vector<TrackState>& tracks,
             const std::vector<RiskDecision>& risks, const Metrics& metrics);
  std::vector<std::uint8_t> latest(std::uint64_t after,
                                   const std::string& epoch) const;
  std::string status() const;
  bool active() const;
  int learned_rotation() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
std::map<std::string, std::string> preview_query(const std::string& path);
}  // namespace poseguard
