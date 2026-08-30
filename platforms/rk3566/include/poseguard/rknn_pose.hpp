#pragma once

#include "poseguard/types.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace poseguard {

struct Letterbox {
  float scale{1.0F};
  float pad_x{};
  float pad_y{};
  int source_width{};
  int source_height{};
};

std::vector<float> dequantize_int8(const std::int8_t* values,
                                   std::size_t value_count,
                                   std::int32_t zero_point, float scale);

std::vector<PoseObservation> decode_pose(
    const std::vector<float>& output, const std::array<int, 3>& shape,
    const Letterbox& transform, float score_threshold,
    float keypoint_threshold, float nms_threshold);

class RknnPoseEngine {
 public:
  explicit RknnPoseEngine(const std::string& model_path,
                          float score_threshold = 0.35F,
                          float keypoint_threshold = 0.25F,
                          float nms_threshold = 0.45F);
  ~RknnPoseEngine();

  RknnPoseEngine(RknnPoseEngine&&) noexcept;
  RknnPoseEngine& operator=(RknnPoseEngine&&) noexcept;
  RknnPoseEngine(const RknnPoseEngine&) = delete;
  RknnPoseEngine& operator=(const RknnPoseEngine&) = delete;

  std::vector<PoseObservation> infer(const Frame& frame, Metrics& metrics);
  const std::string& runtime_version() const;
  const std::string& driver_version() const;
  std::array<int, 3> output_shape() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace poseguard
