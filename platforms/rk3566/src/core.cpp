#include "poseguard/core.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_set>

namespace poseguard {
namespace {

constexpr std::array<std::size_t, 4> kTorsoPoints{5, 6, 11, 12};

float box_width(const BBox& box) { return std::max(0.0F, box.x2 - box.x1); }

float box_height(const BBox& box) { return std::max(0.0F, box.y2 - box.y1); }

float box_area(const BBox& box) { return box_width(box) * box_height(box); }

Point box_center(const BBox& box) {
  return {(box.x1 + box.x2) * 0.5F, (box.y1 + box.y2) * 0.5F};
}

float point_distance(Point lhs, Point rhs) {
  return std::hypot(lhs.x - rhs.x, lhs.y - rhs.y);
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

float shared_keypoint_distance(
    const std::array<Keypoint, kKeypointCount>& lhs,
    const std::array<Keypoint, kKeypointCount>& rhs, float scale) {
  float total = 0.0F;
  std::size_t count = 0;
  for (std::size_t index = 0; index < kKeypointCount; ++index) {
    if (!lhs[index].valid || !rhs[index].valid) {
      continue;
    }
    total += std::hypot(lhs[index].x - rhs[index].x,
                        lhs[index].y - rhs[index].y);
    ++count;
  }
  if (count == 0 || scale <= 0.0F) {
    return std::numeric_limits<float>::infinity();
  }
  return total / static_cast<float>(count) / scale;
}

float upper_quartile_motion(
    const std::array<Keypoint, kKeypointCount>& previous,
    const std::array<Keypoint, kKeypointCount>& current, float scale) {
  std::vector<float> distances;
  distances.reserve(kKeypointCount);
  for (std::size_t index = 0; index < kKeypointCount; ++index) {
    if (previous[index].valid && current[index].valid) {
      distances.push_back(std::hypot(previous[index].x - current[index].x,
                                     previous[index].y - current[index].y));
    }
  }
  if (distances.empty() || scale <= 0.0F) {
    return 0.0F;
  }
  std::sort(distances.begin(), distances.end(), std::greater<float>());
  const std::size_t sample_count = std::max<std::size_t>(1, distances.size() / 4);
  float total = 0.0F;
  for (std::size_t index = 0; index < sample_count; ++index) {
    total += distances[index];
  }
  return total / static_cast<float>(sample_count) / scale;
}

float lerp(float previous, float current, float alpha) {
  return previous + alpha * (current - previous);
}

BBox smooth_box(const BBox& previous, const BBox& current, float alpha) {
  return {lerp(previous.x1, current.x1, alpha),
          lerp(previous.y1, current.y1, alpha),
          lerp(previous.x2, current.x2, alpha),
          lerp(previous.y2, current.y2, alpha)};
}

bool point_in_frame(Point point, int width, int height) {
  return point.x >= 0.0F && point.y >= 0.0F && point.x < width &&
         point.y < height;
}

}  // namespace

PoseCore::PoseCore(CoreConfig config) : config_(config) {}

std::vector<PoseObservation> PoseCore::filter_and_deduplicate(
    const std::vector<PoseObservation>& observations) const {
  const float frame_area = static_cast<float>(config_.frame_width) *
                           static_cast<float>(config_.frame_height);
  std::vector<PoseObservation> candidates;
  candidates.reserve(observations.size());

  for (const auto& observation : observations) {
    int valid_count = 0;
    int torso_count = 0;
    for (const auto& point : observation.keypoints) {
      valid_count += point.valid ? 1 : 0;
    }
    for (const auto index : kTorsoPoints) {
      torso_count += observation.keypoints[index].valid ? 1 : 0;
    }
    const float area_ratio =
        frame_area > 0.0F ? box_area(observation.bbox) / frame_area : 0.0F;
    if (valid_count < config_.minimum_valid_keypoints ||
        torso_count < config_.minimum_torso_keypoints ||
        area_ratio < config_.minimum_bbox_area_ratio ||
        area_ratio > config_.maximum_bbox_area_ratio) {
      continue;
    }
    candidates.push_back(observation);
  }

  std::stable_sort(candidates.begin(), candidates.end(),
                   [](const PoseObservation& lhs,
                      const PoseObservation& rhs) {
                     return lhs.confidence > rhs.confidence;
                   });

  std::vector<PoseObservation> kept;
  kept.reserve(candidates.size());
  for (const auto& candidate : candidates) {
    bool duplicate = false;
    for (const auto& accepted : kept) {
      const float scale =
          std::max(box_height(candidate.bbox), box_height(accepted.bbox));
      if (intersection_over_union(candidate.bbox, accepted.bbox) >=
              config_.duplicate_iou_threshold &&
          shared_keypoint_distance(candidate.keypoints, accepted.keypoints,
                                   scale) <=
              config_.duplicate_keypoint_distance_ratio) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      kept.push_back(candidate);
    }
  }
  return kept;
}

std::vector<TrackState> PoseCore::update_tracks(
    const std::vector<PoseObservation>& observations, double timestamp) {
  const auto filtered = filter_and_deduplicate(observations);

  for (auto& slot : tracks_) {
    if (slot && timestamp - slot->last_seen_seconds >
                    config_.missing_track_seconds) {
      slot.reset();
    }
  }

  struct MatchCandidate {
    float cost{};
    std::size_t slot{};
    std::size_t observation{};
  };
  std::vector<MatchCandidate> matches;

  for (std::size_t slot_index = 0; slot_index < tracks_.size(); ++slot_index) {
    if (!tracks_[slot_index]) {
      continue;
    }
    const auto& track = *tracks_[slot_index];
    for (std::size_t observation_index = 0;
         observation_index < filtered.size(); ++observation_index) {
      const auto& observation = filtered[observation_index];
      const float scale = std::max(
          1.0F, std::max(box_height(track.bbox), box_height(observation.bbox)));
      const float center_cost =
          point_distance(track.center, box_center(observation.bbox)) / scale;
      const float old_area = std::max(1.0F, box_area(track.bbox));
      const float new_area = std::max(1.0F, box_area(observation.bbox));
      const float area_cost = std::abs(std::log(new_area / old_area));
      float pose_cost = shared_keypoint_distance(
          track.keypoints, observation.keypoints, scale);
      if (!std::isfinite(pose_cost)) {
        pose_cost = 0.5F;
      }
      const float cost = 0.60F * center_cost +
                         0.20F * std::min(area_cost, 2.0F) +
                         0.40F * std::min(pose_cost, 2.0F);
      if (cost <= config_.maximum_match_cost) {
        matches.push_back({cost, slot_index, observation_index});
      }
    }
  }

  std::sort(matches.begin(), matches.end(),
            [](const MatchCandidate& lhs, const MatchCandidate& rhs) {
              return lhs.cost < rhs.cost;
            });
  std::array<bool, kMaxTracks> matched_slots{};
  std::vector<bool> matched_observations(filtered.size(), false);

  for (const auto& match : matches) {
    if (matched_slots[match.slot] ||
        matched_observations[match.observation]) {
      continue;
    }
    auto& track = *tracks_[match.slot];
    const auto& observation = filtered[match.observation];
    const auto previous = track;
    const double elapsed = timestamp - previous.last_seen_seconds;
    const float scale = std::max(
        1.0F, std::max(box_height(previous.bbox), box_height(observation.bbox)));
    const Point measured_center = box_center(observation.bbox);

    track.normalized_center_speed =
        elapsed > 0.0
            ? point_distance(previous.center, measured_center) / scale /
                  static_cast<float>(elapsed)
            : 0.0F;
    track.pose_motion = upper_quartile_motion(
        previous.keypoints, observation.keypoints, scale);
    track.bbox = smooth_box(previous.bbox, observation.bbox,
                            config_.smoothing_alpha);
    track.center = box_center(track.bbox);
    track.confidence = observation.confidence;
    for (std::size_t index = 0; index < kKeypointCount; ++index) {
      const auto& measured = observation.keypoints[index];
      auto& smoothed = track.keypoints[index];
      if (measured.valid && smoothed.valid) {
        smoothed.x = lerp(smoothed.x, measured.x, config_.smoothing_alpha);
        smoothed.y = lerp(smoothed.y, measured.y, config_.smoothing_alpha);
        smoothed.confidence = measured.confidence;
      } else if (measured.valid) {
        smoothed = measured;
      } else {
        smoothed.valid = false;
      }
    }
    track.last_seen_seconds = timestamp;
    ++track.visible_frames;
    track.confirmed = track.visible_frames >= config_.confirmation_frames;
    track.predicted = false;
    matched_slots[match.slot] = true;
    matched_observations[match.observation] = true;
  }

  for (std::size_t slot_index = 0; slot_index < tracks_.size(); ++slot_index) {
    if (tracks_[slot_index] && !matched_slots[slot_index]) {
      tracks_[slot_index]->predicted = true;
      tracks_[slot_index]->normalized_center_speed = 0.0F;
      tracks_[slot_index]->pose_motion = 0.0F;
    }
  }

  for (std::size_t observation_index = 0;
       observation_index < filtered.size(); ++observation_index) {
    if (matched_observations[observation_index]) {
      continue;
    }
    auto empty_slot = std::find_if(
        tracks_.begin(), tracks_.end(),
        [](const std::optional<TrackState>& slot) { return !slot.has_value(); });
    if (empty_slot == tracks_.end()) {
      break;
    }
    const auto& observation = filtered[observation_index];
    TrackState track{};
    track.track_id = next_track_id_++;
    track.bbox = observation.bbox;
    track.confidence = observation.confidence;
    track.keypoints = observation.keypoints;
    track.center = box_center(track.bbox);
    track.first_seen_seconds = timestamp;
    track.last_seen_seconds = timestamp;
    track.visible_frames = 1;
    track.confirmed = config_.confirmation_frames <= 1;
    *empty_slot = track;
  }

  std::vector<TrackState> result;
  for (const auto& slot : tracks_) {
    if (slot) {
      result.push_back(*slot);
    }
  }
  std::sort(result.begin(), result.end(),
            [](const TrackState& lhs, const TrackState& rhs) {
              return lhs.track_id < rhs.track_id;
            });
  return result;
}

RiskState PoseCore::update_evidence(EvidenceMemory& memory, bool condition,
                                    bool observed, double timestamp,
                                    double alert_after_seconds) {
  if (!observed) {
    memory.has_last_evidence = false;
    if (memory.state == RiskState::Alert &&
        timestamp - memory.last_positive_seconds >
            config_.alert_release_seconds) {
      memory.state = RiskState::Normal;
      memory.active_seconds = 0.0;
    }
    return memory.state;
  }

  if (condition) {
    if (memory.has_last_evidence) {
      memory.active_seconds +=
          std::max(0.0, timestamp - memory.last_evidence_seconds);
    }
    memory.last_evidence_seconds = timestamp;
    memory.last_positive_seconds = timestamp;
    memory.has_last_evidence = true;
    memory.state = memory.active_seconds >= alert_after_seconds
                       ? RiskState::Alert
                       : RiskState::Candidate;
    return memory.state;
  }

  memory.has_last_evidence = false;
  memory.active_seconds = 0.0;
  if (memory.state == RiskState::Alert &&
      timestamp - memory.last_positive_seconds <=
          config_.alert_release_seconds) {
    return RiskState::Alert;
  }
  memory.state = RiskState::Normal;
  return memory.state;
}

bool PoseCore::is_phone_to_ear(const TrackState& track) const {
  const float height = box_height(track.bbox);
  const float width = box_width(track.bbox);
  if (height <= 0.0F || height < width * 1.35F) {
    return false;
  }

  const auto side_matches = [&](std::size_t ear, std::size_t shoulder,
                                std::size_t elbow, std::size_t wrist,
                                std::size_t hip, std::size_t ankle) {
    const auto& ear_point = track.keypoints[ear];
    const auto& shoulder_point = track.keypoints[shoulder];
    const auto& elbow_point = track.keypoints[elbow];
    const auto& wrist_point = track.keypoints[wrist];
    const auto& hip_point = track.keypoints[hip];
    const auto& ankle_point = track.keypoints[ankle];
    if (!ear_point.valid || !shoulder_point.valid || !elbow_point.valid ||
        !wrist_point.valid || !hip_point.valid || !ankle_point.valid) {
      return false;
    }
    const bool upright = shoulder_point.y < hip_point.y &&
                         hip_point.y < ankle_point.y;
    const float wrist_to_ear =
        std::hypot(wrist_point.x - ear_point.x, wrist_point.y - ear_point.y);
    return upright &&
           wrist_to_ear <= height * config_.phone_wrist_ear_height_ratio;
  };

  return side_matches(3, 5, 7, 9, 11, 15) ||
         side_matches(4, 6, 8, 10, 12, 16);
}

std::vector<RiskDecision> PoseCore::evaluate(
    const std::vector<TrackState>& tracks, int width, int height,
    double timestamp) {
  std::unordered_set<int> live_ids;
  std::vector<const TrackState*> confirmed;
  std::size_t observed_people = 0;
  for (const auto& track : tracks) {
    live_ids.insert(track.track_id);
    if (!track.confirmed || !point_in_frame(track.center, width, height)) {
      continue;
    }
    confirmed.push_back(&track);
    if (!track.predicted) {
      ++observed_people;
    }
  }

  const bool has_observed_track = observed_people > 0;
  const RiskState multi_state = update_evidence(
      multi_person_memory_, observed_people >= 2, has_observed_track, timestamp,
      config_.multi_person_alert_seconds);

  std::vector<RiskDecision> decisions;
  decisions.reserve(confirmed.size() * 3);
  for (const auto* track : confirmed) {
    const bool observed = !track->predicted;
    const RiskState phone_state = update_evidence(
        phone_memory_[track->track_id], observed && is_phone_to_ear(*track),
        observed, timestamp, config_.phone_alert_seconds);
    const bool still = observed &&
                       track->normalized_center_speed <=
                           config_.lingering_center_speed_ratio &&
                       track->pose_motion <=
                           config_.lingering_pose_motion_ratio;
    const RiskState lingering_state = update_evidence(
        lingering_memory_[track->track_id], still, observed, timestamp,
        config_.lingering_alert_seconds);

    decisions.push_back({track->track_id, RiskKind::PhoneToEar, phone_state,
                         phone_memory_[track->track_id].active_seconds,
                         track->bbox});
    decisions.push_back({track->track_id, RiskKind::MultiPerson, multi_state,
                         multi_person_memory_.active_seconds, track->bbox});
    decisions.push_back({track->track_id, RiskKind::Lingering, lingering_state,
                         lingering_memory_[track->track_id].active_seconds,
                         track->bbox});
  }

  for (auto iterator = phone_memory_.begin(); iterator != phone_memory_.end();) {
    if (live_ids.count(iterator->first) == 0) {
      iterator = phone_memory_.erase(iterator);
    } else {
      ++iterator;
    }
  }
  for (auto iterator = lingering_memory_.begin();
       iterator != lingering_memory_.end();) {
    if (live_ids.count(iterator->first) == 0) {
      iterator = lingering_memory_.erase(iterator);
    } else {
      ++iterator;
    }
  }
  return decisions;
}

}  // namespace poseguard
