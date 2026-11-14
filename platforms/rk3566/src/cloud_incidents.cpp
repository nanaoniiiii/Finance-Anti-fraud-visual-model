#include "poseguard/cloud_incidents.hpp"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <map>
#include <random>
#include <sstream>
#include <stdexcept>

#include "../../shared/incident_counter.hpp"

namespace poseguard {
namespace {
std::string stamp() {
  auto now = std::chrono::system_clock::now();
  auto t = std::chrono::system_clock::to_time_t(now);
  std::tm tm{};
  gmtime_r(&t, &tm);
  char b[32];
  std::strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", &tm);
  return b;
}
std::string uuid() {
  std::random_device rand;
  std::ostringstream s;
  for (int i = 0; i < 4; ++i)
    s << std::hex << std::setw(8) << std::setfill('0') << rand();
  return s.str();
}
std::string quoted(const std::string& value) {
  std::ostringstream s;
  s << '"';
  for (unsigned char c : value) {
    if (c == '"' || c == '\\')
      s << '\\' << c;
    else if (c >= 32)
      s << c;
    else
      s << ' ';
  }
  s << '"';
  return s.str();
}
std::string base64(const std::vector<std::uint8_t>& bytes) {
  static const char* chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (std::size_t i = 0; i < bytes.size(); i += 3) {
    unsigned n = unsigned(bytes[i]) << 16;
    if (i + 1 < bytes.size()) n |= unsigned(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size()) n |= bytes[i + 2];
    out += chars[(n >> 18) & 63];
    out += chars[(n >> 12) & 63];
    out += i + 1 < bytes.size() ? chars[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.size() ? chars[n & 63] : '=';
  }
  return out;
}
const char* risk_name(int risk) {
  return risk == 1 ? "phone_to_ear" : risk == 2 ? "multi_person" : "lingering";
}
void durable(const std::filesystem::path& path, const std::string& value,
             bool append = false) {
  std::filesystem::create_directories(path.parent_path());
  auto temporary =
      append ? path : std::filesystem::path(path.string() + ".new");
  int fd = ::open(temporary.c_str(),
                  O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC), 0600);
  if (fd < 0) throw std::runtime_error("cannot open cloud evidence");
  std::size_t offset = 0;
  while (offset < value.size()) {
    auto written = ::write(fd, value.data() + offset, value.size() - offset);
    if (written <= 0) {
      ::close(fd);
      throw std::runtime_error("cannot write cloud evidence");
    }
    offset += static_cast<std::size_t>(written);
  }
  const auto synced = ::fsync(fd);
  ::close(fd);
  if (synced) throw std::runtime_error("cannot sync cloud evidence");
  if (!append) {
    std::filesystem::rename(temporary, path);
    int parent = ::open(path.parent_path().c_str(), O_RDONLY | O_DIRECTORY);
    if (parent >= 0) {
      ::fsync(parent);
      ::close(parent);
    }
  }
}
}  // namespace
struct CloudIncidents::Impl {
  struct Evidence {
    std::string id, occurred;
    BBox bbox{};
  };
  std::filesystem::path root;
  poseguard_cloud::Counters counts;
  std::map<std::pair<int, int>, Evidence> evidence;
  std::string session{uuid()}, error;
  explicit Impl(std::string dir) : root(std::move(dir)) {
    std::filesystem::create_directories(root / "outbox");
  }
  Evidence& get(const poseguard_cloud::Counter& c) {
    return evidence.at({c.track_id, c.risk});
  }
  std::string fields(const poseguard_cloud::Counter& c) {
    auto& e = get(c);
    std::ostringstream s;
    s << "\"event_id\":" << quoted(e.id) << ",\"revision\":" << c.revision
      << ",\"track_id\":" << c.track_id << ",\"session_id\":" << quoted(session)
      << ",\"risk_kind\":" << quoted(risk_name(c.risk))
      << ",\"model_state\":" << quoted(c.state == 2 ? "alert" : "candidate")
      << ",\"confirmed_seen\":" << (c.confirmed ? "true" : "false")
      << ",\"observed_frames\":" << c.count << ",\"severity\":" << c.severity
      << ",\"occurred_at\":" << quoted(e.occurred)
      << ",\"updated_at\":" << quoted(stamp())
      << ",\"clock_synced\":" << (stamp() > "2024" ? "true" : "false");
    return s.str();
  }
  void record(const poseguard_cloud::Counter& c, const std::string& action) {
    durable(root / "incidents.jsonl",
            "{" + fields(c) + ",\"action\":" + quoted(action) + "}\n", true);
  }
  std::string photo(const poseguard_cloud::Counter& c,
                    const Snapshot& snapshot) {
    if (!snapshot) return {};
    auto bytes = snapshot(get(c).bbox);
    if (bytes.empty() || bytes.size() > 200000) {
      record(c, "snapshot_unavailable");
      return {};
    }
    auto path = root / "evidence" / get(c).id /
                ("r" + std::to_string(c.revision) + ".jpg");
    durable(path, std::string(reinterpret_cast<const char*>(bytes.data()),
                              bytes.size()));
    return ",\"snapshot\":{\"captured_at\":" + quoted(stamp()) +
           ",\"data_base64\":" + quoted(base64(bytes)) + "}";
  }
  void queue(poseguard_cloud::Counter& c, const std::string& type,
             const Snapshot& snapshot = {}, const std::string& reason = {}) {
    std::ostringstream name;
    name << get(c).id << "-r" << std::setw(6) << std::setfill('0') << c.revision
         << ".json";
    auto value = "{" + fields(c) + ",\"update_type\":" + quoted(type) +
                 ",\"termination_reason\":" + quoted(reason) +
                 photo(c, snapshot) + "}\n";
    durable(root / "outbox" / name.str(), value);
    record(c, "queued_" + type);
  }
  void end(poseguard_cloud::Counter& c, const std::string& type,
           const std::string& reason = {}) {
    record(c, "special_state_" + type);
    if (c.reported) {
      ++c.revision;
      queue(c, type, {}, reason);
    }
    evidence.erase({c.track_id, c.risk});
  }
  void policy() {
    std::ifstream in(root / "policy.env");
    std::string key;
    long value;
    while (in >> key >> value) {
      if (key == "threshold" && value >= 1 && value <= 1000000)
        counts.policy.threshold = value;
      else if (key == "escalation" && value > long(counts.policy.threshold) &&
               value <= 10000000)
        counts.policy.escalation = value;
      else if (key == "include_candidates")
        counts.policy.include_candidates = value != 0;
      else if (key == "grace_ms" && value >= 500 && value <= 30000)
        counts.policy.grace_ms = value;
    }
  }
};
CloudIncidents::CloudIncidents(const std::string& directory)
    : impl_(std::make_unique<Impl>(directory)) {}
CloudIncidents::~CloudIncidents() = default;
void CloudIncidents::update(const std::vector<TrackState>& tracks,
                            const std::vector<RiskDecision>& decisions,
                            double timeline, const Snapshot& snapshot) {
  try {
    auto& p = *impl_;
    p.policy();
    auto ms = static_cast<std::uint64_t>(std::max(0.0, timeline) * 1000);
    p.counts.expire(ms, [&](auto& c) { p.end(c, "resolved"); });
    for (auto& d : decisions) {
      if (d.state == RiskState::Normal) continue;
      auto t = std::find_if(tracks.begin(), tracks.end(), [&](auto& track) {
        return track.track_id == d.track_id && track.confirmed &&
               !track.predicted;
      });
      if (t == tracks.end()) continue;
      auto change = p.counts.observe(d.track_id, static_cast<int>(d.kind),
                                     static_cast<int>(d.state), ms);
      if (!change.counter) continue;
      auto& c = *change.counter;
      if (change.started) {
        p.evidence[{c.track_id, c.risk}] = {uuid(), stamp(), d.bbox};
        p.record(c, "special_state_started");
        p.photo(c, snapshot);
      }
      p.get(c).bbox = d.bbox;
      if (change.report)
        p.queue(c, change.escalated ? "escalated" : "created", snapshot);
      if (change.staff_needed) p.record(c, "staff_intervention_requested");
      if (change.started || change.report || c.count % 30 == 0)
        durable(p.root / "state" / (p.get(c).id + ".json"),
                "{" + p.fields(c) + "}\n");
    }
    p.error.clear();
  } catch (const std::exception& e) {
    impl_->error = e.what();
  }
}
void CloudIncidents::reset(const std::string& reason) {
  try {
    impl_->counts.reset([&](auto& c) { impl_->end(c, "interrupted", reason); });
  } catch (const std::exception& e) {
    impl_->error = e.what();
  }
}
const std::string& CloudIncidents::last_error() const { return impl_->error; }
}  // namespace poseguard
