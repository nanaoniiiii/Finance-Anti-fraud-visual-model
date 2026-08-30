#include "poseguard/runtime.hpp"

#include "poseguard/rknn_pose.hpp"
#include "poseguard/video_source.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cctype>
#include <condition_variable>
#include <csignal>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <utility>

#if defined(POSEGUARD_WITH_GSTREAMER)
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#endif

#if defined(__linux__)
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace poseguard {
namespace {

std::string trim(std::string value) {
  const auto first = std::find_if_not(value.begin(), value.end(),
                                      [](unsigned char character) {
                                        return std::isspace(character) != 0;
                                      });
  const auto last = std::find_if_not(value.rbegin(), value.rend(),
                                     [](unsigned char character) {
                                       return std::isspace(character) != 0;
                                     })
                        .base();
  return first < last ? std::string(first, last) : std::string{};
}

bool parse_bool(const std::string& value) {
  std::string normalized = value;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(),
                 [](unsigned char character) {
                   return static_cast<char>(std::tolower(character));
                 });
  if (normalized == "1" || normalized == "true" || normalized == "yes" ||
      normalized == "on") {
    return true;
  }
  if (normalized == "0" || normalized == "false" || normalized == "no" ||
      normalized == "off") {
    return false;
  }
  throw std::invalid_argument("invalid boolean value: " + value);
}

const char* risk_name(RiskKind kind) {
  switch (kind) {
    case RiskKind::PhoneToEar:
      return "phone_to_ear";
    case RiskKind::MultiPerson:
      return "multi_person";
    case RiskKind::Lingering:
      return "lingering";
    case RiskKind::None:
    default:
      return "none";
  }
}

const char* short_risk_name(RiskKind kind) {
  switch (kind) {
    case RiskKind::PhoneToEar:
      return "PHONE";
    case RiskKind::MultiPerson:
      return "MULTI";
    case RiskKind::Lingering:
      return "LINGER";
    case RiskKind::None:
    default:
      return "NORMAL";
  }
}

const char* state_name(RiskState state) {
  switch (state) {
    case RiskState::Candidate:
      return "candidate";
    case RiskState::Alert:
      return "alert";
    case RiskState::Normal:
    default:
      return "normal";
  }
}

void set_pixel(Frame& frame, int x, int y, Rgb color) {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    return;
  }
  const std::size_t offset =
      (static_cast<std::size_t>(y) * frame.width + x) * 3U;
  if (offset + 2U >= frame.rgb.size()) {
    return;
  }
  frame.rgb[offset] = color.r;
  frame.rgb[offset + 1U] = color.g;
  frame.rgb[offset + 2U] = color.b;
}

void draw_line(Frame& frame, int x0, int y0, int x1, int y1, Rgb color,
               int thickness = 1) {
  const int delta_x = std::abs(x1 - x0);
  const int step_x = x0 < x1 ? 1 : -1;
  const int delta_y = -std::abs(y1 - y0);
  const int step_y = y0 < y1 ? 1 : -1;
  int error = delta_x + delta_y;
  for (;;) {
    const int radius = std::max(0, thickness - 1);
    for (int offset_y = -radius; offset_y <= radius; ++offset_y) {
      for (int offset_x = -radius; offset_x <= radius; ++offset_x) {
        set_pixel(frame, x0 + offset_x, y0 + offset_y, color);
      }
    }
    if (x0 == x1 && y0 == y1) {
      break;
    }
    const int doubled = 2 * error;
    if (doubled >= delta_y) {
      error += delta_y;
      x0 += step_x;
    }
    if (doubled <= delta_x) {
      error += delta_x;
      y0 += step_y;
    }
  }
}

void draw_rectangle(Frame& frame, const BBox& box, Rgb color,
                    int thickness) {
  const int left = static_cast<int>(std::lround(box.x1));
  const int top = static_cast<int>(std::lround(box.y1));
  const int right = static_cast<int>(std::lround(box.x2));
  const int bottom = static_cast<int>(std::lround(box.y2));
  draw_line(frame, left, top, right, top, color, thickness);
  draw_line(frame, right, top, right, bottom, color, thickness);
  draw_line(frame, right, bottom, left, bottom, color, thickness);
  draw_line(frame, left, bottom, left, top, color, thickness);
}

void draw_dot(Frame& frame, int x, int y, Rgb color) {
  for (int offset_y = -2; offset_y <= 2; ++offset_y) {
    for (int offset_x = -2; offset_x <= 2; ++offset_x) {
      if (offset_x * offset_x + offset_y * offset_y <= 4) {
        set_pixel(frame, x + offset_x, y + offset_y, color);
      }
    }
  }
}

