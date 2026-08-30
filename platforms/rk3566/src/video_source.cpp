#include "poseguard/video_source.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <utility>

#if defined(__linux__)
#include <fcntl.h>
#include <linux/videodev2.h>
#include <sys/ioctl.h>
#include <unistd.h>
#endif

#if defined(POSEGUARD_WITH_GSTREAMER)
#include <gst/app/gstappsink.h>
#include <gst/gst.h>
#endif

namespace poseguard {
namespace {

std::string read_text(const std::filesystem::path& path) {
  std::ifstream stream(path);
  if (!stream) {
    return {};
  }
  std::ostringstream buffer;
  buffer << stream.rdbuf();
  std::string value = buffer.str();
  while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back()))) {
    value.pop_back();
  }
  return value;
}

std::string lower_copy(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char character) {
                   return static_cast<char>(std::tolower(character));
                 });
  return value;
}

bool is_capture_name(const std::string& name) {
  const std::string lowered = lower_copy(name);
  constexpr const char* rejected[] = {"metadata", "statistics", "params",
                                      "rkisp", "rkcif", "rawrd", "rawwr"};
  for (const auto* marker : rejected) {
    if (lowered.find(marker) != std::string::npos) {
      return false;
    }
  }
  return true;
}

bool has_uvc_driver(const std::filesystem::path& entry) {
  std::error_code error;
  auto current = std::filesystem::weakly_canonical(entry / "device", error);
  if (error) {
    current = entry / "device";
  }
  for (int depth = 0; depth < 6 && !current.empty(); ++depth) {
    const std::string uevent = lower_copy(read_text(current / "uevent"));
    if (uevent.find("driver=uvcvideo") != std::string::npos) {
      return true;
    }
    const auto driver = current / "driver";
    if (std::filesystem::exists(driver, error)) {
      const auto target = std::filesystem::read_symlink(driver, error);
      if (!error && lower_copy(target.filename().string()) == "uvcvideo") {
        return true;
      }
      error.clear();
    }
    const auto parent = current.parent_path();
    if (parent == current) {
      break;
    }
    current = parent;
  }
  return false;
}

int device_index(const std::filesystem::path& path) {
  const std::string name = path.filename().string();
  if (name.rfind("video", 0) != 0 || name.size() <= 5) {
    return -1;
  }
  try {
    return std::stoi(name.substr(5));
  } catch (const std::exception&) {
    return -1;
  }
}

#if defined(__linux__)
struct CameraFormat {
  std::uint32_t pixel_format{};
  int width{};
  int height{};
  int fps{};
};

CameraFormat choose_camera_format(const std::string& path) {
  const int descriptor = open(path.c_str(), O_RDWR | O_NONBLOCK);
  if (descriptor < 0) {
    throw std::runtime_error("cannot open UVC device: " + path);
  }
  constexpr CameraFormat preferences[] = {
      {V4L2_PIX_FMT_MJPEG, 640, 480, 30},
      {V4L2_PIX_FMT_MJPEG, 1280, 720, 30},
      {V4L2_PIX_FMT_YUYV, 640, 480, 30},
  };
  for (const auto& preference : preferences) {
    v4l2_format format{};
    format.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    format.fmt.pix.width = static_cast<std::uint32_t>(preference.width);
    format.fmt.pix.height = static_cast<std::uint32_t>(preference.height);
    format.fmt.pix.pixelformat = preference.pixel_format;
    format.fmt.pix.field = V4L2_FIELD_ANY;
    if (ioctl(descriptor, VIDIOC_S_FMT, &format) != 0 ||
        format.fmt.pix.width != static_cast<std::uint32_t>(preference.width) ||
        format.fmt.pix.height != static_cast<std::uint32_t>(preference.height) ||
        format.fmt.pix.pixelformat != preference.pixel_format) {
      continue;
    }
    v4l2_streamparm parameters{};
    parameters.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    parameters.parm.capture.timeperframe.numerator = 1;
    parameters.parm.capture.timeperframe.denominator =
        static_cast<std::uint32_t>(preference.fps);
    ioctl(descriptor, VIDIOC_S_PARM, &parameters);
    close(descriptor);
    return preference;
  }
  close(descriptor);
  throw std::runtime_error("UVC camera has no supported capture mode: " + path);
}
#endif

