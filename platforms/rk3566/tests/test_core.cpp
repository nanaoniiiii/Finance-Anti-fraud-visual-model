#include "poseguard/core.hpp"

#include <initializer_list>
#include <iostream>
#include <vector>

#define CHECK(expression)                                                     \
  do {                                                                        \
    if (!(expression)) {                                                      \
      std::cerr << "CHECK failed at line " << __LINE__ << ": "             \
                << #expression << '\n';                                      \
      return false;                                                           \
    }                                                                         \
  } while (false)

namespace {

using poseguard::Keypoint;
using poseguard::PoseCore;
using poseguard::PoseObservation;
using poseguard::RiskDecision;
using poseguard::RiskKind;
using poseguard::RiskState;
using poseguard::TrackState;

constexpr int kWidth = 640;
constexpr int kHeight = 480;

void set_point(PoseObservation& person, std::size_t index, float x, float y) {
  person.keypoints[index] = Keypoint{x, y, 0.95F, true};
}

PoseObservation standing_person(float center_x, bool phone_to_left_ear = false,
                                float movement = 0.0F) {
  PoseObservation person{};
  person.bbox = {center_x - 50.0F, 100.0F, center_x + 50.0F, 340.0F};
  person.confidence = 0.92F;

  set_point(person, 0, center_x, 125.0F);
  set_point(person, 1, center_x - 7.0F, 121.0F);
  set_point(person, 2, center_x + 7.0F, 121.0F);
  set_point(person, 3, center_x - 14.0F, 130.0F);
  set_point(person, 4, center_x + 14.0F, 130.0F);
  set_point(person, 5, center_x - 25.0F, 160.0F);
  set_point(person, 6, center_x + 25.0F, 160.0F);
  set_point(person, 7, center_x - 35.0F, 205.0F);
  set_point(person, 8, center_x + 35.0F, 205.0F);
  set_point(person, 9, center_x - 40.0F, 250.0F);
  set_point(person, 10, center_x + 40.0F, 250.0F);
  set_point(person, 11, center_x - 22.0F, 245.0F);
  set_point(person, 12, center_x + 22.0F, 245.0F);
  set_point(person, 13, center_x - 20.0F, 290.0F);
  set_point(person, 14, center_x + 20.0F, 290.0F);
  set_point(person, 15, center_x - 20.0F, 335.0F);
  set_point(person, 16, center_x + 20.0F, 335.0F);

  if (phone_to_left_ear) {
    set_point(person, 7, center_x - 32.0F, 177.0F);
    set_point(person, 9, center_x - 16.0F, 134.0F);
  }

  if (movement > 0.0F) {
    set_point(person, 7, center_x - 48.0F - movement, 184.0F);
    set_point(person, 8, center_x + 48.0F + movement, 184.0F);
    set_point(person, 9, center_x - 62.0F - movement, 145.0F);
    set_point(person, 10, center_x + 62.0F + movement, 145.0F);
    set_point(person, 15, center_x - 42.0F, 318.0F - movement);
    set_point(person, 16, center_x + 42.0F, 318.0F - movement);
  }
  return person;
}

std::vector<TrackState> confirm(PoseCore& core,
                                const std::vector<PoseObservation>& people,
                                double start = 0.0) {
  core.update_tracks(people, start);
  core.update_tracks(people, start + 0.05);
  return core.update_tracks(people, start + 0.10);
}

RiskState state_for(const std::vector<RiskDecision>& decisions, RiskKind kind,
                    int track_id = -1) {
  RiskState strongest = RiskState::Normal;
  for (const auto& decision : decisions) {
    if (decision.kind != kind ||
        (track_id >= 0 && decision.track_id != track_id)) {
      continue;
    }
    if (static_cast<int>(decision.state) > static_cast<int>(strongest)) {
      strongest = decision.state;
    }
  }
  return strongest;
}

bool test_phone_to_ear() {
  PoseCore core{};
  const auto phone = standing_person(220.0F, true);
  auto tracks = confirm(core, {phone});
  CHECK(tracks.size() == 1U);
  auto decisions = core.evaluate(tracks, kWidth, kHeight, 0.10);
  CHECK(state_for(decisions, RiskKind::PhoneToEar) == RiskState::Candidate);

  tracks = core.update_tracks({phone}, 1.20);
  decisions = core.evaluate(tracks, kWidth, kHeight, 1.20);
  CHECK(state_for(decisions, RiskKind::PhoneToEar) == RiskState::Alert);
  return true;
}

bool test_multi_person() {
  PoseCore core{};
  const std::vector<PoseObservation> people{standing_person(180.0F),
                                            standing_person(450.0F)};
  auto tracks = confirm(core, people);
  auto decisions = core.evaluate(tracks, kWidth, kHeight, 0.10);
  CHECK(state_for(decisions, RiskKind::MultiPerson) == RiskState::Candidate);

  tracks = core.update_tracks(people, 0.90);
  core.evaluate(tracks, kWidth, kHeight, 0.90);
  tracks = core.update_tracks(people, 1.70);
  decisions = core.evaluate(tracks, kWidth, kHeight, 1.70);
  CHECK(state_for(decisions, RiskKind::MultiPerson) == RiskState::Alert);
  return true;
}

bool test_lingering() {
  PoseCore core{};
  const auto still = standing_person(320.0F);
  auto tracks = confirm(core, {still});
  auto decisions = core.evaluate(tracks, kWidth, kHeight, 0.10);
  CHECK(state_for(decisions, RiskKind::Lingering) == RiskState::Candidate);

  for (int second = 1; second <= 19; ++second) {
    const double timestamp = static_cast<double>(second) + 0.10;
    tracks = core.update_tracks({still}, timestamp);
    core.evaluate(tracks, kWidth, kHeight, timestamp);
  }
  tracks = core.update_tracks({still}, 20.20);
  decisions = core.evaluate(tracks, kWidth, kHeight, 20.20);
  CHECK(state_for(decisions, RiskKind::Lingering) == RiskState::Alert);
  return true;
}

bool test_motion_resets_lingering() {
  PoseCore core{};
  const auto still = standing_person(320.0F);
  auto tracks = confirm(core, {still});
  core.evaluate(tracks, kWidth, kHeight, 0.10);

  for (int second = 1; second <= 9; ++second) {
    const double timestamp = static_cast<double>(second) + 0.10;
    tracks = core.update_tracks({still}, timestamp);
    core.evaluate(tracks, kWidth, kHeight, timestamp);
  }
  tracks = core.update_tracks({still}, 10.0);
  auto decisions = core.evaluate(tracks, kWidth, kHeight, 10.0);
  CHECK(state_for(decisions, RiskKind::Lingering) == RiskState::Candidate);

  const auto yoga = standing_person(320.0F, false, 18.0F);
  tracks = core.update_tracks({yoga}, 10.10);
  decisions = core.evaluate(tracks, kWidth, kHeight, 10.10);
  CHECK(state_for(decisions, RiskKind::Lingering) == RiskState::Normal);

  for (int second = 11; second <= 24; ++second) {
    const double timestamp = static_cast<double>(second) + 0.10;
    tracks = core.update_tracks({yoga}, timestamp);
    core.evaluate(tracks, kWidth, kHeight, timestamp);
  }
  tracks = core.update_tracks({yoga}, 25.0);
  decisions = core.evaluate(tracks, kWidth, kHeight, 25.0);
  CHECK(state_for(decisions, RiskKind::Lingering) != RiskState::Alert);
  return true;
}

bool test_short_dropout_keeps_track() {
  PoseCore core{};
  auto tracks = confirm(core, {standing_person(300.0F)});
  CHECK(tracks.size() == 1U);
  const int original_id = tracks.front().track_id;

  tracks = core.update_tracks({}, 0.70);
  CHECK(tracks.size() == 1U);
  CHECK(tracks.front().track_id == original_id);
  CHECK(tracks.front().predicted);

  tracks = core.update_tracks({standing_person(305.0F)}, 1.20);
  CHECK(tracks.size() == 1U);
  CHECK(tracks.front().track_id == original_id);
  CHECK(!tracks.front().predicted);
  return true;
}

}  // namespace

int main() {
  if (!test_phone_to_ear() || !test_multi_person() || !test_lingering() ||
      !test_motion_resets_lingering() || !test_short_dropout_keeps_track()) {
    return 1;
  }
  std::cout << "core-risk-ok\n";
  return 0;
}
