#pragma once
#include <cstdint>
#include <cstring>

namespace poseguard_image {
// Exact im2col for the first RGB 3x3/stride-2/pad-1 convolution. Five zero
// channels align each patch to 32 int8 channels for the S3 vector kernel.
inline bool pack_rgb3x3_s2(const int8_t* source, int8_t* target, int width, int height) {
  if (!source || !target || width <= 0 || height <= 0 || width%2 || height%2) return false;
  const int outWidth = width/2, outHeight = height/2;
  for (int y=0; y<outHeight; ++y)
    for (int x=0; x<outWidth; ++x) {
      auto* patch = target+(y*outWidth+x)*32;
      std::memset(patch,0,32);
      for (int ky=0; ky<3; ++ky) {
        const int sy=y*2+ky-1;
        if (sy<0 || sy>=height) continue;
        for (int kx=0; kx<3; ++kx) {
          const int sx=x*2+kx-1;
          if (sx<0 || sx>=width) continue;
          const auto* pixel = source+(sy*width+sx)*3;
          auto* cell = patch+(ky*3+kx)*3;
          cell[0]=pixel[0];cell[1]=pixel[1];cell[2]=pixel[2];
        }
      }
    }
  return true;
}
}  // namespace poseguard_image