#if defined(POSEGUARD_WITH_GSTREAMER)
std::string quote_pipeline_value(const std::string& value) {
  std::string quoted{"\""};
  for (const char character : value) {
    if (character == '\\' || character == '"') {
      quoted.push_back('\\');
    }
    quoted.push_back(character);
  }
  quoted.push_back('"');
  return quoted;
}
#endif

}  // namespace

std::vector<UvcDevice> discover_uvc_devices(
    const std::filesystem::path& sysfs_root,
    const CapabilityProbe& capability_probe) {
  std::vector<std::pair<int, UvcDevice>> indexed;
  std::error_code error;
  if (!std::filesystem::is_directory(sysfs_root, error)) {
    return {};
  }
  for (const auto& entry : std::filesystem::directory_iterator(sysfs_root, error)) {
    if (error) {
      break;
    }
    const int index = device_index(entry.path());
    if (index < 0) {
      continue;
    }
    const std::string name = read_text(entry.path() / "name");
    const std::string device_path = "/dev/video" + std::to_string(index);
    if (name.empty() || !is_capture_name(name) || !has_uvc_driver(entry.path()) ||
        !capability_probe(device_path)) {
      continue;
    }
    indexed.push_back({index, {device_path, name}});
  }
  std::sort(indexed.begin(), indexed.end(),
            [](const auto& lhs, const auto& rhs) { return lhs.first < rhs.first; });
  std::vector<UvcDevice> devices;
  devices.reserve(indexed.size());
  for (auto& item : indexed) {
    devices.push_back(std::move(item.second));
  }
  return devices;
}

bool probe_video_capture(const std::string& device_path) {
#if defined(__linux__)
  const int descriptor = open(device_path.c_str(), O_RDWR | O_NONBLOCK);
  if (descriptor < 0) {
    return false;
  }
  v4l2_capability capability{};
  const bool queried = ioctl(descriptor, VIDIOC_QUERYCAP, &capability) == 0;
  close(descriptor);
  if (!queried) {
    return false;
  }
  const std::uint32_t flags =
      capability.capabilities & V4L2_CAP_DEVICE_CAPS
          ? capability.device_caps
          : capability.capabilities;
  return (flags & V4L2_CAP_VIDEO_CAPTURE) != 0 &&
         (flags & V4L2_CAP_STREAMING) != 0;
#else
  static_cast<void>(device_path);
  return false;
#endif
}

struct VideoSource::Impl {
  explicit Impl(VideoSourceConfig source_config)
      : config(std::move(source_config)) {}

  VideoSourceConfig config;
  std::string device{};
  std::string error{};
  bool eos{};
  std::chrono::steady_clock::time_point last_scan{};
#if defined(POSEGUARD_WITH_GSTREAMER)
  GstElement* pipeline{};
  GstAppSink* sink{};

  void release_pipeline() {
    if (pipeline != nullptr) {
      gst_element_set_state(pipeline, GST_STATE_NULL);
    }
    if (sink != nullptr) {
      gst_object_unref(sink);
      sink = nullptr;
    }
    if (pipeline != nullptr) {
      gst_object_unref(pipeline);
      pipeline = nullptr;
    }
    device.clear();
  }

