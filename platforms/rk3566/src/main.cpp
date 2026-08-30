#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

#include "poseguard/video_source.hpp"

#ifdef POSEGUARD_WITH_RKNN
#include "poseguard/rknn_pose.hpp"
#endif

namespace {
constexpr std::string_view kVersion = "0.1.0";

int parse_max_frames(int argc, char* argv[], int fallback) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (std::string_view{argv[index]} == "--max-frames") {
      const int value = std::stoi(argv[index + 1]);
      if (value <= 0) {
        throw std::invalid_argument("--max-frames must be positive");
      }
      return value;
    }
  }
  return fallback;
}

int run_input_smoke(const std::string& video_path, int max_frames) {
  poseguard::VideoSource source(
      {poseguard::VideoSourceKind::File, video_path});
  double previous_pts = -1.0;
  int empty_reads = 0;
  for (int frame_index = 0; frame_index < max_frames;) {
    poseguard::Frame frame{};
    if (!source.read(frame, 2000)) {
      if (source.end_of_stream() || ++empty_reads >= 5) {
        std::cerr << "input smoke failed after " << frame_index
                  << " frames: " << source.last_error() << '\n';
        return 1;
      }
      continue;
    }
    empty_reads = 0;
    if (frame.pts_seconds < previous_pts) {
      std::cerr << "input smoke received a decreasing PTS\n";
      return 1;
    }
    previous_pts = frame.pts_seconds;
    ++frame_index;
    std::cout << "frame=" << frame_index << " pts=" << frame.pts_seconds
              << " size=" << frame.width << 'x' << frame.height
              << " rgb_bytes=" << frame.rgb.size() << '\n';
  }
  return 0;
}
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

  if (argc >= 3 && std::string_view{argv[1]} == "--input-smoke") {
    try {
      return run_input_smoke(argv[2], parse_max_frames(argc, argv, 30));
    } catch (const std::exception& error) {
      std::cerr << "input smoke failed: " << error.what() << '\n';
      return 2;
    }
  }

  std::cout << "Usage: poseguard-rk3566 --version | --model-smoke MODEL | "
               "--input-smoke VIDEO [--max-frames N]\n";
  return argc == 1 ? 0 : 2;
}
