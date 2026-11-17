#include "../PoseGuardCloud/BoundedRead.h"
#include <cassert>
#include <cstring>
#include <vector>
struct Socket {
  std::vector<unsigned char> data;std::size_t offset{};bool open{true};unsigned calls{};bool stalled{},short_reads{true};
  bool connected(){return open;}
  int available(){++calls;return stalled||calls%3==0?0:int(data.size()-offset);}
  int read(unsigned char* out,unsigned length){unsigned count=short_reads?std::min(length,1U):length;std::memcpy(out,data.data()+offset,count);offset+=count;return count;}
  void stop(){open=false;}
};
int main(){
  unsigned char buffer[8]{};std::uint32_t ticks=0;unsigned waits=0;
  auto clock=[&]{return ticks;};auto wait=[&]{++ticks;++waits;};
  Socket fragmented{{0x81,126,0,4,'t','e','s','t'}};
  assert(poseguard_network::read_exact(fragmented,buffer,8,30,clock,wait)==8);assert(fragmented.open&&waits>0);assert(std::memcmp(buffer,fragmented.data.data(),8)==0);
  Socket stalled{{1,2}};stalled.stalled=true;ticks=0;waits=0;
  assert(poseguard_network::read_exact(stalled,buffer,2,20,clock,wait)==0);assert(!stalled.open&&waits==20);
  Socket partial{{0x81}};ticks=0;assert(poseguard_network::read_exact(partial,buffer,2,10,clock,wait)==0);assert(!partial.open);
  Socket wrap{{1,2}};wrap.stalled=true;ticks=UINT32_MAX-3;assert(poseguard_network::read_exact(wrap,buffer,2,10,clock,wait)==0);assert(!wrap.open);
}