std::array<std::uint8_t, 7> glyph(char character) {
  switch (character) {
    case '0': return {14, 17, 19, 21, 25, 17, 14};
    case '1': return {4, 12, 4, 4, 4, 4, 14};
    case '2': return {14, 17, 1, 2, 4, 8, 31};
    case '3': return {30, 1, 1, 14, 1, 1, 30};
    case '4': return {2, 6, 10, 18, 31, 2, 2};
    case '5': return {31, 16, 16, 30, 1, 1, 30};
    case '6': return {14, 16, 16, 30, 17, 17, 14};
    case '7': return {31, 1, 2, 4, 8, 8, 8};
    case '8': return {14, 17, 17, 14, 17, 17, 14};
    case '9': return {14, 17, 17, 15, 1, 1, 14};
    case 'A': return {14, 17, 17, 31, 17, 17, 17};
    case 'B': return {30, 17, 17, 30, 17, 17, 30};
    case 'C': return {14, 17, 16, 16, 16, 17, 14};
    case 'D': return {30, 17, 17, 17, 17, 17, 30};
    case 'E': return {31, 16, 16, 30, 16, 16, 31};
    case 'F': return {31, 16, 16, 30, 16, 16, 16};
    case 'G': return {14, 17, 16, 23, 17, 17, 14};
    case 'H': return {17, 17, 17, 31, 17, 17, 17};
    case 'I': return {14, 4, 4, 4, 4, 4, 14};
    case 'J': return {7, 2, 2, 2, 2, 18, 12};
    case 'K': return {17, 18, 20, 24, 20, 18, 17};
    case 'L': return {16, 16, 16, 16, 16, 16, 31};
    case 'M': return {17, 27, 21, 21, 17, 17, 17};
    case 'N': return {17, 25, 21, 19, 17, 17, 17};
    case 'O': return {14, 17, 17, 17, 17, 17, 14};
    case 'P': return {30, 17, 17, 30, 16, 16, 16};
    case 'Q': return {14, 17, 17, 17, 21, 18, 13};
    case 'R': return {30, 17, 17, 30, 20, 18, 17};
    case 'S': return {15, 16, 16, 14, 1, 1, 30};
    case 'T': return {31, 4, 4, 4, 4, 4, 4};
    case 'U': return {17, 17, 17, 17, 17, 17, 14};
    case 'V': return {17, 17, 17, 17, 17, 10, 4};
    case 'W': return {17, 17, 17, 21, 21, 21, 10};
    case 'X': return {17, 17, 10, 4, 10, 17, 17};
    case 'Y': return {17, 17, 10, 4, 4, 4, 4};
    case 'Z': return {31, 1, 2, 4, 8, 16, 31};
    case ':': return {0, 4, 4, 0, 4, 4, 0};
    case '.': return {0, 0, 0, 0, 0, 4, 4};
    case '-': return {0, 0, 0, 31, 0, 0, 0};
    case '_': return {0, 0, 0, 0, 0, 0, 31};
    case '/': return {1, 1, 2, 4, 8, 16, 16};
    default: return {0, 0, 0, 0, 0, 0, 0};
  }
}

void draw_text(Frame& frame, int x, int y, std::string text, Rgb color,
               int scale = 1) {
  for (char& character : text) {
    character = static_cast<char>(
        std::toupper(static_cast<unsigned char>(character)));
  }
  int cursor = x;
  for (const char character : text) {
    const auto rows = glyph(character);
    for (int row = 0; row < 7; ++row) {
      for (int column = 0; column < 5; ++column) {
        if ((rows[static_cast<std::size_t>(row)] & (1U << (4 - column))) ==
            0) {
          continue;
        }
        for (int dy = 0; dy < scale; ++dy) {
          for (int dx = 0; dx < scale; ++dx) {
            set_pixel(frame, cursor + column * scale + dx,
                      y + row * scale + dy, color);
          }
        }
      }
    }
    cursor += 6 * scale;
  }
}

std::string format_decimal(double value, int precision = 1) {
  std::ostringstream stream;
  stream << std::fixed << std::setprecision(precision) << value;
  return stream.str();
}

}  // namespace

