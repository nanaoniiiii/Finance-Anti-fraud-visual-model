#pragma once
#include <functional>
#include <memory>
#include <string>

#include "poseguard/types.hpp"

namespace poseguard {
class CloudIncidents {
 public:
  using Snapshot = std::function<std::vector<std::uint8_t>(BBox)>;
  explicit CloudIncidents(const std::string& directory);
  ~CloudIncidents();
  void update(const std::vector<TrackState>& tracks,
              const std::vector<RiskDecision>& decisions, double timeline,
              const Snapshot& snapshot);
  void reset(const std::string& reason);
  const std::string& last_error() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace poseguard
