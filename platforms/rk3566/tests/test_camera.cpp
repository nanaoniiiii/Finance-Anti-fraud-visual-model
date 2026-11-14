#include <cassert>
#include <chrono>
#include <iostream>
#include <stdexcept>

#include "poseguard/camera.hpp"
#include "poseguard/preview.hpp"

using namespace poseguard;
PoseObservation upright() {
  PoseObservation p;
  p.confidence = .9;
  p.bbox = {0, 0, 200, 400};
  for (auto& k : p.keypoints) k = {100, 200, .8F, true};
  p.keypoints[0].y = 30;
  p.keypoints[5].y = p.keypoints[6].y = 100;
  p.keypoints[11].y = p.keypoints[12].y = 250;
  return p;
}
int main() {
  Frame f;
  f.width = 3;
  f.height = 2;
  f.rgb = {1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0, 6, 0, 0};
  auto inverse = rotate_frame(f, 180);
  assert(inverse.rgb[0] == 6 && inverse.rgb[15] == 1);
  auto right = rotate_frame(f, 90);
  assert(right.width == 2 && right.height == 3 && right.rgb[0] == 4 &&
         right.rgb[3] == 1);
  auto left = rotate_frame(right, 270);
  assert(left.rgb == f.rgb);
  auto mirrored = rotate_frame(f, 0, true);
  assert(mirrored.rgb[0] == 3 && mirrored.rgb[6] == 1);
  CameraOrientation orientation;
  Metrics timing;
  unsigned calls = 0;
  auto result = orientation.process(
      inverse, 0, timing, [&](const Frame& image, Metrics& m) {
        ++calls;
        m.inference_ms = 1;
        return image.width == 3 && image.rgb[0] == 1
                   ? std::vector<PoseObservation>{upright()}
                   : std::vector<PoseObservation>{};
      });
  assert(result.rotation == 180 && result.frame.rgb == f.rgb && result.changed);
  assert(calls == 4 && timing.inference_ms == 4);
  orientation.configure("90", true);
  result = orientation.process(f, 1, timing, [](const Frame&, Metrics&) {
    return std::vector<PoseObservation>{};
  });
  assert(result.rotation == 90 && result.frame.width == 2 && result.changed);
  PreviewStream preview("", {});
  assert(!preview.active() && preview.latest(0, "").empty());
  preview.control(
      preview_query("/preview/"
                    "control?active=1&fps=3&long_side=424&quality=45&rotation="
                    "180&version=1"));
  assert(preview.active() && preview.camera().rotation == "180");
  preview.applied(1, 180, false, true);
  assert(preview.status().find("\"camera_applied_version\":1") !=
         std::string::npos);
  preview.control({{"active", "0"}});
  assert(!preview.active());
  bool rejected = false;
  try {
    preview.control({{"fps", "999"}});
  } catch (const std::exception&) {
    rejected = true;
  }
  assert(rejected);
  std::cout << "camera direction, inference probe accounting and preview "
               "controls passed\n";
}