RuntimeConfig load_runtime_config(const std::string& path) {
  std::ifstream stream(path);
  if (!stream) {
    throw std::runtime_error("cannot open config: " + path);
  }
  RuntimeConfig config{};
  std::string line;
  int line_number = 0;
  while (std::getline(stream, line)) {
    ++line_number;
    const auto comment = line.find('#');
    if (comment != std::string::npos) {
      line.erase(comment);
    }
    line = trim(line);
    if (line.empty()) {
      continue;
    }
    const auto separator = line.find('=');
    if (separator == std::string::npos) {
      throw std::runtime_error("invalid config line " +
                               std::to_string(line_number));
    }
    const std::string key = trim(line.substr(0, separator));
    const std::string value = trim(line.substr(separator + 1));
    if (key == "model") config.model_path = value;
    else if (key == "source") config.source = value;
    else if (key == "video") config.video_path = value;
    else if (key == "device") config.preferred_device = value;
    else if (key == "events") config.events_path = value;
    else if (key == "http_port") config.http_port = std::stoi(value);
    else if (key == "http_enabled") config.http_enabled = parse_bool(value);
    else if (key == "phone_alert_seconds")
      config.core.phone_alert_seconds = std::stod(value);
    else if (key == "multi_person_alert_seconds")
      config.core.multi_person_alert_seconds = std::stod(value);
    else if (key == "lingering_alert_seconds")
      config.core.lingering_alert_seconds = std::stod(value);
    else if (key == "alert_release_seconds")
      config.core.alert_release_seconds = std::stod(value);
  }
  if (config.http_port <= 0 || config.http_port > 65535) {
    throw std::runtime_error("http_port must be in 1..65535");
  }
  return config;
}

RiskState strongest_state_for_track(
    int track_id, const std::vector<RiskDecision>& decisions) {
  RiskState strongest = RiskState::Normal;
  for (const auto& decision : decisions) {
    if (decision.track_id == track_id &&
        static_cast<int>(decision.state) > static_cast<int>(strongest)) {
      strongest = decision.state;
    }
  }
  return strongest;
}

RiskKind strongest_risk_for_track(
    int track_id, const std::vector<RiskDecision>& decisions) {
  RiskState strongest = RiskState::Normal;
  RiskKind kind = RiskKind::None;
  for (const auto& decision : decisions) {
    if (decision.track_id != track_id) {
      continue;
    }
    if (decision.state != RiskState::Normal &&
        (kind == RiskKind::None ||
         static_cast<int>(decision.state) > static_cast<int>(strongest))) {
      strongest = decision.state;
      kind = decision.kind;
    }
  }
  return kind;
}

Frame draw_overlay(const Frame& frame, const std::vector<TrackState>& tracks,
                   const std::vector<RiskDecision>& decisions,
                   const Metrics& metrics, const std::string& banner) {
  Frame canvas = frame;
  if (canvas.width <= 0 || canvas.height <= 0 ||
      canvas.rgb.size() <
          static_cast<std::size_t>(canvas.width) * canvas.height * 3U) {
    return canvas;
  }

  constexpr std::array<std::pair<int, int>, 18> bones{{
      {5, 6}, {5, 7}, {7, 9}, {6, 8}, {8, 10}, {5, 11},
      {6, 12}, {11, 12}, {11, 13}, {13, 15}, {12, 14}, {14, 16},
      {0, 1}, {0, 2}, {1, 3}, {2, 4}, {3, 5}, {4, 6},
  }};
  for (const auto& track : tracks) {
    if (!track.confirmed) {
      continue;
    }
    const RiskState state = strongest_state_for_track(track.track_id, decisions);
    const RiskKind risk = strongest_risk_for_track(track.track_id, decisions);
    const Rgb color = color_for(state);
    draw_rectangle(canvas, track.bbox, color,
                   state == RiskState::Alert ? 3 : 2);
    for (const auto& bone : bones) {
      const auto& first = track.keypoints[static_cast<std::size_t>(bone.first)];
      const auto& second =
          track.keypoints[static_cast<std::size_t>(bone.second)];
      if (first.valid && second.valid) {
        draw_line(canvas, static_cast<int>(std::lround(first.x)),
                  static_cast<int>(std::lround(first.y)),
                  static_cast<int>(std::lround(second.x)),
                  static_cast<int>(std::lround(second.y)), color, 1);
      }
    }
    for (const auto& point : track.keypoints) {
      if (point.valid) {
        draw_dot(canvas, static_cast<int>(std::lround(point.x)),
                 static_cast<int>(std::lround(point.y)), color);
      }
    }
    std::string label = "ID " + std::to_string(track.track_id);
    if (risk != RiskKind::None) {
      label += " " + std::string(short_risk_name(risk));
    }
    const int text_y = std::max(2, static_cast<int>(track.bbox.y1) - 9);
    draw_text(canvas, std::max(2, static_cast<int>(track.bbox.x1)), text_y,
              label, color);
  }

  draw_text(canvas, 5, 5, "FPS " + format_decimal(metrics.fps),
            {255, 255, 255});
  if (!banner.empty()) {
    draw_text(canvas, 5, 16, banner, {255, 220, 0});
  }
  return canvas;
}