  bool launch(const std::string& description, const std::string& source_name) {
    GError* launch_error = nullptr;
    pipeline = gst_parse_launch(description.c_str(), &launch_error);
    if (pipeline == nullptr || launch_error != nullptr) {
      error = launch_error != nullptr ? launch_error->message
                                      : "cannot create GStreamer pipeline";
      if (launch_error != nullptr) {
        g_error_free(launch_error);
      }
      release_pipeline();
      return false;
    }
    auto* element = gst_bin_get_by_name(GST_BIN(pipeline), "poseguard_sink");
    if (element == nullptr) {
      error = "GStreamer pipeline has no appsink";
      release_pipeline();
      return false;
    }
    sink = GST_APP_SINK(element);
    if (gst_element_set_state(pipeline, GST_STATE_PLAYING) ==
        GST_STATE_CHANGE_FAILURE) {
      error = "GStreamer pipeline cannot enter PLAYING";
      release_pipeline();
      return false;
    }
    device = source_name;
    error.clear();
    eos = false;
    return true;
  }

  bool open_file() {
    const std::string suffix =
        " ! videoconvert ! video/x-raw,format=RGB ! appsink "
        "name=poseguard_sink emit-signals=false max-buffers=1 drop=true "
        "sync=false";
    const std::string location = quote_pipeline_value(config.path);
    if (launch("filesrc location=" + location +
                   " ! qtdemux ! h264parse ! mppvideodec" + suffix,
               config.path)) {
      return true;
    }
    return launch("filesrc location=" + location + " ! decodebin" + suffix,
                  config.path);
  }

  bool open_camera() {
#if defined(__linux__)
    const auto devices =
        discover_uvc_devices(config.sysfs_root, probe_video_capture);
    if (devices.empty()) {
      error = "waiting for USB camera";
      return false;
    }
    try {
      const UvcDevice* selected = &devices.front();
      if (!config.preferred_device.empty()) {
        const auto match = std::find_if(
            devices.begin(), devices.end(), [&](const UvcDevice& device) {
              return device.path == config.preferred_device;
            });
        if (match == devices.end()) {
          error = "waiting for configured USB camera: " +
                  config.preferred_device;
          return false;
        }
        selected = &*match;
      }
      const auto format = choose_camera_format(selected->path);
      const std::string source = "v4l2src device=" +
                                 quote_pipeline_value(selected->path) +
                                 " io-mode=2 ! ";
      const std::string sink_suffix =
          " ! videoconvert ! video/x-raw,format=RGB ! appsink "
          "name=poseguard_sink emit-signals=false max-buffers=1 drop=true "
          "sync=false";
      if (format.pixel_format == V4L2_PIX_FMT_MJPEG) {
        const std::string caps =
            "image/jpeg,width=" + std::to_string(format.width) +
            ",height=" + std::to_string(format.height) +
            ",framerate=" + std::to_string(format.fps) + "/1";
        if (launch(source + caps + " ! jpegparse ! mppjpegdec" + sink_suffix,
                   selected->path)) {
          return true;
        }
        return launch(source + caps + " ! jpegparse ! jpegdec" + sink_suffix,
                      selected->path);
      }
      const std::string caps =
          "video/x-raw,format=YUY2,width=" + std::to_string(format.width) +
          ",height=" + std::to_string(format.height) +
          ",framerate=" + std::to_string(format.fps) + "/1";
      return launch(source + caps + sink_suffix, selected->path);
    } catch (const std::exception& exception) {
      error = exception.what();
      return false;
    }
#else
    return false;
#endif
  }
#endif
};

VideoSource::VideoSource(VideoSourceConfig config)
    : impl_(std::make_unique<Impl>(std::move(config))) {
#if defined(POSEGUARD_WITH_GSTREAMER)
  static const bool initialized = [] {
    gst_init(nullptr, nullptr);
    return true;
  }();
  static_cast<void>(initialized);
  if (impl_->config.kind == VideoSourceKind::File) {
    impl_->open_file();
  }
#endif
}

VideoSource::~VideoSource() { close(); }
VideoSource::VideoSource(VideoSource&&) noexcept = default;
VideoSource& VideoSource::operator=(VideoSource&&) noexcept = default;

