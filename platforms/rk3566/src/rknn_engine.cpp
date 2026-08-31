#include "poseguard/rknn_pose.hpp"

#include <rknn_api.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <utility>

namespace poseguard {
namespace {

constexpr int kModelSize = 320;
constexpr int kPoseChannels = 56;
constexpr std::array<int, 4> kSplitChannels{4, 1, 51, 17};

void require_rknn(int code, const char* operation) {
  if (code != RKNN_SUCC) {
    throw std::runtime_error(std::string{"RKNN "} + operation +
                             " failed with code " + std::to_string(code));
  }
}

std::vector<std::uint8_t> read_model(const std::string& model_path) {
  std::ifstream stream(model_path, std::ios::binary | std::ios::ate);
  if (!stream) {
    throw std::runtime_error("cannot open RKNN model: " + model_path);
  }
  const auto length = stream.tellg();
  if (length <= 0) {
    throw std::runtime_error("RKNN model is empty: " + model_path);
  }
  std::vector<std::uint8_t> model(static_cast<std::size_t>(length));
  stream.seekg(0, std::ios::beg);
  if (!stream.read(reinterpret_cast<char*>(model.data()), length)) {
    throw std::runtime_error("cannot read RKNN model: " + model_path);
  }
  return model;
}

std::vector<std::uint8_t> make_letterbox(const Frame& frame,
                                         Letterbox& transform) {
  if (frame.width <= 0 || frame.height <= 0 ||
      frame.rgb.size() != static_cast<std::size_t>(frame.width) *
                              static_cast<std::size_t>(frame.height) * 3U) {
    throw std::invalid_argument("invalid RGB frame");
  }
  transform.scale =
      std::min(static_cast<float>(kModelSize) / frame.width,
               static_cast<float>(kModelSize) / frame.height);
  const int resized_width =
      std::max(1, static_cast<int>(std::lround(frame.width * transform.scale)));
  const int resized_height =
      std::max(1, static_cast<int>(std::lround(frame.height * transform.scale)));
  const int pad_x = (kModelSize - resized_width) / 2;
  const int pad_y = (kModelSize - resized_height) / 2;
  transform.pad_x = static_cast<float>(pad_x);
  transform.pad_y = static_cast<float>(pad_y);
  transform.source_width = frame.width;
  transform.source_height = frame.height;

  std::vector<std::uint8_t> output(
      static_cast<std::size_t>(kModelSize) * kModelSize * 3U, 114U);
  for (int target_y = 0; target_y < resized_height; ++target_y) {
    const float source_y =
        std::clamp((target_y + 0.5F) / transform.scale - 0.5F, 0.0F,
                   static_cast<float>(frame.height - 1));
    const int y0 = static_cast<int>(source_y);
    const int y1 = std::min(y0 + 1, frame.height - 1);
    const float y_weight = source_y - y0;
    for (int target_x = 0; target_x < resized_width; ++target_x) {
      const float source_x =
          std::clamp((target_x + 0.5F) / transform.scale - 0.5F, 0.0F,
                     static_cast<float>(frame.width - 1));
      const int x0 = static_cast<int>(source_x);
      const int x1 = std::min(x0 + 1, frame.width - 1);
      const float x_weight = source_x - x0;
      for (int channel = 0; channel < 3; ++channel) {
        const auto sample = [&](int x, int y) {
          return frame.rgb[(static_cast<std::size_t>(y) * frame.width + x) *
                               3U +
                           channel];
        };
        const float top = sample(x0, y0) * (1.0F - x_weight) +
                          sample(x1, y0) * x_weight;
        const float bottom = sample(x0, y1) * (1.0F - x_weight) +
                             sample(x1, y1) * x_weight;
        const float value = top * (1.0F - y_weight) + bottom * y_weight;
        const std::size_t destination =
            (static_cast<std::size_t>(target_y + pad_y) * kModelSize +
             target_x + pad_x) *
                3U +
            channel;
        output[destination] = static_cast<std::uint8_t>(
            std::clamp(std::lround(value), 0L, 255L));
      }
    }
  }
  return output;
}

int output_anchor_count(const rknn_tensor_attr& attribute,
                        int expected_channels) {
  if (attribute.n_dims != 3 || attribute.dims[0] != 1) {
    throw std::runtime_error("pose output must be rank 3 with batch size 1");
  }
  if (attribute.dims[1] == static_cast<std::uint32_t>(expected_channels)) {
    return static_cast<int>(attribute.dims[2]);
  }
  if (attribute.dims[2] == static_cast<std::uint32_t>(expected_channels)) {
    return static_cast<int>(attribute.dims[1]);
  }
  throw std::runtime_error("pose output channel count does not match contract");
}

std::vector<float> decode_tensor(const rknn_tensor_attr& attribute,
                                 const rknn_output& output) {
  const std::size_t count = attribute.n_elems;
  if (output.buf == nullptr && count != 0) {
    throw std::runtime_error("RKNN returned a null output buffer");
  }
  if (attribute.type == RKNN_TENSOR_INT8) {
    return dequantize_int8(static_cast<const std::int8_t*>(output.buf), count,
                           attribute.zp, attribute.scale);
  }
  std::vector<float> decoded(count);
  if (attribute.type == RKNN_TENSOR_UINT8) {
    const auto* values = static_cast<const std::uint8_t*>(output.buf);
    for (std::size_t index = 0; index < count; ++index) {
      decoded[index] =
          (static_cast<std::int32_t>(values[index]) - attribute.zp) *
          attribute.scale;
    }
    return decoded;
  }
  if (attribute.type == RKNN_TENSOR_FLOAT32) {
    const auto* values = static_cast<const float*>(output.buf);
    std::copy(values, values + count, decoded.begin());
    return decoded;
  }
  throw std::runtime_error("unsupported RKNN output tensor type");
}

std::vector<float> to_channel_major(const std::vector<float>& values,
                                    const rknn_tensor_attr& attribute,
                                    int expected_channels,
                                    int expected_anchors) {
  const int anchors = output_anchor_count(attribute, expected_channels);
  if (anchors != expected_anchors ||
      values.size() !=
          static_cast<std::size_t>(expected_channels * expected_anchors)) {
    throw std::runtime_error("pose output anchor count does not match contract");
  }
  if (attribute.dims[1] == static_cast<std::uint32_t>(expected_channels)) {
    return values;
  }

  std::vector<float> transposed(values.size());
  for (int anchor = 0; anchor < anchors; ++anchor) {
    for (int channel = 0; channel < expected_channels; ++channel) {
      transposed[static_cast<std::size_t>(channel) * anchors + anchor] =
          values[static_cast<std::size_t>(anchor) * expected_channels + channel];
    }
  }
  return transposed;
}

}  // namespace

struct RknnPoseEngine::Impl {
  rknn_context context{};
  rknn_tensor_attr input_attr{};
  std::vector<rknn_tensor_attr> output_attrs;
  std::array<int, 3> shape{};
  std::string runtime{};
  std::string driver{};
  float score_threshold{};
  float keypoint_threshold{};
  float nms_threshold{};

