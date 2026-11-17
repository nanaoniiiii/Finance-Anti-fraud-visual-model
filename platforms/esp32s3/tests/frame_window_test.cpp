#include "FrameWindow.h"
#include <cassert>
#include <iostream>
int main() {
  using poseguard_preview::FrameWindow;
  FrameWindow window;
  assert(window.add(1,100)&&!window.available());
  assert(!window.acknowledge(9)&&window.size()==1);
  window.limit(99);
  for(unsigned i=2;i<=12;++i)assert(window.add(i,i*100));
  assert(!window.add(13,1300));
  assert(window.acknowledge(8)&&window.size()==11&&window.available());
  assert(!window.acknowledge(8)&&window.size()==11);
  assert(window.add(13,1300));
  assert(!window.expired(8100)&&window.expired(8101));
  assert(window.acknowledge(1)&&!window.expired(8101));
  window.limit(1);assert(!window.available());
  for(unsigned i=2;i<=13;++i)window.acknowledge(i);
  assert(window.size()==0&&window.available());
  assert(window.add(14,0xfffffff0U));
  assert(!window.expired(0x10U,32)&&window.expired(0x11U,32));
  std::cout<<"Frame credits, out-of-order ACK, bounds, shrinking and clock wrap passed\n";
}
