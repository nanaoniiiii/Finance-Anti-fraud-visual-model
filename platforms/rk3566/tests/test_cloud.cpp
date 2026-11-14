#include <unistd.h>

#include <cassert>
#include <filesystem>
#include <fstream>
#include <iterator>

#include "../../shared/incident_counter.hpp"
#include "poseguard/cloud_incidents.hpp"
int main() {
  poseguard_cloud::Counters counters;
  for (int i = 0; i < 100; ++i)
    assert(!counters.observe(1, 1, 1, i * 30).report);
  assert(!counters.observe(1, 1, 2, 3000, false).report);
  auto created = counters.observe(1, 1, 1, 3000);
  assert(created.report && !created.escalated &&
         created.counter->count == 101 && created.counter->severity == 1);
  auto alert = counters.observe(1, 1, 2, 3030);
  assert(alert.report && alert.escalated && alert.counter->severity == 2);
  for (int i = 102; i < 300; ++i)
    assert(!counters.observe(1, 1, 2, i * 30).report);
  auto urgent = counters.observe(1, 1, 2, 9000);
  assert(urgent.report && urgent.staff_needed && urgent.counter->count == 301);
  assert(counters.observe(2, 1, 1, 9030).counter->count == 1);
  assert(counters.observe(1, 2, 1, 9030).counter->count == 1);
  auto root = std::filesystem::temp_directory_path() /
              ("poseguard-cloud-test-" + std::to_string(getpid()));
  poseguard::CloudIncidents monitor(root.string());
  poseguard::TrackState track{};
  track.track_id = 7;
  track.confirmed = true;
  poseguard::RiskDecision risk{};
  risk.track_id = 7;
  risk.kind = poseguard::RiskKind::PhoneToEar;
  risk.state = poseguard::RiskState::Candidate;
  risk.bbox = {0, 0, 100, 100};
  auto picture = [](poseguard::BBox) {
    return std::vector<std::uint8_t>{255, 216, 255, 217};
  };
  for (int i = 0; i < 100; ++i)
    monitor.update({track}, {risk}, i * .03, picture);
  assert(std::filesystem::is_empty(root / "outbox"));
  monitor.update({track}, {risk}, 3, picture);
  std::size_t count = 0;
  for (auto& file : std::filesystem::directory_iterator(root / "outbox")) {
    ++count;
    std::ifstream stream(file.path());
    std::string data((std::istreambuf_iterator<char>(stream)), {});
    assert(data.find("\"observed_frames\":101") != std::string::npos);
    assert(data.find("\"snapshot\":") != std::string::npos);
  }
  assert(count == 1);
  track.predicted = true;
  monitor.update({track}, {risk}, 3.1, picture);
  monitor.update({}, {}, 5.2, picture);
  count = 0;
  for (auto& file : std::filesystem::directory_iterator(root / "outbox")) {
    (void)file;
    ++count;
  }
  assert(count == 2);
  assert(monitor.last_error().empty());
  std::filesystem::remove_all(root);
  return 0;
}
