#include "poseguard/runtime.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#define CHECK(expression)                                                     \
  do {                                                                        \
    if (!(expression)) {                                                      \
      std::cerr << "CHECK failed at line " << __LINE__ << ": "             \
                << #expression << '\n';                                      \
      return 1;                                                               \
    }                                                                         \
  } while (false)

int main() {
  poseguard::Frame frame{};
  frame.width = 100;
  frame.height = 100;
  frame.rgb.assign(100U * 100U * 3U, 0U);

  poseguard::TrackState track{};
  track.track_id = 7;
  track.bbox = {20.0F, 20.0F, 80.0F, 90.0F};
  track.confirmed = true;
  poseguard::RiskDecision alert{7, poseguard::RiskKind::PhoneToEar,
                                poseguard::RiskState::Alert, 1.2,
                                track.bbox};
  const poseguard::Metrics metrics{1, 18.5, 22.0, 25.0, 1};
  const auto canvas = poseguard::draw_overlay(frame, {track}, {alert}, metrics);
  const std::size_t red_pixel = (20U * 100U + 20U) * 3U;
  CHECK(canvas.rgb[red_pixel] == 255U);
  CHECK(canvas.rgb[red_pixel + 1U] == 0U);
  CHECK(canvas.rgb[red_pixel + 2U] == 0U);

  const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto directory = std::filesystem::temp_directory_path() /
                         ("poseguard-runtime-" + std::to_string(nonce));
  std::filesystem::create_directories(directory);
  const auto event_path = directory / "events.jsonl";
  {
    poseguard::EventJournal journal(event_path.string());
    auto candidate = alert;
    candidate.state = poseguard::RiskState::Candidate;
    candidate.duration_seconds = 0.2;
    journal.publish({candidate}, 0.2, metrics);
    journal.publish({candidate}, 0.3, metrics);
    journal.publish({alert}, 1.2, metrics);
    auto normal = alert;
    normal.state = poseguard::RiskState::Normal;
    journal.publish({normal}, 2.1, metrics);
  }

  std::ifstream stream(event_path);
  std::ostringstream content;
  content << stream.rdbuf();
  const std::string jsonl = content.str();
  CHECK(jsonl.find("\"state\":\"candidate\"") != std::string::npos);
  CHECK(jsonl.find("\"state\":\"alert\"") != std::string::npos);
  CHECK(jsonl.find("\"state\":\"clear\"") != std::string::npos);
  CHECK(jsonl.find("\"image\"") == std::string::npos);
  CHECK(jsonl.find("\"keypoints\"") == std::string::npos);
  CHECK(static_cast<int>(std::count(jsonl.begin(), jsonl.end(), '\n')) == 3);

  stream.close();
  std::filesystem::remove_all(directory);
  std::cout << "runtime-contract-ok\n";
  return 0;
}
