#pragma once
#include <algorithm>
#include <cstdint>

namespace poseguard_preview {
// Only sequence numbers and send times are retained; JPEGs are never queued.
class FrameWindow {
 public:
  static constexpr unsigned capacity=12;
  void limit(unsigned value) { limit_=std::clamp(value,1U,capacity); }
  bool available() const { return size_<limit_; }
  bool add(uint32_t sequence,uint32_t now) {
    if(!available())return false;
    sequences_[size_]=sequence;times_[size_++]=now;return true;
  }
  bool acknowledge(uint32_t sequence) {
    for(unsigned i=0;i<size_;++i)if(sequences_[i]==sequence) {
      for(unsigned j=i+1;j<size_;++j){sequences_[j-1]=sequences_[j];times_[j-1]=times_[j];}
      --size_;return true;
    }
    return false;
  }
  bool expired(uint32_t now,uint32_t timeout=8000) const {
    return size_ && uint32_t(now-times_[0])>timeout;
  }
  unsigned size() const { return size_; }
 private:
  unsigned size_{},limit_{1};
  uint32_t sequences_[capacity]{},times_[capacity]{};
};
}  // namespace poseguard_preview