struct EventJournal::Impl {
  explicit Impl(std::string destination) : path(std::move(destination)) {
    std::error_code filesystem_error;
    const auto parent = std::filesystem::path(path).parent_path();
    if (!parent.empty()) {
      std::filesystem::create_directories(parent, filesystem_error);
    }
    if (filesystem_error) {
      error = filesystem_error.message();
      return;
    }
    stream.open(path, std::ios::app);
    if (!stream) {
      error = "cannot open event journal: " + path;
    }
  }

  using Key = std::pair<int, int>;
  std::string path;
  std::ofstream stream;
  std::map<Key, RiskDecision> active;
  std::string error;

  void emit(const RiskDecision& decision, const char* state, double video_pts,
            const Metrics& metrics) {
    if (!stream) {
      if (error.empty()) error = "event journal is not writable";
      return;
    }
    const double timestamp =
        std::chrono::duration<double>(
            std::chrono::system_clock::now().time_since_epoch())
            .count();
    stream << std::fixed << std::setprecision(3)
           << "{\"timestamp\":" << timestamp
           << ",\"video_pts\":" << video_pts
           << ",\"track_id\":" << decision.track_id
           << ",\"risk_kind\":\"" << risk_name(decision.kind)
           << "\",\"state\":\"" << state
           << "\",\"duration_seconds\":" << decision.duration_seconds
           << ",\"bbox\":[" << decision.bbox.x1 << ',' << decision.bbox.y1
           << ',' << decision.bbox.x2 << ',' << decision.bbox.y2 << ']'
           << ",\"fps\":" << metrics.fps
           << ",\"inference_ms\":" << metrics.inference_ms << "}\n";
    stream.flush();
    if (!stream) {
      error = "failed to append event journal";
    }
  }
};

EventJournal::EventJournal(std::string path)
    : impl_(std::make_unique<Impl>(std::move(path))) {}
EventJournal::~EventJournal() = default;
EventJournal::EventJournal(EventJournal&&) noexcept = default;
EventJournal& EventJournal::operator=(EventJournal&&) noexcept = default;

void EventJournal::publish(const std::vector<RiskDecision>& decisions,
                           double video_pts, const Metrics& metrics) {
  std::map<Impl::Key, RiskDecision> current;
  for (const auto& decision : decisions) {
    const Impl::Key key{decision.track_id, static_cast<int>(decision.kind)};
    const auto previous = impl_->active.find(key);
    if (decision.state == RiskState::Normal) {
      if (previous != impl_->active.end()) {
        impl_->emit(decision, "clear", video_pts, metrics);
        impl_->active.erase(previous);
      }
      continue;
    }
    current[key] = decision;
    if (previous == impl_->active.end() ||
        previous->second.state != decision.state) {
      impl_->emit(decision, state_name(decision.state), video_pts, metrics);
    }
    impl_->active[key] = decision;
  }

  for (auto iterator = impl_->active.begin(); iterator != impl_->active.end();) {
    if (current.count(iterator->first) != 0) {
      ++iterator;
      continue;
    }
    const RiskDecision cleared = iterator->second;
    impl_->emit(cleared, "clear", video_pts, metrics);
    iterator = impl_->active.erase(iterator);
  }
}

const std::string& EventJournal::last_error() const { return impl_->error; }

#if defined(POSEGUARD_WITH_RKNN) && defined(POSEGUARD_WITH_GSTREAMER) && \
    defined(__linux__)
