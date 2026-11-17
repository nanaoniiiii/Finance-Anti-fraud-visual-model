#include "../PoseGuardCloud/ImageQuality.h"
#include <cassert>
#include <cstdio>
#include <vector>
int main() {
  using namespace poseguard_image;
  assert(!image_quality(nullptr,2,2).usable());
  std::vector<uint8_t> pixels(128*96*3,0);
  assert(image_quality(pixels.data(),128,96).state==Quality::LowLight);
  for(size_t i=0;i<pixels.size();i+=3){pixels[i]=0;pixels[i+1]=80;pixels[i+2]=0;}
  assert(image_quality(pixels.data(),128,96).state==Quality::LowLight);
  std::fill(pixels.begin(),pixels.end(),8);
  // A small indicator LED cannot turn a black frame into a useful scene.
  pixels[100]=240;
  assert(image_quality(pixels.data(),128,96).state==Quality::LowLight);
  std::fill(pixels.begin(),pixels.end(),255);
  assert(image_quality(pixels.data(),128,96).state==Quality::Overexposed);
  std::fill(pixels.begin(),pixels.end(),114);
  assert(image_quality(pixels.data(),128,96).state==Quality::LowContrast);
  // A visible subject occupying 1/8 of a dark scene must not be blanked.
  std::fill(pixels.begin(),pixels.end(),4);
  for(size_t i=0;i<pixels.size()/8;++i)pixels[i]=100;
  assert(image_quality(pixels.data(),128,96).usable());
  uint8_t one[]{0,0,0};
  assert(image_quality(one,1,1).state==Quality::LowLight);
  std::puts("image quality: 8 scenarios passed");
}
