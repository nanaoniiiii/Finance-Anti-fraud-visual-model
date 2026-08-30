#include "poseguard/rknn_pose.hpp"

#include <cmath>
#include <iostream>
#include <vector>

#define CHECK(expression)                                                     \
  do {                                                                        \
    if (!(expression)) {                                                      \
      std::cerr << "CHECK failed at line " << __LINE__ << ": "             \
                << #expression << '\n';                                      \
      return 1;                                                               \
    }                                                                         \
  } while (false)

namespace {

constexpr int kChannels = 56;
constexpr int kAnchors = 2100;

void set_value(std::vector<float>& tensor, int channel, int anchor, float value) {
  tensor[static_cast<std::size_t>(channel) * kAnchors + anchor] = value;
}

void set_person(std::vector<float>& tensor, int anchor, float score,
                float x_shift = 0.0F) {
  set_value(tensor, 0, anchor, 160.0F + x_shift);
  set_value(tensor, 1, anchor, 160.0F);
  set_value(tensor, 2, anchor, 80.0F);
  set_value(tensor, 3, anchor, 120.0F);
  set_value(tensor, 4, anchor, score);
  for (int point = 0; point < 17; ++point) {
    const int base = 5 + point * 3;
    set_value(tensor, base, anchor, 140.0F + point + x_shift);
    set_value(tensor, base + 1, anchor, 110.0F + point * 4.0F);
    set_value(tensor, base + 2, anchor, 0.90F);
  }
}

}  // namespace

int main() {
  std::vector<float> output(static_cast<std::size_t>(kChannels) * kAnchors,
                            0.0F);
  set_person(output, 100, 0.91F);
  set_person(output, 101, 0.70F, 2.0F);

  const poseguard::Letterbox transform{0.5F, 0.0F, 40.0F, 640, 480};
  const auto people = poseguard::decode_pose(
      output, {1, kChannels, kAnchors}, transform, 0.35F, 0.25F, 0.45F);

  CHECK(people.size() == 1U);
  CHECK(people[0].keypoints.size() == 17U);
  CHECK(std::abs(people[0].bbox.x1 - 240.0F) < 1.0F);
  CHECK(std::abs(people[0].bbox.y1 - 120.0F) < 1.0F);
  CHECK(people[0].keypoints[0].valid);
  CHECK(std::abs(people[0].keypoints[0].x - 280.0F) < 1.0F);
  std::cout << "pose-decoder-ok\n";
  return 0;
}