namespace {

std::atomic<bool> stop_requested{false};

void handle_stop_signal(int) { stop_requested.store(true); }

std::string json_escape(const std::string& value) {
  std::ostringstream stream;
  for (const unsigned char character : value) {
    switch (character) {
      case '\\': stream << "\\\\"; break;
      case '"': stream << "\\\""; break;
      case '\n': stream << "\\n"; break;
      case '\r': stream << "\\r"; break;
      case '\t': stream << "\\t"; break;
      default:
        if (character >= 0x20U) stream << static_cast<char>(character);
        break;
    }
  }
  return stream.str();
}

std::string status_json(const std::string& input_state,
                        const std::string& active_source,
                        const std::vector<TrackState>& tracks,
                        const std::vector<RiskDecision>& decisions,
                        const Metrics& metrics, const std::string& error) {
  std::size_t alerts = 0;
  std::size_t candidates = 0;
  for (const auto& decision : decisions) {
    if (decision.state == RiskState::Alert) ++alerts;
    else if (decision.state == RiskState::Candidate) ++candidates;
  }
  std::ostringstream stream;
  stream << std::fixed << std::setprecision(2)
         << "{\"input_state\":\"" << json_escape(input_state)
         << "\",\"source\":\"" << json_escape(active_source)
         << "\",\"frame_index\":" << metrics.frame_index
         << ",\"tracks\":" << tracks.size()
         << ",\"candidates\":" << candidates
         << ",\"alerts\":" << alerts << ",\"fps\":" << metrics.fps
         << ",\"inference_ms\":" << metrics.inference_ms
         << ",\"processing_ms\":" << metrics.processing_ms
         << ",\"last_error\":\"" << json_escape(error) << "\"}";
  return stream.str();
}

class JpegEncoder {
 public:
  JpegEncoder() { gst_init(nullptr, nullptr); }
  ~JpegEncoder() { release(); }

  bool encode(const Frame& frame, std::vector<std::uint8_t>& jpeg) {
    if (pipeline_ == nullptr || width_ != frame.width || height_ != frame.height) {
      if (!open(frame.width, frame.height)) return false;
    }
    GstBuffer* buffer =
        gst_buffer_new_allocate(nullptr, frame.rgb.size(), nullptr);
    if (buffer == nullptr ||
        gst_buffer_fill(buffer, 0, frame.rgb.data(), frame.rgb.size()) !=
            frame.rgb.size()) {
      if (buffer != nullptr) gst_buffer_unref(buffer);
      error_ = "cannot allocate JPEG input buffer";
      return false;
    }
    GST_BUFFER_PTS(buffer) = static_cast<GstClockTime>(
        std::max(0.0, frame.pts_seconds) * static_cast<double>(GST_SECOND));
    if (gst_app_src_push_buffer(source_, buffer) != GST_FLOW_OK) {
      error_ = "JPEG encoder rejected RGB frame";
      return false;
    }
    GstSample* sample = gst_app_sink_try_pull_sample(sink_, 1500 * GST_MSECOND);
    if (sample == nullptr) {
      error_ = "JPEG encoder timed out";
      return false;
    }
    GstBuffer* output = gst_sample_get_buffer(sample);
    GstMapInfo map{};
    const bool mapped =
        output != nullptr && gst_buffer_map(output, &map, GST_MAP_READ);
    if (!mapped) {
      gst_sample_unref(sample);
      error_ = "cannot map JPEG output";
      return false;
    }
    jpeg.assign(map.data, map.data + map.size);
    gst_buffer_unmap(output, &map);
    gst_sample_unref(sample);
    error_.clear();
    return !jpeg.empty();
  }

  const std::string& last_error() const { return error_; }

 private:
  bool launch(const std::string& description) {
    GError* launch_error = nullptr;
    pipeline_ = gst_parse_launch(description.c_str(), &launch_error);
    if (pipeline_ == nullptr || launch_error != nullptr) {
      error_ = launch_error != nullptr ? launch_error->message
                                       : "cannot create JPEG pipeline";
      if (launch_error != nullptr) g_error_free(launch_error);
      release();
      return false;
    }
    GstElement* source_element =
        gst_bin_get_by_name(GST_BIN(pipeline_), "poseguard_jpeg_source");
    GstElement* sink_element =
        gst_bin_get_by_name(GST_BIN(pipeline_), "poseguard_jpeg_sink");
    if (source_element == nullptr || sink_element == nullptr) {
      if (source_element != nullptr) gst_object_unref(source_element);
      if (sink_element != nullptr) gst_object_unref(sink_element);
      error_ = "JPEG pipeline elements are missing";
      release();
      return false;
    }
    source_ = GST_APP_SRC(source_element);
    sink_ = GST_APP_SINK(sink_element);
    if (gst_element_set_state(pipeline_, GST_STATE_PLAYING) ==
        GST_STATE_CHANGE_FAILURE) {
      error_ = "JPEG pipeline cannot enter PLAYING";
      release();
      return false;
    }
    return true;
  }

