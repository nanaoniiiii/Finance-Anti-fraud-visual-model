#include "poseguard/camera.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace poseguard {
namespace {
bool valid_rotation(int value) {
  return value == 0 || value == 90 || value == 180 || value == 270;
}
bool visible(const Keypoint &point) {
  return point.valid && point.confidence >= .2F;
}
} // namespace

Frame rotate_frame(const Frame &input, int degrees, bool mirror) {
  if (!valid_rotation(degrees) || input.width <= 0 || input.height <= 0 ||
      input.rgb.size() !=
          static_cast<std::size_t>(input.width) * input.height * 3U)
    throw std::invalid_argument("invalid camera frame or rotation");
  Frame out;
  out.width = degrees == 90 || degrees == 270 ? input.height : input.width;
  out.height = degrees == 90 || degrees == 270 ? input.width : input.height;
  out.pts_seconds = input.pts_seconds;
  out.timeline_seconds = input.timeline_seconds;
  out.rgb.resize(input.rgb.size());
  for (int y = 0; y < input.height; ++y)
    for (int x = 0; x < input.width; ++x) {
      int dx = x, dy = y;
      if (degrees == 90) {
        dx = input.height - y - 1;
        dy = x;
      } else if (degrees == 180) {
        dx = input.width - x - 1;
        dy = input.height - y - 1;
      } else if (degrees == 270) {
        dx = y;
        dy = input.width - x - 1;
      }
      if (mirror)
        dx = out.width - dx - 1;
      std::copy_n(input.rgb.data() +
                      (static_cast<std::size_t>(y) * input.width + x) * 3,
                  3,
                  out.rgb.data() +
                      (static_cast<std::size_t>(dy) * out.width + dx) * 3);
    }
  return out;
}

double orientation_score(const std::vector<PoseObservation> &people) {
  double best = 0;
  for (const auto &person : people) {
    if (person.confidence < .25F)
      continue;
    unsigned count = 0;
    double confidence = 0;
    for (const auto &p : person.keypoints)
      if (visible(p)) {
        ++count;
        confidence += p.confidence;
      }
    if (count < 3)
      continue;
    double score =
        person.confidence * .8 + confidence / count * .3 + count * .025;
    const auto &p = person.keypoints;
    const float h = std::max(1.F, person.bbox.y2 - person.bbox.y1);
    if (visible(p[1]) && visible(p[2]) && p[1].confidence >= .5F &&
        p[2].confidence >= .5F) {
      const float span = std::hypot(p[1].x - p[2].x, p[1].y - p[2].y);
      if (span > h * .015F) {
        const float horizontal = std::abs(p[1].x - p[2].x) / span;
        score += horizontal;
        if (horizontal < .5F)
          score -= 1.0;
      }
    }
    if (visible(p[5]) && visible(p[6])) {
      const float shoulder = (p[5].y + p[6].y) * .5F;
      const float shoulder_x = (p[5].x + p[6].x) * .5F;
      // Partial bodies often have no hips. A sideways head can still lie a few
      // pixels above its shoulders, so test the direction of the neck vector
      // instead of only its sign. Use shoulder alignment as weaker evidence.
      if (visible(p[0])) {
        const float dx = shoulder_x - p[0].x;
        const float dy = shoulder - p[0].y;
        const float distance = std::hypot(dx, dy);
        if (distance > h * .04F) {
          const float upright = dy / distance;
          score += 1.8 * upright;
          if (upright < .4F)
            score -= 1.0;
        }
      }
      const float shoulder_distance =
          std::hypot(p[5].x - p[6].x, p[5].y - p[6].y);
      if (shoulder_distance > h * .05F)
        score += .45 * std::abs(p[5].x - p[6].x) / shoulder_distance;
      if (visible(p[11]) && visible(p[12])) {
        const float hips = (p[11].y + p[12].y) * .5F;
        score += shoulder < hips - h * .06F ? .8 : -.8;
      }
    }
    best = std::max(best, score);
  }
  return std::max(0.0, best);
}

void CameraOrientation::configure(const std::string &mode, bool mirror) {
  if (mode != "auto" && mode != "0" && mode != "90" && mode != "180" &&
      mode != "270")
    throw std::invalid_argument(
        "camera rotation must be auto, 0, 90, 180 or 270");
  const int next = mode == "auto" ? rotation_ : std::stoi(mode);
  pending_change_ = pending_change_ || next != rotation_ || mirror != mirror_;
  rotation_ = next;
  mirror_ = mirror;
  mode_ = mode;
  locked_ = mode != "auto";
  agreement_ = 0;
  probe_at_ = 0;
  last_person_ = 0;
}
void CameraOrientation::seed(int value) {
  if (valid_rotation(value) && mode_ == "auto")
    rotation_ = value;
}

OrientedFrame CameraOrientation::process(Frame raw, double now,
                                         Metrics &metrics, const Infer &infer) {
  OrientedFrame result;
  result.frame =
      rotation_ == 0 && !mirror_ ? raw : rotate_frame(raw, rotation_, mirror_);
  Metrics work{};
  result.observations = infer(result.frame, work);
  double total_ms = work.inference_ms;
  const double current = orientation_score(result.observations);
  if (current > .6)
    last_person_ = now;
  if (mode_ == "auto" && locked_ && now - last_person_ > 10)
    locked_ = false;
  if (mode_ == "auto" && now >= probe_at_) {
    // Recheck even while a person remains visible. Otherwise a camera that is
    // moved during use, or an early wrong lock, never recovers.
    probe_at_ = now + (locked_ ? 5.0 : result.observations.empty() ? 2.0 : .6);
    double best = current;
    int best_rotation = rotation_;
    Frame best_frame;
    std::vector<PoseObservation> best_people;
    for (const int value : {0, 180, 90, 270}) {
      if (value == rotation_)
        continue;
      Frame candidate = rotate_frame(raw, value, mirror_);
      Metrics probe{};
      auto observations = infer(candidate, probe);
      total_ms += probe.inference_ms;
      const double score = orientation_score(observations);
      if (score > best) {
        best = score;
        best_rotation = value;
        best_frame = std::move(candidate);
        best_people = std::move(observations);
      }
    }
    if (best_rotation != rotation_ && best > 1.0 &&
        best > current * 1.2 + .12) {
      agreement_ = candidate_ == best_rotation ? agreement_ + 1 : 1;
      candidate_ = best_rotation;
      if (agreement_ >= 2 || (current < .3 && best > 1.4)) {
        rotation_ = best_rotation;
        result.frame = std::move(best_frame);
        result.observations = std::move(best_people);
        pending_change_ = true;
        locked_ = true;
        last_person_ = now;
      }
    } else if (current > 1.0) {
      agreement_ = candidate_ == rotation_ ? agreement_ + 1 : 1;
      candidate_ = rotation_;
      if (agreement_ >= 2)
        locked_ = true;
    }
  }
  metrics.inference_ms = total_ms;
  result.rotation = rotation_;
  result.changed = std::exchange(pending_change_, false);
  return result;
}
} // namespace poseguard
