#include "poseguard/display_sink.hpp"
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <chrono>
#include <filesystem>
#include <string>

namespace poseguard {
struct DisplaySink::Impl {
  GstElement* pipeline{};
  GstAppSrc* source{};
  GstElement* sink{};
  int width{};
  int height{};
  std::string error;
  std::chrono::steady_clock::time_point retry_after{};

  void close() {
    if (pipeline) gst_element_set_state(pipeline, GST_STATE_NULL);
    if (source) gst_object_unref(source);
    if (sink) gst_object_unref(sink);
    if (pipeline) gst_object_unref(pipeline);
    pipeline = nullptr;
    source = nullptr;
    sink = nullptr;
  }
  bool fail(const std::string& message) {
    error = message;
    close();
    retry_after = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    return false;
  }
  bool open(int new_width, int new_height) {
    close();
    if (!g_getenv("XDG_RUNTIME_DIR")) {
      const char* directory = std::filesystem::exists("/run/user/0/wayland-0")
                                  ? "/run/user/0" : "/run";
      g_setenv("XDG_RUNTIME_DIR", directory, FALSE);
    }
    const std::string description =
        "appsrc name=poseguard_display_source is-live=true block=false "
        "do-timestamp=true format=time ! video/x-raw,format=RGB,width=" +
        std::to_string(new_width) + ",height=" + std::to_string(new_height) +
        ",framerate=0/1 ! queue max-size-buffers=1 max-size-bytes=0 "
        "max-size-time=0 leaky=downstream ! videoconvert ! "
        "waylandsink name=poseguard_display_sink fullscreen=true sync=false";
    GError* launch_error = nullptr;
    pipeline = gst_parse_launch(description.c_str(), &launch_error);
    if (!pipeline || launch_error) {
      const std::string message = launch_error ? launch_error->message : "cannot create display pipeline";
      if (launch_error) g_error_free(launch_error);
      return fail(message);
    }
    source = GST_APP_SRC(gst_bin_get_by_name(GST_BIN(pipeline), "poseguard_display_source"));
    sink = gst_bin_get_by_name(GST_BIN(pipeline), "poseguard_display_sink");
    if (!source || !sink) return fail("display elements are missing");
    gst_app_src_set_max_bytes(source, static_cast<guint64>(new_width) * new_height * 6U);
    if (gst_element_set_state(pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE)
      return fail("display cannot enter PLAYING (check Weston and XDG_RUNTIME_DIR)");
    width = new_width;
    height = new_height;
    error.clear();
    return true;
  }
};

DisplaySink::DisplaySink() : impl_(std::make_unique<Impl>()) { gst_init(nullptr, nullptr); }
DisplaySink::~DisplaySink() { impl_->close(); }

bool DisplaySink::show(const Frame& frame) {
  if (std::chrono::steady_clock::now() < impl_->retry_after) return false;
  if (!impl_->pipeline || impl_->width != frame.width || impl_->height != frame.height) {
    if (!impl_->open(frame.width, frame.height)) return false;
  }
  GstBus* bus = gst_element_get_bus(impl_->pipeline);
  GstMessage* message = gst_bus_pop_filtered(bus, GST_MESSAGE_ERROR);
  gst_object_unref(bus);
  if (message) {
    GError* error = nullptr;
    gchar* details = nullptr;
    gst_message_parse_error(message, &error, &details);
    const std::string text = error ? error->message : "local display failed";
    if (error) g_error_free(error);
    g_free(details);
    gst_message_unref(message);
    return impl_->fail(text);
  }
  // Bound appsrc memory even if the compositor stops consuming frames.
  if (gst_app_src_get_current_level_bytes(impl_->source) >= frame.rgb.size() * 2U) return true;
  GstBuffer* buffer = gst_buffer_new_allocate(nullptr, frame.rgb.size(), nullptr);
  if (!buffer) return impl_->fail("cannot allocate display buffer");
  if (gst_buffer_fill(buffer, 0, frame.rgb.data(), frame.rgb.size()) != frame.rgb.size()) {
    gst_buffer_unref(buffer);
    return impl_->fail("cannot fill display buffer");
  }
  if (gst_app_src_push_buffer(impl_->source, buffer) != GST_FLOW_OK)
    return impl_->fail("display rejected the frame");
  impl_->error.clear();
  return true;
}

std::uint64_t DisplaySink::rendered_frames() const {
  if (!impl_->sink) return 0;
  GstStructure* stats = nullptr;
  g_object_get(impl_->sink, "stats", &stats, nullptr);
  guint64 rendered = 0;
  if (stats) {
    gst_structure_get_uint64(stats, "rendered", &rendered);
    gst_structure_free(stats);
  }
  return rendered;
}
const std::string& DisplaySink::last_error() const { return impl_->error; }
}  // namespace poseguard
