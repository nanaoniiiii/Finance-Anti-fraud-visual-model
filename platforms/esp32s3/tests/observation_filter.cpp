// Host adapter for evaluating the shipping core on actual model observations.
// Repeated identical observations only warm up confirmation; this is not a
// camera/FPS or temporal tracking test.
#include "poseguard/core.hpp"
#include <iostream>
int main() {
  int width,height,count;
  while(std::cin>>width>>height>>count) {
    if(width<1||height<1||count<0||count>8)return 1;
    std::vector<poseguard::PoseObservation> observations(count);
    for(int i=0;i<count;++i) {
      auto& o=observations[i];o.detection_index=i;
      std::cin>>o.confidence>>o.bbox.x1>>o.bbox.y1>>o.bbox.x2>>o.bbox.y2;
      for(auto& k:o.keypoints){int valid;std::cin>>k.x>>k.y>>k.confidence>>valid;k.valid=valid;}
    }
    if(!std::cin)return 2;
    poseguard::CoreConfig cfg;cfg.frame_width=width;cfg.frame_height=height;
    cfg.missing_track_seconds=5;cfg.unconfirmed_missing_seconds=.35;
    poseguard::PoseCore core(cfg);
    std::vector<poseguard::TrackState> tracks;
    for(int i=0;i<3;++i)tracks=core.update_tracks(observations,i*.1);
    std::cout<<tracks.size();
    for(const auto& t:tracks)std::cout<<' '<<t.bbox.x1<<' '<<t.bbox.y1<<' '<<t.bbox.x2<<' '<<t.bbox.y2;
    std::cout<<'\n';
  }
}
