#pragma once
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace poseguard_image {
struct Quality {
  enum State { Usable, LowLight, Overexposed, LowContrast, Invalid } state{Invalid};
  float mean{}, deviation{};
  bool usable() const { return state == Usable; }
  const char* name() const {
    return state == Usable ? "usable" : state == LowLight ? "low_light" :
           state == Overexposed ? "overexposed" : state == LowContrast ? "low_contrast" : "unavailable";
  }
};
// A small, evenly distributed sample of the decoded source, before rotation.
// Reject only nearly black/white frames with little useful contrast. A dark
// background containing a visible subject remains eligible for inference.
inline Quality image_quality(const uint8_t* rgb, int width, int height) {
  Quality q;
  if (!rgb || width <= 0 || height <= 0) return q;
  uint64_t sum = 0, squares = 0;
  constexpr unsigned side = 32, count = side * side;
  for (unsigned y = 0; y < side; ++y)
    for (unsigned x = 0; x < side; ++x) {
      const size_t px = (uint64_t(2*x+1)*width)/(2*side),
                   py = (uint64_t(2*y+1)*height)/(2*side);
      const auto* p = rgb + (py*width + px)*3;
      const unsigned luma = (unsigned(p[0])+2*unsigned(p[1])+p[2])/4;
      sum += luma; squares += luma*luma;
    }
  q.mean = float(sum)/count;
  q.deviation = std::sqrt(std::fmax(0.f,float(squares)/count-q.mean*q.mean));
  // Camera auto-gain can lift a covered/dark sensor to dark green/grey noise.
  // Both low luminance and low scene contrast are required for this gate.
  q.state = q.mean < 60 && q.deviation < 16 ? Quality::LowLight :
            q.mean > 247 && q.deviation < 8 ? Quality::Overexposed :
            q.deviation < 8 ? Quality::LowContrast : Quality::Usable;
  return q;
}
}
