#include <iostream>
#include <string_view>

namespace {
constexpr std::string_view kVersion = "0.1.0";
}

int main(int argc, char* argv[]) {
  if (argc == 2 && std::string_view{argv[1]} == "--version") {
    std::cout << "PoseGuard RK3566 " << kVersion << '\n';
    return 0;
  }

  std::cout << "Usage: poseguard-rk3566 --version\n";
  return 0;
}
