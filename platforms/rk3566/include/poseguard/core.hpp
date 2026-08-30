#pragma once

#include "poseguard/types.hpp"

#include <array>
#include <optional>
#include <unordered_map>
#include <vector>

namespace poseguard {

struct CoreConfig {
  int frame_width{640};
  int frame_height{480};
  int minimum_valid_keypoints{6};
  int minimum_torso_keypoints{3};
  float minimum_bbox_area_ratio{0.015F};
  float maximum_bbox_area_ratio{0.75F};
  float duplicate_iou_threshold{0.45F};
  float duplicate_keypoint_distance_ratio{0.05F};
  float maximum_match_cost{1.15F};
  float smoothing_alpha{0.55F};
  int confirmation_frames{3};
  double missing_track_seconds{1.5};
  float phone_wrist_ear_height_ratio{0.13F};
  double phone_alert_seconds{1.0};
  double multi_person_alert_seconds{1.5};
  float lingering_center_speed_ratio{0.12F};
  float lingering_pose_motion_ratio{0.04F};
  double lingering_alert_seconds{20.0};
  double alert_release_seconds{0.8};
};

class PoseCore {
 public:
  explicit PoseCore(CoreConfig config = {});

  std::vector<TrackState> update_tracks(
      const std::vector<PoseObservation>& observations, double timestamp);
  std::vector<RiskDecision> evaluate(const std::vector<TrackState>& tracks,
                                     int width, int height,
                                     double timestamp);

 private:
  struct EvidenceMemory {
    double active_seconds{};
    double last_evidence_seconds{};
    double last_positive_seconds{};
    RiskState state{RiskState::Normal};
    bool has_last_evidence{};
  };

  std::vector<PoseObservation> filter_and_deduplicate(
      const std::vector<PoseObservation>& observations) const;
  RiskState update_evidence(EvidenceMemory& memory, bool condition,
                            bool observed, double timestamp,
                            double alert_after_seconds);
  bool is_phone_to_ear(const TrackState& track) const;

  CoreConfig config_{};
  std::array<std::optional<TrackState>, kMaxTracks> tracks_{};
  std::unordered_map<int, EvidenceMemory> phone_memory_{};
  std::unordered_map<int, EvidenceMemory> lingering_memory_{};
  EvidenceMemory multi_person_memory_{};
  int next_track_id_{1};
};

}  // namespace poseguard
