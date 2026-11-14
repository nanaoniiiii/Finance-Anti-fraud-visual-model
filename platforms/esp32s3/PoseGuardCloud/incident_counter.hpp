#pragma once
#include <array>
#include <cstdint>
#include <limits>

namespace poseguard_cloud {
struct Policy {
  std::uint32_t threshold{100}, escalation{300}, grace_ms{2000};
  bool include_candidates{true};
};
struct Counter {
  bool active{}, confirmed{}, reported{};
  int track_id{-1}, risk{}, state{}, severity{};
  std::uint32_t count{}, revision{};
  std::uint64_t last_ms{};
  Policy policy{};
};
struct Change {
  Counter* counter{};
  bool started{}, report{}, escalated{}, staff_needed{};
};
// At most eight persons and three risks. Only fresh observations count.
class Counters {
 public:
  Policy policy{};
  std::array<Counter, 24> slots{};
  Change observe(int track, int risk, int state, std::uint64_t ms,
                 bool fresh = true) {
    if (!fresh || risk < 1 || risk > 3 || state < 1 || state > 2) return {};
    Counter* item = nullptr;
    for (auto& slot : slots)
      if (slot.active && slot.track_id == track && slot.risk == risk) {
        item = &slot;
        break;
      }
    bool started = false;
    if (!item)
      for (auto& slot : slots)
        if (!slot.active) {
          item = &slot;
          slot = {};
          slot.active = true;
          slot.track_id = track;
          slot.risk = risk;
          slot.policy = policy;
          started = true;
          break;
        }
    if (!item) return {};
    item->last_ms = ms;
    item->state = state;
    item->confirmed |= state == 2;
    if ((state == 2 || item->policy.include_candidates) &&
        item->count < std::numeric_limits<std::uint32_t>::max())
      ++item->count;
    int level = 0;
    if (item->count > item->policy.threshold)
      level = item->confirmed ? (item->count > item->policy.escalation ? 3 : 2)
                              : (item->count > item->policy.escalation ? 2 : 1);
    const bool report = level > item->severity,
               escalated = report && item->reported;
    if (report) {
      item->severity = level;
      item->reported = true;
      ++item->revision;
    }
    return {item, started, report, escalated, report && level == 3};
  }
  template <class End>
  void expire(std::uint64_t ms, End end) {
    for (auto& slot : slots)
      if (slot.active && ms >= slot.last_ms &&
          ms - slot.last_ms >= slot.policy.grace_ms) {
        end(slot);
        slot = {};
      }
  }
  template <class End>
  void reset(End end) {
    for (auto& slot : slots)
      if (slot.active) {
        end(slot);
        slot = {};
      }
  }
};
}  // namespace poseguard_cloud
