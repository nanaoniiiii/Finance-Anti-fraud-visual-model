#pragma once

#include "poseguard/core.hpp"

#include <memory>
#include <string>
#include <vector>

namespace poseguard {

struct RuntimeConfig {
  std::string model_path{
      "/userdata/poseguard/models/poseguard-yolo11n-pose-320-int8.rknn"};
  std::string source{"camera"};
  std::string video_path{};
  std::string preferred_device{};
  std::string events_path{"/userdata/poseguard/runs/events.jsonl"};
  int http_port{8081};
  int max_frames{};
  bool benchmark{};
  bool http_enabled{true};
  CoreConfig core{};
};

RuntimeConfig load_runtime_config(const std::string& path);

RiskState strongest_state_for_track(
    int track_id, const std::vector<RiskDecision>& decisions);
RiskKind strongest_risk_for_track(
    int track_id, const std::vector<RiskDecision>& decisions);

Frame draw_overlay(const Frame& frame, const std::vector<TrackState>& tracks,
                   const std::vector<RiskDecision>& decisions,
                   const Metrics& metrics, const std::string& banner = {});

class EventJournal {
 public:
  explicit EventJournal(std::string path);
  ~EventJournal();

  EventJournal(EventJournal&&) noexcept;
  EventJournal& operator=(EventJournal&&) noexcept;
  EventJournal(const EventJournal&) = delete;
  EventJournal& operator=(const EventJournal&) = delete;

  void publish(const std::vector<RiskDecision>& decisions, double video_pts,
               const Metrics& metrics);
  const std::string& last_error() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

int run_application(const RuntimeConfig& config);

}  // namespace poseguard