  ~Impl() {
    if (context != 0) {
      rknn_destroy(context);
    }
  }
};

RknnPoseEngine::RknnPoseEngine(const std::string& model_path,
                               float score_threshold,
                               float keypoint_threshold, float nms_threshold)
    : impl_(std::make_unique<Impl>()) {
  impl_->score_threshold = score_threshold;
  impl_->keypoint_threshold = keypoint_threshold;
  impl_->nms_threshold = nms_threshold;
  auto model = read_model(model_path);
  require_rknn(rknn_init(&impl_->context, model.data(),
                         static_cast<std::uint32_t>(model.size()), 0, nullptr),
               "initialization");

  rknn_input_output_num io_count{};
  require_rknn(rknn_query(impl_->context, RKNN_QUERY_IN_OUT_NUM, &io_count,
                          sizeof(io_count)),
               "I/O query");
  if (io_count.n_input != 1 ||
      (io_count.n_output != 1 && io_count.n_output != 4)) {
    throw std::runtime_error(
        "pose model must have one combined or four split outputs");
  }

  impl_->input_attr.index = 0;
  require_rknn(rknn_query(impl_->context, RKNN_QUERY_INPUT_ATTR,
                          &impl_->input_attr, sizeof(impl_->input_attr)),
               "input attribute query");
  if (impl_->input_attr.n_dims != 4) {
    throw std::runtime_error("pose input must be rank 4");
  }
  const bool valid_nchw =
      impl_->input_attr.fmt == RKNN_TENSOR_NCHW &&
      impl_->input_attr.dims[1] == 3 &&
      impl_->input_attr.dims[2] == kModelSize &&
      impl_->input_attr.dims[3] == kModelSize;
  const bool valid_nhwc =
      impl_->input_attr.fmt == RKNN_TENSOR_NHWC &&
      impl_->input_attr.dims[1] == kModelSize &&
      impl_->input_attr.dims[2] == kModelSize &&
      impl_->input_attr.dims[3] == 3;
  if (!valid_nchw && !valid_nhwc) {
    throw std::runtime_error("pose input must be static RGB 320x320");
  }

  impl_->output_attrs.resize(io_count.n_output);
  int anchors = 0;
  for (std::size_t index = 0; index < impl_->output_attrs.size(); ++index) {
    auto& attribute = impl_->output_attrs[index];
    attribute.index = static_cast<std::uint32_t>(index);
    require_rknn(rknn_query(impl_->context, RKNN_QUERY_OUTPUT_ATTR, &attribute,
                            sizeof(attribute)),
                 "output attribute query");
    const int expected_channels =
        impl_->output_attrs.size() == 1 ? kPoseChannels : kSplitChannels[index];
    const int current_anchors =
        output_anchor_count(attribute, expected_channels);
    if (current_anchors <= 0 || (anchors != 0 && current_anchors != anchors)) {
      throw std::runtime_error("pose outputs use inconsistent anchor counts");
    }
    anchors = current_anchors;
  }
  impl_->shape = {1, kPoseChannels, anchors};

  rknn_sdk_version version{};
  require_rknn(rknn_query(impl_->context, RKNN_QUERY_SDK_VERSION, &version,
                          sizeof(version)),
               "version query");
  impl_->runtime = version.api_version;
  impl_->driver = version.drv_version;
}

RknnPoseEngine::~RknnPoseEngine() = default;
RknnPoseEngine::RknnPoseEngine(RknnPoseEngine&&) noexcept = default;
RknnPoseEngine& RknnPoseEngine::operator=(RknnPoseEngine&&) noexcept = default;

std::vector<PoseObservation> RknnPoseEngine::infer(const Frame& frame,
                                                   Metrics& metrics) {
  Letterbox transform{};
  auto input_pixels = make_letterbox(frame, transform);
  rknn_input input{};
  input.index = 0;
  input.buf = input_pixels.data();
  input.size = static_cast<std::uint32_t>(input_pixels.size());
  input.pass_through = 0;
  input.type = RKNN_TENSOR_UINT8;
  input.fmt = RKNN_TENSOR_NHWC;

  const auto started = std::chrono::steady_clock::now();
  require_rknn(rknn_inputs_set(impl_->context, 1, &input), "input set");
  require_rknn(rknn_run(impl_->context, nullptr), "inference");
  std::vector<rknn_output> outputs(impl_->output_attrs.size());
  for (std::size_t index = 0; index < outputs.size(); ++index) {
    outputs[index].index = static_cast<std::uint32_t>(index);
    outputs[index].want_float = 0;
    outputs[index].is_prealloc = 0;
  }
  require_rknn(rknn_outputs_get(
                   impl_->context, static_cast<std::uint32_t>(outputs.size()),
                   outputs.data(), nullptr),
               "output retrieval");

  std::vector<float> decoded;
  try {
    const int anchors = impl_->shape[2];
    if (outputs.size() == 1) {
      decoded = to_channel_major(
          decode_tensor(impl_->output_attrs[0], outputs[0]),
          impl_->output_attrs[0], kPoseChannels, anchors);
    } else {
      std::array<std::vector<float>, 4> components;
      for (std::size_t index = 0; index < components.size(); ++index) {
        components[index] = to_channel_major(
            decode_tensor(impl_->output_attrs[index], outputs[index]),
            impl_->output_attrs[index], kSplitChannels[index], anchors);
      }
      decoded = merge_split_pose_outputs(
          components[0], components[1], components[2], components[3], anchors);
    }
  } catch (...) {
    rknn_outputs_release(impl_->context,
                         static_cast<std::uint32_t>(outputs.size()),
                         outputs.data());
    throw;
  }
  require_rknn(rknn_outputs_release(
                   impl_->context, static_cast<std::uint32_t>(outputs.size()),
                   outputs.data()),
               "output release");
  const auto finished = std::chrono::steady_clock::now();
  metrics.inference_ms =
      std::chrono::duration<double, std::milli>(finished - started).count();
  ++metrics.frame_index;
  return decode_pose(decoded, impl_->shape, transform, impl_->score_threshold,
                     impl_->keypoint_threshold, impl_->nms_threshold);
}

const std::string& RknnPoseEngine::runtime_version() const {
  return impl_->runtime;
}

const std::string& RknnPoseEngine::driver_version() const {
  return impl_->driver;
}

std::array<int, 3> RknnPoseEngine::output_shape() const {
  return impl_->shape;
}

}  // namespace poseguard
