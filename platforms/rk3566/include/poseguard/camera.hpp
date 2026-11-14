#pragma once
#include <functional>
#include <string>
#include <vector>

#include "poseguard/types.hpp"

namespace poseguard {
Frame rotate_frame(const Frame& frame, int degrees, bool mirror = false);
double orientation_score(const std::vector<PoseObservation>& people);
struct OrientedFrame {
  Frame frame;
  std::vector<PoseObservation> observations;
  int rotation{};
  bool changed{};
};
class CameraOrientation {
 public:
  using Infer =
      std::function<std::vector<PoseObservation>(const Frame&, Metrics&)>;
  void configure(const std::string& rotation, bool mirror);
  void seed(int rotation);
  OrientedFrame process(Frame frame, double now, Metrics& metrics,
                        const Infer& infer);
  int rotation() const { return rotation_; }
  bool mirror() const { return mirror_; }
  const std::string& mode() const { return mode_; }

 private:
  std::string mode_{"auto"};
  int rotation_{};
  bool mirror_{};
  bool pending_change_{};
  bool locked_{};
  int candidate_{};
  unsigned agreement_{};
  double probe_at_{};
  double last_person_{};
};
}  // namespace poseguard
