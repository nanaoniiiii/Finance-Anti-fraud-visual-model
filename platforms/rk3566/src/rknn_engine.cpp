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

}  // namespace

struct RknnPoseEngine::Impl {
  rknn_context context{};
  rknn_tensor_attr input_attr{};
  rknn_tensor_attr output_attr{};
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
  if (io_count.n_input != 1 || io_count.n_output != 1) {
    throw std::runtime_error("pose model must have exactly one input and output");
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

  impl_->output_attr.index = 0;
  require_rknn(rknn_query(impl_->context, RKNN_QUERY_OUTPUT_ATTR,
                          &impl_->output_attr, sizeof(impl_->output_attr)),
               "output attribute query");
  if (impl_->output_attr.n_dims != 3) {
    throw std::runtime_error("pose output must be rank 3");
  }
  for (std::size_t index = 0; index < impl_->shape.size(); ++index) {
    impl_->shape[index] = static_cast<int>(impl_->output_attr.dims[index]);
  }
  if (impl_->shape[0] != 1 ||
      (impl_->shape[1] != kPoseChannels &&
       impl_->shape[2] != kPoseChannels)) {
    throw std::runtime_error("pose output must contain 56 channels");
  }

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
  rknn_output output{};
  output.index = 0;
  output.want_float = 0;
  output.is_prealloc = 0;
  require_rknn(rknn_outputs_get(impl_->context, 1, &output, nullptr),
               "output retrieval");

  std::vector<float> decoded;
  try {
    const std::size_t count = impl_->output_attr.n_elems;
    if (impl_->output_attr.type == RKNN_TENSOR_INT8) {
      decoded = dequantize_int8(static_cast<const std::int8_t*>(output.buf),
                                count, impl_->output_attr.zp,
                                impl_->output_attr.scale);
    } else if (impl_->output_attr.type == RKNN_TENSOR_UINT8) {
      const auto* values = static_cast<const std::uint8_t*>(output.buf);
      decoded.resize(count);
      for (std::size_t index = 0; index < count; ++index) {
        decoded[index] =
            (static_cast<std::int32_t>(values[index]) -
             impl_->output_attr.zp) *
            impl_->output_attr.scale;
      }
    } else if (impl_->output_attr.type == RKNN_TENSOR_FLOAT32) {
      const auto* values = static_cast<const float*>(output.buf);
      decoded.assign(values, values + count);
    } else {
      throw std::runtime_error("unsupported RKNN output tensor type");
    }
  } catch (...) {
    rknn_outputs_release(impl_->context, 1, &output);
    throw;
  }
  require_rknn(rknn_outputs_release(impl_->context, 1, &output),
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
