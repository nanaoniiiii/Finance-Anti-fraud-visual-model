#include "../PoseGuardCloud/BoundedRead.h"
#include <cassert>
#include <cstring>
#include <string>

struct Socket {
  std::string data; std::size_t used{}; bool open{true}, zero{};
  int available() {return int(data.size()-used);}
  bool connected() {return open;}
  int read(std::uint8_t* out, std::size_t length) {
    if (zero) return 0;
    const auto count=std::min(std::size_t(1), length);
    std::memcpy(out,data.data()+used,count);used+=count;return int(count);
  }
};
int main() {
  using State=poseguard_network::BodyState;
  std::uint32_t ticks{};unsigned waits{};std::string body;
  auto now=[&]{return ticks;};auto wait=[&]{++ticks;++waits;};
  auto consume=[&](const std::uint8_t* bytes,std::size_t length,bool parse) {
    if(length)body.append(reinterpret_cast<const char*>(bytes),length);
    if(!parse)return State::waiting;
    if(body=="{}")return State::complete;
    return body.find('!')!=std::string::npos?State::invalid:State::waiting;
  };
  Socket fragmented{"{}"};
  assert(poseguard_network::read_body(fragmented,2,32,10,now,wait,consume));
  assert(body=="{}"&&waits>0);
  body.clear();ticks=0;waits=0;Socket truncated{"{"};
  assert(!poseguard_network::read_body(truncated,20,32,10,now,wait,consume));
  assert(ticks==10&&waits==10);
  body.clear();ticks=0;Socket zero{"{}"};zero.zero=true;
  assert(!poseguard_network::read_body(zero,2,32,10,now,wait,consume));assert(ticks==10);
  body.clear();ticks=0;Socket unknown{"{}"};
  assert(poseguard_network::read_body(unknown,-1,32,10,now,wait,consume));assert(unknown.open);
  body.clear();ticks=0;Socket large{"{}"};
  assert(!poseguard_network::read_body(large,1000,32,10,now,wait,consume));assert(large.used==0);
  body.clear();ticks=UINT32_MAX-3;Socket stalled{"{"};
  assert(!poseguard_network::read_body(stalled,20,32,10,now,wait,consume));assert(ticks==6);
}