  bool open(int width, int height) {
    release();
    const std::string prefix =
        "appsrc name=poseguard_jpeg_source is-live=true block=false "
        "format=time ! video/x-raw,format=RGB,width=" +
        std::to_string(width) + ",height=" + std::to_string(height) +
        ",framerate=30/1 ! videoconvert ! ";
    const std::string suffix =
        " ! appsink name=poseguard_jpeg_sink emit-signals=false "
        "max-buffers=1 drop=true sync=false";
    if (!launch(prefix + "mppjpegenc q-factor=70" + suffix) &&
        !launch(prefix + "jpegenc quality=70" + suffix)) {
      return false;
    }
    width_ = width;
    height_ = height;
    error_.clear();
    return true;
  }

  void release() {
    if (pipeline_ != nullptr) gst_element_set_state(pipeline_, GST_STATE_NULL);
    if (source_ != nullptr) {
      gst_object_unref(source_);
      source_ = nullptr;
    }
    if (sink_ != nullptr) {
      gst_object_unref(sink_);
      sink_ = nullptr;
    }
    if (pipeline_ != nullptr) {
      gst_object_unref(pipeline_);
      pipeline_ = nullptr;
    }
    width_ = 0;
    height_ = 0;
  }

  GstElement* pipeline_{};
  GstAppSrc* source_{};
  GstAppSink* sink_{};
  int width_{};
  int height_{};
  std::string error_{};
};

class LatestHttpServer {
 public:
  explicit LatestHttpServer(int port) : port_(port) {}
  ~LatestHttpServer() { stop(); }

  bool start() {
    listen_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) {
      error_ = std::strerror(errno);
      return false;
    }
    int reuse = 1;
    setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(static_cast<std::uint16_t>(port_));
    if (bind(listen_fd_, reinterpret_cast<sockaddr*>(&address),
             sizeof(address)) != 0 ||
        listen(listen_fd_, 8) != 0) {
      error_ = std::strerror(errno);
      close(listen_fd_);
      listen_fd_ = -1;
      return false;
    }
    running_.store(true);
    accept_thread_ = std::thread([this] { accept_loop(); });
    return true;
  }

  void publish(std::vector<std::uint8_t> jpeg, std::string status) {
    {
      std::lock_guard<std::mutex> lock(data_mutex_);
      latest_jpeg_ = std::move(jpeg);
      status_ = std::move(status);
      ++sequence_;
    }
    data_ready_.notify_all();
  }

  void update_status(std::string status) {
    std::lock_guard<std::mutex> lock(data_mutex_);
    status_ = std::move(status);
  }

  const std::string& last_error() const { return error_; }

  void stop() {
    if (!running_.exchange(false)) return;
    if (listen_fd_ >= 0) {
      shutdown(listen_fd_, SHUT_RDWR);
      close(listen_fd_);
      listen_fd_ = -1;
    }
    data_ready_.notify_all();
    {
      std::lock_guard<std::mutex> lock(client_mutex_);
      for (const int descriptor : clients_) shutdown(descriptor, SHUT_RDWR);
    }
    if (accept_thread_.joinable()) accept_thread_.join();
    std::vector<std::thread> workers;
    {
      std::lock_guard<std::mutex> lock(worker_mutex_);
      workers.swap(workers_);
    }
    for (auto& worker : workers) {
      if (worker.joinable()) worker.join();
    }
  }

 private:
  static bool send_all(int descriptor, const void* data, std::size_t size) {
    const auto* bytes = static_cast<const std::uint8_t*>(data);
    while (size > 0) {
      const ssize_t sent =
          send(descriptor, bytes, size, MSG_NOSIGNAL);
      if (sent <= 0) return false;
      bytes += sent;
      size -= static_cast<std::size_t>(sent);
    }
    return true;
  }

  static bool send_text(int descriptor, const std::string& text) {
    return send_all(descriptor, text.data(), text.size());
  }

  void accept_loop() {
    while (running_.load()) {
      const int client = accept(listen_fd_, nullptr, nullptr);
      if (client < 0) {
        if (running_.load()) std::this_thread::sleep_for(std::chrono::milliseconds(20));
        continue;
      }
      timeval timeout{2, 0};
      setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
      {
        std::lock_guard<std::mutex> lock(client_mutex_);
        clients_.insert(client);
      }
      std::thread worker([this, client] {
        handle_client(client);
        {
          std::lock_guard<std::mutex> lock(client_mutex_);
          clients_.erase(client);
        }
        close(client);
      });
      std::lock_guard<std::mutex> lock(worker_mutex_);
      workers_.push_back(std::move(worker));
    }
  }

  void send_response(int client, const std::string& content_type,
                     const std::string& body) {
    std::ostringstream header;
    header << "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: "
           << content_type << "\r\nContent-Length: " << body.size()
           << "\r\nCache-Control: no-store\r\n\r\n";
    if (send_text(client, header.str())) send_text(client, body);
  }

