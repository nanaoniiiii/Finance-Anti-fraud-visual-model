#include "poseguard/types.hpp"

#include <iostream>

#define CHECK(expression)                                                     \
  do {                                                                        \
    if (!(expression)) {                                                      \
      std::cerr << "CHECK failed: " #expression << '\n';                    \
      return 1;                                                               \
    }                                                                         \
  } while (false)

int main() {
  poseguard::PoseObservation person{};
  CHECK(person.keypoints.size() == 17U);
  CHECK(poseguard::color_for(poseguard::RiskState::Normal) ==
        (poseguard::Rgb{255, 220, 0}));
  CHECK(poseguard::color_for(poseguard::RiskState::Alert) ==
        (poseguard::Rgb{255, 0, 0}));
  std::cout << "core-types-ok\n";
  return 0;
}
