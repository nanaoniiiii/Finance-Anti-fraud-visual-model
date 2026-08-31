#include "poseguard/rknn_pose.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace poseguard {
namespace {

constexpr int kPoseChannels = 56;

float box_area(const BBox& box) {
  return std::max(0.0F, box.x2 - box.x1) *
         std::max(0.0F, box.y2 - box.y1);
}

float intersection_over_union(const BBox& lhs, const BBox& rhs) {
  const float left = std::max(lhs.x1, rhs.x1);
  const float top = std::max(lhs.y1, rhs.y1);
  const float right = std::min(lhs.x2, rhs.x2);
  const float bottom = std::min(lhs.y2, rhs.y2);
  const float intersection =
      std::max(0.0F, right - left) * std::max(0.0F, bottom - top);
  const float union_area = box_area(lhs) + box_area(rhs) - intersection;
  return union_area > 0.0F ? intersection / union_area : 0.0F;
}

float restore_coordinate(float value, float padding, float scale,
                         float maximum) {
  if (scale <= 0.0F) {
    throw std::invalid_argument("letterbox scale must be positive");
  }
  return std::clamp((value - padding) / scale, 0.0F, maximum);
}

}  // namespace

std::vector<float> dequantize_int8(const std::int8_t* values,
                                   std::size_t value_count,
                                   std::int32_t zero_point, float scale) {
  if (values == nullptr && value_count != 0) {
    throw std::invalid_argument("quantized input pointer is null");
  }
  std::vector<float> output(value_count);
  for (std::size_t index = 0; index < value_count; ++index) {
    output[index] =
        (static_cast<std::int32_t>(values[index]) - zero_point) * scale;
  }
  return output;
}

std::vector<float> merge_split_pose_outputs(
    const std::vector<float>& boxes, const std::vector<float>& scores,
    const std::vector<float>& keypoints,
    const std::vector<float>& keypoint_scores, int anchor_count) {
  if (anchor_count <= 0 ||
      boxes.size() != static_cast<std::size_t>(4 * anchor_count) ||
      scores.size() != static_cast<std::size_t>(anchor_count) ||
      keypoints.size() != static_cast<std::size_t>(51 * anchor_count) ||
      keypoint_scores.size() != static_cast<std::size_t>(17 * anchor_count)) {
    throw std::invalid_argument("split pose output sizes do not match");
  }

  std::vector<float> output(static_cast<std::size_t>(kPoseChannels) *
                            anchor_count);
  std::copy(boxes.begin(), boxes.end(), output.begin());
  std::copy(scores.begin(), scores.end(), output.begin() + 4 * anchor_count);
  std::copy(keypoints.begin(), keypoints.end(),
            output.begin() + 5 * anchor_count);
  for (int point = 0; point < 17; ++point) {
    std::copy(keypoint_scores.begin() + point * anchor_count,
              keypoint_scores.begin() + (point + 1) * anchor_count,
              output.begin() + (7 + point * 3) * anchor_count);
  }
  return output;
}

std::vector<PoseObservation> decode_pose(
    const std::vector<float>& output, const std::array<int, 3>& shape,
    const Letterbox& transform, float score_threshold,
    float keypoint_threshold, float nms_threshold) {
  if (shape[0] != 1 || transform.source_width <= 0 ||
      transform.source_height <= 0) {
    throw std::invalid_argument("invalid pose tensor or source dimensions");
  }

  bool channels_first = false;
  int anchor_count = 0;
  if (shape[1] == kPoseChannels) {
    channels_first = true;
    anchor_count = shape[2];
  } else if (shape[2] == kPoseChannels) {
    anchor_count = shape[1];
  } else {
    throw std::invalid_argument("pose output must contain 56 channels");
  }
  if (anchor_count <= 0 ||
      output.size() != static_cast<std::size_t>(anchor_count) *
                           kPoseChannels) {
    throw std::invalid_argument("pose output size does not match its shape");
  }

  const auto value_at = [&](int anchor, int channel) {
    const std::size_t index =
        channels_first
            ? static_cast<std::size_t>(channel) * anchor_count + anchor
            : static_cast<std::size_t>(anchor) * kPoseChannels + channel;
    return output[index];
  };

  std::vector<PoseObservation> candidates;
  for (int anchor = 0; anchor < anchor_count; ++anchor) {
    const float score = value_at(anchor, 4);
    if (!std::isfinite(score) || score < score_threshold) {
      continue;
    }
    const float center_x = value_at(anchor, 0);
    const float center_y = value_at(anchor, 1);
    const float width = value_at(anchor, 2);
    const float height = value_at(anchor, 3);
    if (!std::isfinite(center_x) || !std::isfinite(center_y) || width <= 0.0F ||
        height <= 0.0F) {
      continue;
    }

    PoseObservation person{};
    person.detection_index = anchor;
    person.confidence = score;
    person.bbox = {
        restore_coordinate(center_x - width * 0.5F, transform.pad_x,
                           transform.scale,
                           static_cast<float>(transform.source_width)),
        restore_coordinate(center_y - height * 0.5F, transform.pad_y,
                           transform.scale,
                           static_cast<float>(transform.source_height)),
        restore_coordinate(center_x + width * 0.5F, transform.pad_x,
                           transform.scale,
                           static_cast<float>(transform.source_width)),
        restore_coordinate(center_y + height * 0.5F, transform.pad_y,
                           transform.scale,
                           static_cast<float>(transform.source_height)),
    };
    if (box_area(person.bbox) <= 1.0F) {
      continue;
    }

    for (std::size_t point = 0; point < kKeypointCount; ++point) {
      const int base = 5 + static_cast<int>(point) * 3;
      const float confidence = value_at(anchor, base + 2);
      auto& keypoint = person.keypoints[point];
      keypoint.confidence = confidence;
      keypoint.valid = std::isfinite(confidence) &&
                       confidence >= keypoint_threshold;
      if (keypoint.valid) {
        keypoint.x = restore_coordinate(
            value_at(anchor, base), transform.pad_x, transform.scale,
            static_cast<float>(transform.source_width));
        keypoint.y = restore_coordinate(
            value_at(anchor, base + 1), transform.pad_y, transform.scale,
            static_cast<float>(transform.source_height));
      }
    }
    candidates.push_back(person);
  }

  std::stable_sort(candidates.begin(), candidates.end(),
                   [](const PoseObservation& lhs,
                      const PoseObservation& rhs) {
                     return lhs.confidence > rhs.confidence;
                   });
  std::vector<PoseObservation> kept;
  kept.reserve(std::min<std::size_t>(candidates.size(), kMaxTracks));
  for (const auto& candidate : candidates) {
    const bool suppressed = std::any_of(
        kept.begin(), kept.end(), [&](const PoseObservation& accepted) {
          return intersection_over_union(candidate.bbox, accepted.bbox) >
                 nms_threshold;
        });
    if (!suppressed) {
      kept.push_back(candidate);
      if (kept.size() == kMaxTracks) {
        break;
      }
    }
  }
  return kept;
}

}  // namespace poseguard
