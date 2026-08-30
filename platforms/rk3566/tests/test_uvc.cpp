#include "poseguard/video_source.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

#define CHECK(expression)                                                     \
  do {                                                                        \
    if (!(expression)) {                                                      \
      std::cerr << "CHECK failed at line " << __LINE__ << ": "             \
                << #expression << '\n';                                      \
      return 1;                                                               \
    }                                                                         \
  } while (false)

namespace {

void write_text(const std::filesystem::path& path, const std::string& text) {
  std::filesystem::create_directories(path.parent_path());
  std::ofstream stream(path);
  stream << text;
}

}  // namespace

int main() {
  const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto root = std::filesystem::temp_directory_path() /
                    ("poseguard-uvc-" + std::to_string(suffix));
  write_text(root / "video0" / "name", "rkisp_mainpath\n");
  write_text(root / "video0" / "device" / "uevent", "DRIVER=rkisp\n");
  write_text(root / "video9" / "name", "USB Camera: USB Camera\n");
  write_text(root / "video9" / "device" / "uevent", "DRIVER=uvcvideo\n");
  write_text(root / "video10" / "name", "USB Camera Metadata\n");
  write_text(root / "video10" / "device" / "uevent", "DRIVER=uvcvideo\n");

  const auto devices = poseguard::discover_uvc_devices(
      root, [](const std::string& path) { return path == "/dev/video9"; });
  std::filesystem::remove_all(root);

  CHECK(devices.size() == 1U);
  CHECK(devices[0].path == "/dev/video9");
  CHECK(devices[0].name == "USB Camera: USB Camera");
  std::cout << "uvc-discovery-ok\n";
  return 0;
}