bool VideoSource::read(Frame& frame, int timeout_ms) {
#if defined(POSEGUARD_WITH_GSTREAMER)
  if (impl_->pipeline == nullptr) {
    if (impl_->config.kind == VideoSourceKind::File) {
      impl_->eos = true;
      return false;
    }
    const auto now = std::chrono::steady_clock::now();
    if (impl_->last_scan.time_since_epoch().count() == 0 ||
        std::chrono::duration_cast<std::chrono::milliseconds>(now -
                                                              impl_->last_scan)
                .count() >= impl_->config.rescan_interval_ms) {
      impl_->last_scan = now;
      impl_->open_camera();
    }
    if (impl_->pipeline == nullptr) {
      return false;
    }
  }

  GstSample* sample = gst_app_sink_try_pull_sample(
      impl_->sink, static_cast<GstClockTime>(std::max(0, timeout_ms)) * GST_MSECOND);
  if (sample == nullptr) {
    GstBus* bus = gst_element_get_bus(impl_->pipeline);
    GstMessage* message = gst_bus_pop_filtered(
        bus, static_cast<GstMessageType>(GST_MESSAGE_ERROR | GST_MESSAGE_EOS));
    gst_object_unref(bus);
    if (message != nullptr) {
      if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_EOS) {
        impl_->eos = impl_->config.kind == VideoSourceKind::File;
      } else {
        GError* gst_error = nullptr;
        gchar* details = nullptr;
        gst_message_parse_error(message, &gst_error, &details);
        impl_->error = gst_error != nullptr ? gst_error->message
                                            : "GStreamer source error";
        if (gst_error != nullptr) {
          g_error_free(gst_error);
        }
        g_free(details);
      }
      gst_message_unref(message);
      impl_->release_pipeline();
    }
    return false;
  }

  GstCaps* caps = gst_sample_get_caps(sample);
  GstStructure* structure = caps != nullptr ? gst_caps_get_structure(caps, 0)
                                            : nullptr;
  int width = 0;
  int height = 0;
  if (structure == nullptr ||
      !gst_structure_get_int(structure, "width", &width) ||
      !gst_structure_get_int(structure, "height", &height)) {
    gst_sample_unref(sample);
    impl_->error = "RGB sample has invalid caps";
    return false;
  }
  GstBuffer* buffer = gst_sample_get_buffer(sample);
  GstMapInfo map{};
  const std::size_t expected = static_cast<std::size_t>(width) * height * 3U;
  const bool mapped =
      buffer != nullptr && gst_buffer_map(buffer, &map, GST_MAP_READ);
  if (!mapped || map.size < expected) {
    if (mapped) {
      gst_buffer_unmap(buffer, &map);
    }
    gst_sample_unref(sample);
    impl_->error = "cannot map RGB sample";
    return false;
  }
  frame.width = width;
  frame.height = height;
  frame.rgb.assign(map.data, map.data + expected);
  const GstClockTime pts = GST_BUFFER_PTS(buffer);
  frame.pts_seconds = GST_CLOCK_TIME_IS_VALID(pts)
                          ? static_cast<double>(pts) / GST_SECOND
                          : 0.0;
  frame.timeline_seconds = frame.pts_seconds;
  gst_buffer_unmap(buffer, &map);
  gst_sample_unref(sample);
  impl_->error.clear();
  return true;
#else
  static_cast<void>(frame);
  static_cast<void>(timeout_ms);
  impl_->error = "GStreamer support is not enabled";
  return false;
#endif
}

bool VideoSource::waiting_for_camera() const {
  return impl_->config.kind == VideoSourceKind::UsbCamera &&
         impl_->device.empty();
}

bool VideoSource::end_of_stream() const { return impl_->eos; }

const std::string& VideoSource::active_device() const { return impl_->device; }

const std::string& VideoSource::last_error() const { return impl_->error; }

void VideoSource::close() {
#if defined(POSEGUARD_WITH_GSTREAMER)
  if (impl_) {
    impl_->release_pipeline();
  }
#endif
}

}  // namespace poseguard