  void handle_client(int client) {
    std::array<char, 2048> request{};
    const ssize_t size = recv(client, request.data(), request.size() - 1U, 0);
    if (size <= 0) return;
    const std::string first_line(request.data(), static_cast<std::size_t>(size));
    if (first_line.rfind("GET /status.json ", 0) == 0) {
      std::string status;
      {
        std::lock_guard<std::mutex> lock(data_mutex_);
        status = status_;
      }
      send_response(client, "application/json; charset=utf-8", status);
      return;
    }
    if (first_line.rfind("GET /stream.mjpg ", 0) == 0) {
      const std::string header =
          "HTTP/1.1 200 OK\r\nConnection: close\r\nCache-Control: no-store, "
          "no-cache\r\nPragma: no-cache\r\nContent-Type: "
          "multipart/x-mixed-replace; boundary=frame\r\n\r\n";
      if (!send_text(client, header)) return;
      std::uint64_t seen = 0;
      while (running_.load()) {
        std::vector<std::uint8_t> jpeg;
        {
          std::unique_lock<std::mutex> lock(data_mutex_);
          data_ready_.wait_for(lock, std::chrono::seconds(2), [&] {
            return !running_.load() || sequence_ != seen;
          });
          if (!running_.load()) break;
          if (sequence_ == seen || latest_jpeg_.empty()) continue;
          seen = sequence_;
          jpeg = latest_jpeg_;
        }
        std::ostringstream part;
        part << "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
             << jpeg.size() << "\r\n\r\n";
        if (!send_text(client, part.str()) ||
            !send_all(client, jpeg.data(), jpeg.size()) ||
            !send_text(client, "\r\n")) {
          break;
        }
      }
      return;
    }
    if (first_line.rfind("GET / ", 0) == 0) {
      const std::string page =
          "<!doctype html><html><head><meta charset=utf-8><title>PoseGuard "
          "RK3566</title><style>body{margin:0;background:#111;color:#eee;"
          "font-family:sans-serif;text-align:center}img{max-width:96vw;"
          "max-height:82vh;margin-top:12px}pre{color:#ddd}</style></head>"
          "<body><h2>PoseGuard RK3566</h2><img src=/stream.mjpg><pre "
          "id=s></pre><script>setInterval(()=>fetch('/status.json').then(r=>"
          "r.json()).then(x=>s.textContent=JSON.stringify(x,null,2)),1000)"
          "</script></body></html>";
      send_response(client, "text/html; charset=utf-8", page);
      return;
    }
    send_text(client, "HTTP/1.1 404 Not Found\r\nConnection: close\r\n"
                      "Content-Length: 0\r\n\r\n");
  }

  int port_{};
  int listen_fd_{-1};
  std::atomic<bool> running_{false};
  std::thread accept_thread_{};
  std::mutex data_mutex_{};
  std::condition_variable data_ready_{};
  std::vector<std::uint8_t> latest_jpeg_{};
  std::string status_{"{\"input_state\":\"starting\"}"};
  std::uint64_t sequence_{};
  std::mutex client_mutex_{};
  std::set<int> clients_{};
  std::mutex worker_mutex_{};
  std::vector<std::thread> workers_{};
  std::string error_{};
};

Frame waiting_frame(const Metrics& metrics) {
  Frame frame{};
  frame.width = 640;
  frame.height = 480;
  frame.rgb.resize(640U * 480U * 3U);
  for (std::size_t index = 0; index < frame.rgb.size(); index += 3U) {
    frame.rgb[index] = 18U;
    frame.rgb[index + 1U] = 24U;
    frame.rgb[index + 2U] = 30U;
  }
  return draw_overlay(frame, {}, {}, metrics, "WAITING FOR USB CAMERA");
}

}  // namespace

