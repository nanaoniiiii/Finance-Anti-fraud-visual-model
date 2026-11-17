#include "PackRgb.h"
#include <array>
#include <cassert>
#include <iostream>
int main() {
  constexpr int width=6,height=4,outWidth=3,outHeight=2;
  std::array<int8_t,width*height*3> image{};
  for (int i=0;i<int(image.size());++i) image[i]=i-35;
  std::array<int8_t,outWidth*outHeight*32> packed{};
  assert(poseguard_image::pack_rgb3x3_s2(image.data(),packed.data(),width,height));
  for (int o=0;o<5;++o)
    for (int y=0;y<outHeight;++y)
      for (int x=0;x<outWidth;++x) {
        int original=0,aligned=0;
        for (int ky=0;ky<3;++ky)
          for (int kx=0;kx<3;++kx)
            for (int c=0;c<3;++c) {
              const int weight=(o*17+c*11+ky*3+kx)%7-3;
              const int sy=y*2+ky-1,sx=x*2+kx-1;
              if(sy>=0&&sy<height&&sx>=0&&sx<width)
                original+=weight*int(image[(sy*width+sx)*3+c]);
              aligned+=weight*int(packed[(y*outWidth+x)*32+(ky*3+kx)*3+c]);
            }
        assert(original==aligned);
        for(int c=27;c<32;++c)assert(packed[(y*outWidth+x)*32+c]==0);
      }
  assert(!poseguard_image::pack_rgb3x3_s2(nullptr,packed.data(),width,height));
  assert(!poseguard_image::pack_rgb3x3_s2(image.data(),packed.data(),5,height));
  std::cout<<"RGB patch packing: 30 exact convolution outputs and boundary checks passed\n";
}
