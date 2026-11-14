#include "poseguard/preview.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <thread>

#include "poseguard/camera.hpp"
#if defined(__linux__)
#include <fcntl.h>
#include <unistd.h>
#endif

#ifdef POSEGUARD_WITH_GSTREAMER
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#endif

namespace poseguard {
namespace {
using Clock = std::chrono::steady_clock;
std::uint64_t number(const std::string& text, std::uint64_t limit) {
  if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos)
    throw std::invalid_argument("invalid preview number");
  const auto value = std::stoull(text);
  if (value > limit) throw std::invalid_argument("preview value outside limit");
  return value;
}
std::string read(const std::map<std::string, std::string>& q, const char* key,
                 std::string fallback) {
  const auto i = q.find(key);
  return i == q.end() ? fallback : i->second;
}
void save_camera(const std::string& directory, const CameraSettings& c) {
  if (directory.empty()) return;
  std::filesystem::create_directories(directory);
  const auto path = std::filesystem::path(directory) / "camera.settings";
  const auto temp = path.string() + ".new";
  {
    std::ofstream file(temp);
    file << "rotation=" << c.rotation << "\nmirror=" << c.mirror
         << "\nversion=" << c.version << '\n';
    file.flush();
    if (!file) throw std::runtime_error("cannot save camera settings");
  }
#if defined(__linux__)
  const int fd = open(temp.c_str(), O_RDONLY);
  if (fd < 0) throw std::runtime_error("cannot sync camera settings");
  const int synced = fsync(fd);
  close(fd);
  if (synced != 0) throw std::runtime_error("cannot sync camera settings");
#endif
  std::filesystem::rename(temp, path);
#if defined(__linux__)
  const int parent = open(directory.c_str(), O_RDONLY | O_DIRECTORY);
  if (parent >= 0) {
    fsync(parent);
    close(parent);
  }
#endif
}
const char* kind(RiskKind value) {
  return value == RiskKind::PhoneToEar    ? "phone_to_ear"
         : value == RiskKind::MultiPerson ? "multi_person"
                                          : "lingering";
}
Frame resize_frame(const Frame& frame, int side) {
  const double scale = std::min(
      1.0, static_cast<double>(side) / std::max(frame.width, frame.height));
  if (scale == 1.0) return frame;
  Frame out;
  out.width = std::max(16, static_cast<int>(frame.width * scale) / 2 * 2);
  out.height = std::max(16, static_cast<int>(frame.height * scale) / 2 * 2);
  out.pts_seconds = frame.pts_seconds;
  out.timeline_seconds = frame.timeline_seconds;
  out.rgb.resize(static_cast<std::size_t>(out.width) * out.height * 3);
  for (int y = 0; y < out.height; ++y)
    for (int x = 0; x < out.width; ++x) {
      const int sx = std::min(frame.width - 1, x * frame.width / out.width);
      const int sy = std::min(frame.height - 1, y * frame.height / out.height);
      std::copy_n(
          frame.rgb.data() +
              (static_cast<std::size_t>(sy) * frame.width + sx) * 3,
          3,
          out.rgb.data() + (static_cast<std::size_t>(y) * out.width + x) * 3);
    }
  return out;
}
struct Input {
  std::string source_type;
  Frame frame;
  std::vector<TrackState> tracks;
  std::vector<RiskDecision> risks;
  Metrics metrics;
  std::uint64_t captured{};
  std::uint64_t applied{};
  int rotation{};
  bool mirror{};
  std::string epoch;
};
std::string metadata(const Input& in, int width, int height,
                     const std::string& codec, const std::string& codec_string,
                     bool keyframe) {
  std::ostringstream s;
  s << std::fixed << std::setprecision(4);
  s << "{\"sequence\":" << in.metrics.frame_index << ",\"source_epoch\":\""
    << in.epoch << "\",\"codec\":\"" << codec << "\",\"codec_string\":\""
    << codec_string << "\",\"keyframe\":" << (keyframe ? "true" : "false")
    << ",\"width\":" << width << ",\"height\":" << height
    << ",\"captured_ms\":" << in.captured
    << ",\"inference_fps\":" << in.metrics.fps
    << ",\"detector_ready\":true,\"source_type\":\"" << in.source_type
    << "\",\"people\":" << in.tracks.size()
    << ",\"camera_applied_version\":" << in.applied
    << ",\"orientation\":" << in.rotation
    << ",\"mirrored\":" << (in.mirror ? "true" : "false") << ",\"tracks\":[";
  auto x = [&](float value) {
    return std::clamp(value / in.frame.width, 0.F, 1.F);
  };
  auto y = [&](float value) {
    return std::clamp(value / in.frame.height, 0.F, 1.F);
  };
  bool comma = false;
  for (const auto& t : in.tracks) {
    if (comma) s << ',';
    comma = true;
    s << "{\"id\":" << t.track_id
      << ",\"confirmed\":" << (t.confirmed ? "true" : "false")
      << ",\"predicted\":" << (t.predicted ? "true" : "false") << ",\"bbox\":["
      << x(t.bbox.x1) << ',' << y(t.bbox.y1) << ',' << x(t.bbox.x2) << ','
      << y(t.bbox.y2) << "],\"keypoints\":[";
    for (std::size_t i = 0; i < t.keypoints.size(); ++i) {
      if (i) s << ',';
      const auto& p = t.keypoints[i];
      if (!p.valid)
        s << "null";
      else
        s << '[' << x(p.x) << ',' << y(p.y) << ','
          << std::clamp(p.confidence, 0.F, 1.F) << ']';
    }
    s << "]}";
  }
  s << "],\"risks\":[";
  comma = false;
  for (const auto& r : in.risks) {
    if (r.kind == RiskKind::None || r.state == RiskState::Normal) continue;
    if (comma) s << ',';
    comma = true;
    s << "{\"id\":" << r.track_id << ",\"kind\":\"" << kind(r.kind)
      << "\",\"state\":\""
      << (r.state == RiskState::Alert ? "alert" : "candidate") << "\"}";
  }
  s << "]}";
  return s.str();
}

#ifdef POSEGUARD_WITH_GSTREAMER
struct Encoder {
  GstElement* pipeline{};
  GstAppSrc* source{};
  GstAppSink* sink{};
  std::string key, codec_string{"avc1.42001f"};
  bool h264_failed{};
  ~Encoder() { reset(); }
  void reset() {
    if (pipeline) gst_element_set_state(pipeline, GST_STATE_NULL);
    if (source) gst_object_unref(source);
    if (sink) gst_object_unref(sink);
    if (pipeline) gst_object_unref(pipeline);
    pipeline = nullptr;
    source = nullptr;
    sink = nullptr;
    key.clear();
  }
  bool open(const Frame& f, const std::string& codec, int quality, int fps,
            int bitrate) {
    const auto next = std::to_string(f.width) + "x" + std::to_string(f.height) +
                      codec + std::to_string(quality) + ":" +
                      std::to_string(fps) + ":" + std::to_string(bitrate);
    if (pipeline && next == key) return true;
    reset();
    const std::string launch =
        "appsrc name=pgsrc is-live=true format=time block=false ! "
        "video/x-raw,format=RGB,width=" +
        std::to_string(f.width) + ",height=" + std::to_string(f.height) +
        ",framerate=" + std::to_string(fps) + "/1 ! videoconvert ! " +
        (codec == "h264"
             ? "video/x-raw,format=NV12 ! mpph264enc profile=baseline "
               "level=3.1 header-mode=each-idr rc-mode=cbr bps=" +
                   std::to_string(bitrate) + " gop=" + std::to_string(fps) +
                   " ! h264parse config-interval=-1 ! "
                   "video/x-h264,stream-format=byte-stream,alignment=au"
             : "jpegenc quality=" + std::to_string(quality)) +
        " ! appsink name=pgsink max-buffers=1 drop=true sync=false";
    GError* error = nullptr;
    pipeline = gst_parse_launch(launch.c_str(), &error);
    if (!pipeline || error) {
      if (error) g_error_free(error);
      reset();
      return false;
    }
    source = GST_APP_SRC(gst_bin_get_by_name(GST_BIN(pipeline), "pgsrc"));
    sink = GST_APP_SINK(gst_bin_get_by_name(GST_BIN(pipeline), "pgsink"));
    if (!source || !sink ||
        gst_element_set_state(pipeline, GST_STATE_PLAYING) ==
            GST_STATE_CHANGE_FAILURE) {
      reset();
      return false;
    }
    key = next;
    return true;
  }
  bool encode(const Frame& f, std::vector<std::uint8_t>& output, bool& idr) {
    GstBuffer* buffer = gst_buffer_new_allocate(nullptr, f.rgb.size(), nullptr);
    if (!buffer) return false;
    gst_buffer_fill(buffer, 0, f.rgb.data(), f.rgb.size());
    GST_BUFFER_PTS(buffer) =
        static_cast<GstClockTime>(std::max(0., f.pts_seconds) * GST_SECOND);
    if (gst_app_src_push_buffer(source, buffer) != GST_FLOW_OK) return false;
    GstSample* sample = gst_app_sink_try_pull_sample(sink, 500 * GST_MSECOND);
    if (!sample) return false;
    GstBuffer* encoded = gst_sample_get_buffer(sample);
    GstMapInfo map{};
    if (!encoded || !gst_buffer_map(encoded, &map, GST_MAP_READ)) {
      gst_sample_unref(sample);
      return false;
    }
    output.assign(map.data, map.data + map.size);
    gst_buffer_unmap(encoded, &map);
    gst_sample_unref(sample);
    idr = false;
    for (std::size_t i = 0; i + 7 < output.size(); ++i) {
      std::size_t n = 0;
      if (output[i] == 0 && output[i + 1] == 0 && output[i + 2] == 1)
        n = i + 3;
      else if (output[i] == 0 && output[i + 1] == 0 && output[i + 2] == 0 &&
               output[i + 3] == 1)
        n = i + 4;
      if (!n) continue;
      const auto type = output[n] & 31;
      if (type == 5) idr = true;
      if (type == 7 && n + 3 < output.size()) {
        std::ostringstream s;
        s << "avc1." << std::hex << std::setfill('0');
        for (int p = 1; p <= 3; ++p)
          s << std::setw(2) << static_cast<unsigned>(output[n + p]);
        codec_string = s.str();
      }
    }
    return !output.empty();
  }
};
#endif
}  // namespace

