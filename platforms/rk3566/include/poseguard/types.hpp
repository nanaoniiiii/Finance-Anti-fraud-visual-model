#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace poseguard {

constexpr std::size_t kKeypointCount = 17;
constexpr std::size_t kMaxTracks = 8;

struct Rgb {
  std::uint8_t r{};
  std::uint8_t g{};
  std::uint8_t b{};

  constexpr bool operator==(const Rgb& rhs) const noexcept {
    return r == rhs.r && g == rhs.g && b == rhs.b;
  }
};

struct Point {
  float x{};
  float y{};
};

struct BBox {
  float x1{};
  float y1{};
  float x2{};
  float y2{};
};

struct Keypoint {
  float x{};
  float y{};
  float confidence{};
  bool valid{};
};

struct PoseObservation {
  int detection_index{};
  BBox bbox{};
  float confidence{};
  std::array<Keypoint, kKeypointCount> keypoints{};
};

enum class RiskKind {
  None,
  PhoneToEar,
  MultiPerson,
  Lingering,
};

enum class RiskState {
  Normal,
  Candidate,
  Alert,
};

constexpr Rgb color_for(RiskState state) noexcept {
  switch (state) {
    case RiskState::Candidate:
      return {255, 140, 0};
    case RiskState::Alert:
      return {255, 0, 0};
    case RiskState::Normal:
    default:
      return {255, 220, 0};
  }
}

struct TrackState {
  int track_id{-1};
  BBox bbox{};
  float confidence{};
  std::array<Keypoint, kKeypointCount> keypoints{};
  Point center{};
  double first_seen_seconds{};
  double last_seen_seconds{};
  float normalized_center_speed{};
  float pose_motion{};
  int visible_frames{};
  bool confirmed{};
  bool predicted{};
};

struct RiskDecision {
  int track_id{-1};
  RiskKind kind{RiskKind::None};
  RiskState state{RiskState::Normal};
  double duration_seconds{};
  BBox bbox{};
};

struct Frame {
  int width{};
  int height{};
  double pts_seconds{};
  double timeline_seconds{};
  std::vector<std::uint8_t> rgb{};
};

struct Metrics {
  std::uint64_t frame_index{};
  double fps{};
  double inference_ms{};
  double processing_ms{};
  std::size_t visible_tracks{};
};

}  // namespace poseguard
