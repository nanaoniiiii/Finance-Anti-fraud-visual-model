#include "../PoseGuardCloud/RotateRgb.h"
#include <array>
#include <cassert>

int main() {
  std::array<std::uint8_t,18> input{};
  for (unsigned i=0;i<6;i++) {input[i*3]=i;input[i*3+1]=i+10;input[i*3+2]=i+20;}
  const auto original=input;
  const std::array<std::array<unsigned,6>,8> expected{{
    {{0,1,2,3,4,5}},{{2,1,0,5,4,3}},
    {{3,0,4,1,5,2}},{{0,3,1,4,2,5}},
    {{5,4,3,2,1,0}},{{3,4,5,0,1,2}},
    {{2,5,1,4,0,3}},{{5,2,4,1,3,0}}
  }};
  const int angles[]={0,90,180,270};
  for(unsigned a=0;a<4;a++)for(unsigned mirror=0;mirror<2;mirror++) {
    std::array<std::uint8_t,18> output{};
    assert(poseguard_image::rotate_rgb888(input.data(),output.data(),3,2,angles[a],mirror));
    for(unsigned i=0;i<6;i++)for(unsigned channel=0;channel<3;channel++)
      assert(output[i*3+channel]==input[expected[a*2+mirror][i]*3+channel]);
    assert(input==original);
  }
  std::array<std::uint8_t,18> untouched{};
  assert(!poseguard_image::rotate_rgb888(input.data(),untouched.data(),3,2,45,false));
  assert(!poseguard_image::rotate_rgb888(input.data(),untouched.data(),0,2,0,false));
}