std::map<std::string, std::string> preview_query(const std::string& path) {
  std::map<std::string, std::string> result;
  const auto start = path.find('?');
  if (start == std::string::npos) return result;
  std::istringstream fields(path.substr(start + 1));
  std::string part;
  while (std::getline(fields, part, '&')) {
    const auto split = part.find('=');
    if (split == std::string::npos || part.size() > 180)
      throw std::invalid_argument("invalid preview query");
    const auto key = part.substr(0, split), value = part.substr(split + 1);
    if (key.find_first_not_of("abcdefghijklmnopqrstuvwxyz_") !=
            std::string::npos ||
        value.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_.-") !=
            std::string::npos)
      throw std::invalid_argument("invalid preview query encoding");
    if (!result.emplace(key, value).second)
      throw std::invalid_argument("duplicate preview query");
  }
  return result;
}
struct PreviewStream::Impl {
  mutable std::mutex mutex;
  std::condition_variable ready;
  std::thread thread;
  bool running{true};
  CameraSettings camera;
  std::string directory, epoch, source_type;
  Clock::time_point deadline{}, offered{};
  int fps{6}, side{640}, quality{55}, bitrate{420000};
  std::string codec{"jpeg"};
  std::uint64_t applied{}, epoch_count{}, sequence{};
  int rotation{}, learned{};
  bool mirror{}, h264_failed{};
  std::optional<Input> pending;
  std::vector<std::uint8_t> packet;
  std::string packet_epoch;
  explicit Impl(std::string dir, CameraSettings c, std::string input_type)
      : camera(std::move(c)),
        directory(std::move(dir)),
        epoch(std::to_string(Clock::now().time_since_epoch().count())),
        source_type(std::move(input_type)) {}
  bool active() const { return Clock::now() < deadline; }
  void run() {
#ifdef POSEGUARD_WITH_GSTREAMER
    gst_init(nullptr, nullptr);
    Encoder encoder;
    std::string previous;
    std::uint64_t encoder_generation = 0;
#endif
    for (;;) {
      Input input;
      int q, rate, size, bps;
      std::string format;
      {
        std::unique_lock<std::mutex> lock(mutex);
        ready.wait_for(lock, std::chrono::milliseconds(500),
                       [&] { return !running || pending.has_value(); });
        if (!running) break;
        if (!active()) {
          pending.reset();
          packet.clear();
#ifdef POSEGUARD_WITH_GSTREAMER
          encoder.reset();
          previous.clear();
#endif
          continue;
        }
        if (!pending) continue;
        input = std::move(*pending);
        pending.reset();
        q = quality;
        rate = fps;
        size = side;
        bps = bitrate;
        format = h264_failed ? "jpeg" : codec;
      }
#ifdef POSEGUARD_WITH_GSTREAMER
      auto frame = resize_frame(input.frame, size);
      std::vector<std::uint8_t> bytes;
      bool keyframe = format == "jpeg";
      if (!encoder.open(frame, format, q, rate, bps) ||
          !encoder.encode(frame, bytes, keyframe)) {
        if (format == "h264") {
          std::lock_guard<std::mutex> lock(mutex);
          h264_failed = true;
        }
        encoder.reset();
        continue;
      }
      if (encoder.key != previous) {
        previous = encoder.key;
        ++encoder_generation;
      }
      input.epoch += "_" + std::to_string(encoder_generation);
      auto json = metadata(input, frame.width, frame.height, format,
                           encoder.codec_string, keyframe || format == "jpeg");
      if (bytes.size() + json.size() + 8 > 600 * 1024 ||
          json.size() > 24 * 1024)
        continue;
      std::vector<std::uint8_t> encoded(8 + json.size() + bytes.size());
      encoded[0] = 'P';
      encoded[1] = 'G';
      encoded[2] = 'V';
      encoded[3] = '1';
      for (int i = 0; i < 4; ++i)
        encoded[4 + i] = static_cast<std::uint8_t>(json.size() >> (24 - i * 8));
      std::copy(json.begin(), json.end(), encoded.begin() + 8);
      std::copy(bytes.begin(), bytes.end(), encoded.begin() + 8 + json.size());
      {
        std::lock_guard<std::mutex> lock(mutex);
        if (active()) {
          packet = std::move(encoded);
          sequence = input.metrics.frame_index;
          packet_epoch = input.epoch;
        }
      }
#endif
    }
  }
};

