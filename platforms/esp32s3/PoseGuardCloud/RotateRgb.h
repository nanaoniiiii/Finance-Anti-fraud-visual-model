#pragma once
#include <cstdint>
#include <cstring>

namespace poseguard_image {
// Pixel layout matches the detection-coordinate inverse transform. Integer
// row strides avoid floating-point geometry for every RGB pixel.
inline bool rotate_rgb888(const std::uint8_t* source, std::uint8_t* destination,
                          int width, int height, int angle, bool mirror) {
  if (!source || !destination || width <= 0 || height <= 0 ||
      (angle != 0 && angle != 90 && angle != 180 && angle != 270)) return false;
  if (!angle && !mirror) {
    std::memcpy(destination, source, std::size_t(width) * height * 3);
    return true;
  }
  const bool swap = angle == 90 || angle == 270;
  const int outputWidth = swap ? height : width;
  const int outputHeight = swap ? width : height;
  const int first = mirror ? outputWidth - 1 : 0;
  const int direction = mirror ? -1 : 1;
  for (int y = 0; y < outputHeight; ++y) {
    int base, step;
    switch (angle) {
      case 90: base = (height - 1 - first) * width + y; step = -direction * width; break;
      case 180: base = (height - 1 - y) * width + width - 1 - first; step = -direction; break;
      case 270: base = first * width + width - 1 - y; step = direction * width; break;
      default: base = y * width + first; step = direction; break;
    }
    for (int x = 0; x < outputWidth; ++x) {
      const auto* pixel = source + std::size_t(base + x * step) * 3;
      *destination++ = pixel[0]; *destination++ = pixel[1]; *destination++ = pixel[2];
    }
  }
  return true;
}
}  // namespace poseguard_image
