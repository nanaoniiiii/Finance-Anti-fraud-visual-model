#include <iostream>
#include <string_view>

#ifdef POSEGUARD_WITH_RKNN
#include "poseguard/rknn_pose.hpp"
#endif

namespace {
constexpr std::string_view kVersion = "0.1.0";
}

int main(int argc, char* argv[]) {
  if (argc == 2 && std::string_view{argv[1]} == "--version") {
    std::cout << "PoseGuard RK3566 " << kVersion << '\n';
    return 0;
  }

  if (argc == 3 && std::string_view{argv[1]} == "--model-smoke") {
#ifdef POSEGUARD_WITH_RKNN
    try {
      poseguard::RknnPoseEngine engine(argv[2]);
      poseguard::Frame frame{};
      frame.width = 320;
      frame.height = 320;
      frame.rgb.assign(320U * 320U * 3U, 128U);
      poseguard::Metrics metrics{};
      const auto people = engine.infer(frame, metrics);
      const auto shape = engine.output_shape();
      std::cout << "runtime=" << engine.runtime_version() << '\n'
                << "driver=" << engine.driver_version() << '\n'
                << "output=[" << shape[0] << ',' << shape[1] << ','
                << shape[2] << "]\n"
                << "inference_ms=" << metrics.inference_ms << '\n'
                << "people=" << people.size() << '\n';
      return 0;
    } catch (const std::exception& error) {
      std::cerr << "model smoke failed: " << error.what() << '\n';
      return 1;
    }
#else
    std::cerr << "RKNN support is not enabled in this build\n";
    return 2;
#endif
  }

  std::cout << "Usage: poseguard-rk3566 --version | --model-smoke MODEL\n";
  return argc == 1 ? 0 : 2;
}