PreviewStream::PreviewStream(std::string directory, CameraSettings initial,
                             std::string source_type)
    : impl_(std::make_unique<Impl>(std::move(directory), std::move(initial),
                                   std::move(source_type))) {
  if (!impl_->directory.empty()) {
    std::ifstream file(std::filesystem::path(impl_->directory) /
                       "camera.settings");
    std::string line;
    try {
      CameraSettings settings = impl_->camera;
      while (std::getline(file, line)) {
        const auto at = line.find('=');
        if (at == std::string::npos) continue;
        const auto key = line.substr(0, at), value = line.substr(at + 1);
        if (key == "rotation") settings.rotation = value;
        if (key == "mirror") settings.mirror = value == "1";
        if (key == "version")
          settings.version = number(value, 9007199254740991ULL);
      }
      CameraOrientation check;
      check.configure(settings.rotation, settings.mirror);
      impl_->camera = settings;
    } catch (...) {
    }
    std::ifstream learned(std::filesystem::path(impl_->directory) /
                          "camera.learned");
    int value = 0;
    if (learned >> value &&
        (value == 0 || value == 90 || value == 180 || value == 270))
      impl_->learned = value;
  }
  impl_->thread = std::thread([this] { impl_->run(); });
}
PreviewStream::~PreviewStream() {
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->running = false;
  }
  impl_->ready.notify_all();
  if (impl_->thread.joinable()) impl_->thread.join();
}
void PreviewStream::control(const std::map<std::string, std::string>& q) {
  const auto active = read(q, "active", "0") == "1";
  const int fps = static_cast<int>(number(read(q, "fps", "6"), 15));
  const int side = static_cast<int>(number(read(q, "long_side", "640"), 1280));
  const int quality = static_cast<int>(number(read(q, "quality", "55"), 85));
  const int bitrate =
      static_cast<int>(number(read(q, "bitrate", "420000"), 2000000));
  const auto lease = number(read(q, "lease_ms", "8000"), 10000);
  const auto codec = read(q, "codec", "jpeg");
  if (fps < 1 || side < 240 || quality < 25 || bitrate < 50000 ||
      (codec != "jpeg" && codec != "h264"))
    throw std::invalid_argument("invalid preview profile");
  std::lock_guard<std::mutex> lock(impl_->mutex);
  CameraSettings c = impl_->camera;
  c.rotation = read(q, "rotation", c.rotation);
  c.mirror = read(q, "mirror", c.mirror ? "1" : "0") == "1";
  c.version = number(read(q, "version", std::to_string(c.version)),
                     9007199254740991ULL);
  CameraOrientation check;
  check.configure(c.rotation, c.mirror);
  if (c.version >= impl_->camera.version &&
      (c.rotation != impl_->camera.rotation ||
       c.mirror != impl_->camera.mirror ||
       c.version != impl_->camera.version)) {
    save_camera(impl_->directory, c);
    impl_->camera = c;
  }
  impl_->fps = fps;
  impl_->side = side;
  impl_->quality = quality;
  impl_->bitrate = bitrate;
  impl_->codec = codec;
  impl_->deadline = active ? Clock::now() + std::chrono::milliseconds(lease)
                           : Clock::time_point{};
  if (!active) {
    impl_->pending.reset();
    impl_->packet.clear();
  }
  impl_->ready.notify_all();
}
CameraSettings PreviewStream::camera() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->camera;
}
bool PreviewStream::active() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->active();
}
int PreviewStream::learned_rotation() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->learned;
}
void PreviewStream::applied(std::uint64_t version, int rotation, bool mirror,
                            bool changed) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->applied = version;
  impl_->rotation = rotation;
  impl_->mirror = mirror;
  if (changed) {
    ++impl_->epoch_count;
    impl_->packet.clear();
    impl_->pending.reset();
  }
  if (impl_->learned != rotation) {
    impl_->learned = rotation;
    if (!impl_->directory.empty()) {
      std::filesystem::create_directories(impl_->directory);
      std::ofstream file(std::filesystem::path(impl_->directory) /
                         "camera.learned");
      file << rotation;
    }
  }
}
void PreviewStream::offer(const Frame& frame,
                          const std::vector<TrackState>& tracks,
                          const std::vector<RiskDecision>& risks,
                          const Metrics& metrics) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  const auto now = Clock::now();
  if (!impl_->active() ||
      now - impl_->offered < std::chrono::milliseconds(1000 / impl_->fps))
    return;
  impl_->offered = now;
  Input input{};
  input.frame = frame;
  input.tracks = tracks;
  input.risks = risks;
  input.metrics = metrics;
  input.source_type = impl_->source_type;
  input.captured = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count();
  input.applied = impl_->applied;
  input.rotation = impl_->rotation;
  input.mirror = impl_->mirror;
  input.epoch = impl_->epoch + "_" + std::to_string(impl_->epoch_count);
  impl_->pending = std::move(input);
  impl_->ready.notify_one();
}
std::vector<std::uint8_t> PreviewStream::latest(
    std::uint64_t after, const std::string& epoch) const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (!impl_->active() || impl_->packet.empty() ||
      (epoch == impl_->packet_epoch && impl_->sequence <= after))
    return {};
  return impl_->packet;
}
std::string PreviewStream::status() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  std::ostringstream s;
  s << "{\"active\":" << (impl_->active() ? "true" : "false")
    << ",\"camera_applied_version\":" << impl_->applied
    << ",\"rotation\":" << impl_->rotation
    << ",\"mirror\":" << (impl_->mirror ? "true" : "false")
    << ",\"codecs\":[\"jpeg\"";
#ifdef POSEGUARD_WITH_GSTREAMER
  if (!impl_->h264_failed) {
    GstElementFactory* f = gst_element_factory_find("mpph264enc");
    if (f) {
      s << ",\"h264\"";
      gst_object_unref(f);
    }
  }
#endif
  s << "],\"pose\":true,\"camera\":true}";
  return s.str();
}
}  // namespace poseguard