int run_application(const RuntimeConfig& config) {
  if (config.source != "camera" && config.source != "video") {
    throw std::invalid_argument("source must be camera or video");
  }
  if (config.source == "video" && config.video_path.empty()) {
    throw std::invalid_argument("video source requires --video or video= path");
  }

  stop_requested.store(false);
  std::signal(SIGINT, handle_stop_signal);
  std::signal(SIGTERM, handle_stop_signal);

  RknnPoseEngine engine(config.model_path);
  VideoSourceConfig source_config{};
  source_config.kind = config.source == "video" ? VideoSourceKind::File
                                                 : VideoSourceKind::UsbCamera;
  source_config.path = config.video_path;
  source_config.preferred_device = config.preferred_device;
  VideoSource source(std::move(source_config));
  EventJournal events(config.events_path);
  JpegEncoder encoder{};
  std::optional<LatestHttpServer> http;
  std::string runtime_error;
  if (config.http_enabled) {
    http.emplace(config.http_port);
    if (!http->start()) {
      runtime_error = "HTTP: " + http->last_error();
      http.reset();
    } else {
      std::cout << "http=http://0.0.0.0:" << config.http_port << '\n';
    }
  }

  Metrics metrics{};
  std::optional<PoseCore> core;
  int core_width = 0;
  int core_height = 0;
  std::size_t maximum_tracks = 0;
  double inference_total = 0.0;
  const auto started = std::chrono::steady_clock::now();
  auto last_placeholder = started - std::chrono::seconds(2);

  while (!stop_requested.load()) {
    Frame frame{};
    if (!source.read(frame, 500)) {
      if (source.end_of_stream()) break;
      if (source.waiting_for_camera()) {
        const std::string state = status_json(
            "waiting_for_usb_camera", source.active_device(), {}, {}, metrics,
            events.last_error().empty() ? source.last_error()
                                        : events.last_error());
        if (http) {
          http->update_status(state);
          const auto now = std::chrono::steady_clock::now();
          if (now - last_placeholder >= std::chrono::seconds(1)) {
            auto placeholder = waiting_frame(metrics);
            std::vector<std::uint8_t> jpeg;
            if (encoder.encode(placeholder, jpeg)) {
              http->publish(std::move(jpeg), state);
            }
            last_placeholder = now;
          }
        }
        events.publish({}, 0.0, metrics);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      continue;
    }

    if (frame.timeline_seconds <= 0.0 && config.source == "camera") {
      frame.timeline_seconds =
          std::chrono::duration<double>(std::chrono::steady_clock::now() -
                                        started)
              .count();
    }
    if (!core || frame.width != core_width || frame.height != core_height) {
      CoreConfig core_config = config.core;
      core_config.frame_width = frame.width;
      core_config.frame_height = frame.height;
      core.emplace(core_config);
      core_width = frame.width;
      core_height = frame.height;
    }

    const auto processing_started = std::chrono::steady_clock::now();
    auto observations = engine.infer(frame, metrics);
    auto tracks = core->update_tracks(observations, frame.timeline_seconds);
    auto decisions =
        core->evaluate(tracks, frame.width, frame.height, frame.timeline_seconds);
    ++metrics.frame_index;
    const double elapsed = std::chrono::duration<double>(
                               std::chrono::steady_clock::now() - started)
                               .count();
    metrics.fps = elapsed > 0.0 ? metrics.frame_index / elapsed : 0.0;
    metrics.visible_tracks = tracks.size();
    maximum_tracks = std::max(maximum_tracks, tracks.size());
    inference_total += metrics.inference_ms;
    events.publish(decisions, frame.pts_seconds, metrics);

    Frame canvas = draw_overlay(frame, tracks, decisions, metrics);
    metrics.processing_ms =
        std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - processing_started)
            .count();
    if (http) {
      std::vector<std::uint8_t> jpeg;
      if (encoder.encode(canvas, jpeg)) {
        const std::string error = !events.last_error().empty()
                                      ? events.last_error()
                                      : runtime_error;
        http->publish(std::move(jpeg),
                      status_json("running", source.active_device(), tracks,
                                  decisions, metrics, error));
      } else {
        runtime_error = encoder.last_error();
        http->update_status(status_json("running", source.active_device(),
                                        tracks, decisions, metrics,
                                        runtime_error));
      }
    }

    if (config.max_frames > 0 &&
        metrics.frame_index >= static_cast<std::uint64_t>(config.max_frames)) {
      break;
    }
  }

  source.close();
  if (http) http->stop();
  rusage usage{};
  getrusage(RUSAGE_SELF, &usage);
  const double average_inference =
      metrics.frame_index > 0 ? inference_total / metrics.frame_index : 0.0;
  std::cout << "frames=" << metrics.frame_index
            << " max_tracks=" << maximum_tracks
            << " avg_inference_ms=" << std::fixed << std::setprecision(2)
            << average_inference << " fps=" << metrics.fps
            << " peak_rss_kb=" << usage.ru_maxrss << '\n';
  if (config.max_frames > 0 &&
      metrics.frame_index < static_cast<std::uint64_t>(config.max_frames)) {
    return 1;
  }
  return 0;
}

#else

int run_application(const RuntimeConfig&) {
  std::cerr << "board runtime support is not enabled in this build\n";
  return 2;
}

#endif

}  // namespace poseguard
