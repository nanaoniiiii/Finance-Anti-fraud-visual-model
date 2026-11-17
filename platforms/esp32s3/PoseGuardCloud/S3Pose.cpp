#if defined(POSEGUARD_S3_MODEL)
#include "S3Pose.h"
#include "RotateRgb.h"
#include "ScaledJpeg.h"
#include "PackRgb.h"

#include <LittleFS.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <cmath>

#include "dl_image_jpeg.hpp"
#include "dl_image_preprocessor.hpp"
#include "dl_model_base.hpp"

namespace {
class InferencePriority {
 public:
  InferencePriority() : previous_(uxTaskPriorityGet(nullptr)) {
    if (previous_ < 3) vTaskPrioritySet(nullptr, 3);
  }
  ~InferencePriority() { if (previous_ < 3) vTaskPrioritySet(nullptr, previous_); }
 private:
  UBaseType_t previous_;
};
class RgbProxyModel : public dl::Model {
 public:
  explicit RgbProxyModel(const dl::TensorBase* packed)
      : rgb_({1,packed->shape[1]*2,packed->shape[2]*2,3}, nullptr,
              int(packed->exponent), dl::DATA_TYPE_INT8, true, MALLOC_CAP_SPIRAM) {}
  dl::TensorBase* get_input() override { return &rgb_; }
  dl::TensorBase* get_input(const std::string&) override { return &rgb_; }
 private:
  dl::TensorBase rgb_;
};
bool modelEnvelope(const uint8_t* bytes, size_t length) {
  if (!bytes || length < 16 || memcmp(bytes, "EDL2", 4) != 0) return false;
  uint32_t mode = 0, payload = 0;
  memcpy(&mode, bytes + 4, 4);
  memcpy(&payload, bytes + 8, 4);
  return mode == 0 && payload >= 1024 && uint64_t(payload) + 16 <= length &&
         length - (uint64_t(payload) + 16) < 16;
}
String modelDigest(const uint8_t* bytes, size_t length) {
  uint8_t digest[32];
  mbedtls_sha256(bytes, length, digest, 0);
  char hex[65];
  for (int i = 0; i < 32; ++i) sprintf(hex + 2 * i, "%02x", digest[i]);
  hex[64] = 0;
  return String(hex);
}
String fileDigest(File& file) {
  file.seek(0);
  mbedtls_sha256_context hash;
  mbedtls_sha256_init(&hash);
  mbedtls_sha256_starts(&hash, 0);
  uint8_t bytes[1024];
  while (file.available()) {
    const size_t count = file.read(bytes, sizeof(bytes));
    if (!count) break;
    mbedtls_sha256_update(&hash, bytes, count);
  }
  uint8_t digest[32];
  mbedtls_sha256_finish(&hash, digest);
  mbedtls_sha256_free(&hash);
  char hex[65];
  for (int i = 0; i < 32; ++i) sprintf(hex + 2 * i, "%02x", digest[i]);
  hex[64] = 0;
  return String(hex);
}
bool acceptedModel(const JsonDocument& manifest, size_t length,
                   const String& digest) {
  for (JsonObjectConst item : manifest["accepted"].as<JsonArrayConst>())
    if (item["bytes"].as<size_t>() == length &&
        item["sha256"].as<String>() == digest)
      return true;
  return false;
}
using poseguard::Point;
Point original(Point p, int width, int height, int rotation, bool mirror) {
  const int correctedWidth = rotation % 180 ? height : width;
  if (mirror) p.x = correctedWidth - 1 - p.x;
  if (rotation == 90) return {p.y, height - 1 - p.x};
  if (rotation == 180) return {width - 1 - p.x, height - 1 - p.y};
  if (rotation == 270) return {width - 1 - p.y, p.x};
  return p;
}
poseguard::BBox original(poseguard::BBox box, int width, int height,
                         int rotation, bool mirror) {
  const auto a =
      original(Point{box.x1, box.y1}, width, height, rotation, mirror);
  const auto b =
      original(Point{box.x2, box.y2}, width, height, rotation, mirror);
  return {std::min(a.x, b.x), std::min(a.y, b.y), std::max(a.x, b.x),
          std::max(a.y, b.y)};
}
dl::image::img_t rotate(const dl::image::img_t& image, int rotation,
                        bool mirror) {
  const int width = rotation % 180 ? image.height : image.width;
  const int height = rotation % 180 ? image.width : image.height;
  auto* pixels = static_cast<uint8_t*>(
      heap_caps_malloc(static_cast<size_t>(width) * height * 3,
                       MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!pixels) return {};
  if (!poseguard_image::rotate_rgb888(static_cast<const uint8_t*>(image.data),
                                     pixels,image.width,image.height,rotation,mirror)) {
    heap_caps_free(pixels); return {};
  }
  return {.data = pixels,
          .width = static_cast<uint16_t>(width),
          .height = static_cast<uint16_t>(height),
          .pix_type = dl::image::DL_IMAGE_PIX_TYPE_RGB888};
}
float orientationQuality(
    const std::vector<poseguard::PoseObservation>& observations) {
  float score = 0;
  float strongest = 0;
  for(const auto& person:observations)strongest=std::max(strongest,person.confidence);
  for (const auto& person : observations) {
    // An upright low-confidence duplicate must not outweigh the primary
    // person's inverted anatomy when determining the camera installation.
    if(person.confidence<strongest*.8f)continue;
    int valid = 0;
    float confidence = 0;
    for (const auto& p : person.keypoints)
      if (p.valid) {
        ++valid;
        confidence += p.confidence;
      }
    if (valid < 6 || person.confidence < .25f) continue;
    // Do not reward weak, hallucinated legs more than a reliable close-up
    // head. Mean joint confidence remains comparable across partial bodies.
    float quality = person.confidence * .8f + confidence / valid * 3.f;
    const auto& p = person.keypoints;
    const float height = std::max(1.f, person.bbox.y2 - person.bbox.y1);
    if (p[1].valid && p[2].valid &&
        std::min(p[1].confidence, p[2].confidence) >= .5f) {
      const float span = std::hypot(p[1].x - p[2].x, p[1].y - p[2].y);
      if (span > height * .015f) {
        const float horizontal = std::abs(p[1].x - p[2].x) / span;
        quality += horizontal * std::min(p[1].confidence,p[2].confidence) -
                   (horizontal < .5f ? 1.f : 0.f);
      }
    }
    if (p[5].valid && p[6].valid) {
      const float sx = (p[5].x + p[6].x) / 2, sy = (p[5].y + p[6].y) / 2;
      if (p[0].valid) {
        const float distance = std::hypot(sx - p[0].x, sy - p[0].y);
        if (distance > height * .04f) {
          const float upright = (sy - p[0].y) / distance;
          quality += 1.8f * upright - (upright < .4f ? 1.f : 0.f);
        }
      }
      const float span = std::hypot(p[5].x - p[6].x, p[5].y - p[6].y);
      if (span > height * .05f)
        quality += .45f * std::abs(p[5].x - p[6].x) / span;
      if (p[11].valid && p[12].valid) {
        const bool hipsBelow=sy < (p[11].y+p[12].y)/2-height*.06f;
        if(!hipsBelow)quality-=.8f*std::min(p[11].confidence,p[12].confidence);
        else if(!p[0].valid)quality+=.8f*std::min(p[11].confidence,p[12].confidence);
      }
    }
    score = std::max(score, quality);
  }
  return score;
}
}  // namespace
struct S3PoseModel::Impl {
  uint8_t* modelBytes{};
  size_t length{}, capacity{};
  std::unique_ptr<dl::Model> model;
  std::unique_ptr<dl::image::ImagePreprocessor> pre;
  std::unique_ptr<RgbProxyModel> rgbProxy;
  std::unique_ptr<poseguard::PoseCore> core;
  int width{}, height{}, activeRotation{-1}, autoRotation{};
  unsigned emptyFrames{};
  int probeRotation{90};
  unsigned probeBurst{3};
  uint64_t nextProbeUs{};
  std::array<uint8_t, 64> previousLuma{};
  bool lumaReady{};
  bool activeMirror{};
  bool dualCore{true};
  unsigned internalBytes{65536}, loadedInternalBytes{};
  unsigned decodeLimit{};
  unsigned workingLimit() const {
    if (decodeLimit) return decodeLimit;
    return model && model->get_input()->shape[1]*(rgbProxy?2:1)<=128 ? 128 : 384;
  }
  std::vector<poseguard::PoseObservation> detect(const dl::image::img_t& image,
                                                 float& latency) {
    pre->preprocess(image);
    if (rgbProxy) {
      const auto* rgb = rgbProxy->get_input();
      poseguard_image::pack_rgb3x3_s2(static_cast<const int8_t*>(rgb->data),
          static_cast<int8_t*>(model->get_input()->data),rgb->shape[2],rgb->shape[1]);
    }
    const int64_t started = esp_timer_get_time();
    model->run(dualCore ? dl::RUNTIME_MODE_MULTI_CORE : dl::RUNTIME_MODE_SINGLE_CORE);
    latency = (esp_timer_get_time() - started) / 1000.f;
    // Preserve true keypoint confidence from the raw head. ESP-DL's stock
    // COCO wrapper exposes coordinates alone and filters raw visibility logits.
    std::vector<poseguard::PoseObservation> candidates;
    const float sx = pre->get_resize_scale_x(true),
                sy = pre->get_resize_scale_y(true);
    const float px = pre->get_border_left(), py = pre->get_border_top();
    auto value = [](const dl::TensorBase* tensor, int index) {
      const float v =
          tensor->dtype == dl::DATA_TYPE_INT8
              ? float(static_cast<const int8_t*>(tensor->data)[index])
              : float(static_cast<const int16_t*>(tensor->data)[index]);
      return std::ldexp(v, tensor->exponent);
    };
    auto sigmoid = [](float v) {
      return 1.f / (1.f + std::exp(-std::clamp(v, -30.f, 30.f)));
    };
    for (int stage = 0; stage < 3; ++stage) {
      auto* boxes = model->get_output("box" + std::to_string(stage));
      auto* scores = model->get_output("score" + std::to_string(stage));
      auto* points = model->get_output("kpt" + std::to_string(stage));
      const int height = scores->shape[1], width = scores->shape[2],
                stride = 8 << stage;
      for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x) {
          const int cell = y * width + x;
          const float score = sigmoid(value(scores, cell));
          if (score < .3f) continue;
          float distance[4]{};
          for (int side = 0; side < 4; ++side) {
            float peak = -1000;
            for (int bin = 0; bin < 16; ++bin)
              peak = std::max(peak, value(boxes, cell * 64 + side * 16 + bin));
            float sum = 0, weighted = 0;
            for (int bin = 0; bin < 16; ++bin) {
              const float weight =
                  std::exp(value(boxes, cell * 64 + side * 16 + bin) - peak);
              sum += weight;
              weighted += weight * bin;
            }
            distance[side] = weighted / std::max(sum, 1e-9f) * stride;
          }
          poseguard::PoseObservation item;
          item.confidence = score;
          item.bbox = {std::clamp(((x + .5f) * stride - distance[0] - px) * sx,
                                  0.f, float(image.width - 1)),
                       std::clamp(((y + .5f) * stride - distance[1] - py) * sy,
                                  0.f, float(image.height - 1)),
                       std::clamp(((x + .5f) * stride + distance[2] - px) * sx,
                                  0.f, float(image.width - 1)),
                       std::clamp(((y + .5f) * stride + distance[3] - py) * sy,
                                  0.f, float(image.height - 1))};
          for (int k = 0; k < 17; ++k) {
            const int offset = cell * 51 + k * 3;
            const float confidence = sigmoid(value(points, offset + 2));
            const float kx = ((value(points, offset) * 2 + x) * stride - px) *
                             sx,
                        ky = ((value(points, offset + 1) * 2 + y) * stride -
                              py) *
                             sy;
            item.keypoints[k] = {std::clamp(kx, 0.f, float(image.width - 1)),
                                 std::clamp(ky, 0.f, float(image.height - 1)),
                                 confidence,
                                 confidence >= .25f && kx >= 0 && ky >= 0 &&
                                     kx < image.width && ky < image.height};
          }
          candidates.push_back(item);
        }
    }
    std::sort(candidates.begin(), candidates.end(),
              [](const auto& a, const auto& b) {
                return a.confidence > b.confidence;
              });
    std::vector<poseguard::PoseObservation> kept;
    for (auto& item : candidates) {
      bool duplicate = false;
      for (const auto& other : kept) {
        const auto& a = item.bbox;
        const auto& b = other.bbox;
        const float intersection =
            std::max(0.f, std::min(a.x2, b.x2) - std::max(a.x1, b.x1)) *
            std::max(0.f, std::min(a.y2, b.y2) - std::max(a.y1, b.y1));
        const float area = (a.x2 - a.x1) * (a.y2 - a.y1) +
                           (b.x2 - b.x1) * (b.y2 - b.y1) - intersection;
        if (area > 0 && intersection / area > .65f) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) {
        item.detection_index = kept.size();
        kept.push_back(item);
        if (kept.size() >= 8) break;
      }
    }
    return kept;
  }
};
S3PoseModel::S3PoseModel() : state_(new Impl) {}
void S3PoseModel::runtimeOptions(bool dualCore, unsigned internalBytes) {
  state_->dualCore = dualCore;
  state_->internalBytes = internalBytes;
}
void S3PoseModel::preprocessLimit(unsigned longSide) {
  state_->decodeLimit=longSide;
  resetTimeline();
}
void S3PoseModel::profile() {
  if (!ready()) return;
  InferencePriority priority;
  const auto info = state_->model->get_module_info();
  std::vector<std::pair<std::string, dl::module_info>> rows(info.begin(), info.end());
  std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) {
    return a.second.latency > b.second.latency;
  });
  for (const auto& row : rows)
    Serial.printf("PG_PROFILE %s %s %lu\n", row.first.c_str(), row.second.type.c_str(),
                  static_cast<unsigned long>(row.second.latency));
}
S3PoseModel::~S3PoseModel() {
  unload();
  heap_caps_free(state_->modelBytes);
}
void S3PoseModel::unload() {
  state_->core.reset();
  state_->pre.reset();
  state_->rgbProxy.reset();
  state_->model.reset();
  state_->length = 0;
}
uint8_t* S3PoseModel::uploadBuffer(size_t length) {
  unload();
  if (length > 3500000) return nullptr;
  if (!state_->modelBytes) {
    state_->modelBytes = static_cast<uint8_t*>(heap_caps_aligned_alloc(
        16, 3500000, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (state_->modelBytes) state_->capacity = 3500000;
  }
  return state_->capacity >= length ? state_->modelBytes : nullptr;
}
bool S3PoseModel::ready() const { return state_->model != nullptr; }
bool S3PoseModel::loadOwned(uint8_t* bytes, size_t length) {
  unload();
  if (!bytes || length < 1024 || length > 3500000 ||
      !modelEnvelope(bytes, length)) {
    if (bytes != state_->modelBytes) heap_caps_free(bytes);
    return false;
  }
  if (bytes != state_->modelBytes) {
    heap_caps_free(state_->modelBytes);
    state_->modelBytes = bytes;
    state_->capacity = length;
  }
  state_->length = length;
  // Parsing the graph creates many small temporary map nodes. Keep those in
  // PSRAM so they cannot exhaust SIMD-capable SRAM before tensor allocation.
  heap_caps_malloc_extmem_enable(0);
  const unsigned budgets[]={state_->internalBytes,std::min(state_->internalBytes,32768U),0};
  unsigned previous=~0U;
  for(const unsigned budget:budgets) {
    if(budget==previous)continue;
    previous=budget;
    state_->model.reset(new dl::Model(reinterpret_cast<const char*>(bytes),
                                      fbs::MODEL_LOCATION_IN_FLASH_RODATA,budget,
                                      dl::MEMORY_MANAGER_GREEDY,nullptr,false));
    state_->model->minimize();
    if(state_->model->get_input()&&state_->model->get_input()->data&&state_->model->get_outputs().size()==9) {
      state_->loadedInternalBytes=budget;break;
    }
    state_->model.reset();
  }
  heap_caps_malloc_extmem_enable(CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL);
  if (!state_->model) {
    unload();
    return false;
  }
  auto* input = state_->model->get_input();
  if (input->shape.size()!=4 || input->dtype!=dl::DATA_TYPE_INT8 ||
      (input->shape[3]!=3 && input->shape[3]!=32)) { unload(); return false; }
  dl::Model* imageModel = state_->model.get();
  if (input->shape[3]==32) {
    state_->rgbProxy.reset(new RgbProxyModel(input));
    if (!state_->rgbProxy->get_input()->data) { unload(); return false; }
    imageModel = state_->rgbProxy.get();
  }
  state_->pre.reset(new dl::image::ImagePreprocessor(
      imageModel, {0, 0, 0}, {255, 255, 255}));
  state_->pre->enable_letterbox({114, 114, 114});
  state_->model->profile_memory();
  resetTimeline();
  Serial.printf("model_ready=1 bytes=%u psram_free=%u heap_free=%u\n",
                unsigned(length), ESP.getFreePsram(), ESP.getFreeHeap());
  return true;
}
bool S3PoseModel::loadFile(const char* path) {
  File file = LittleFS.open(path, "r");
  if (!file || file.size() < 1024 || file.size() > 3500000) return false;
  const size_t length = file.size();
  auto* bytes = uploadBuffer(length);
  if (!bytes) return false;
  if (file.read(bytes, length) != length) {
    return false;
  }
  const String manifestPath = String(path) + ".meta.json";
  if (LittleFS.exists(manifestPath)) {
    File meta = LittleFS.open(manifestPath, "r");
    JsonDocument manifest;
    if (!meta || deserializeJson(manifest, meta) ||
        !acceptedModel(manifest, length, modelDigest(bytes, length))) {
      Serial.println("model_file=integrity_error");
      return false;
    }
  }
  return loadOwned(bytes, length);
}
void S3PoseModel::resetTimeline() {
  state_->core.reset();
  state_->activeRotation = -1;
  state_->autoRotation = 0;
  state_->emptyFrames = 0;
  state_->probeRotation = 90;
  state_->probeBurst = 3;
  state_->nextProbeUs = 0;
  state_->lumaReady = false;
}
bool S3PoseModel::saveFile(const char* path, bool replaceExisting) {
  if (!ready()) return false;
  const size_t free = LittleFS.totalBytes() - LittleFS.usedBytes();
  File previous = LittleFS.open(path, "r");
  const size_t oldLength = previous ? previous.size() : 0;
  const bool hasTemporarySpace = free >= state_->length + 65536;
  if (!hasTemporarySpace &&
      (!replaceExisting || free + oldLength < state_->length + 65536))
    return false;
  const String newDigest = modelDigest(state_->modelBytes, state_->length),
               manifestPath = String(path) + ".meta.json";
  JsonDocument accepted;
  auto entries = accepted["accepted"].to<JsonArray>();
  auto next = entries.add<JsonObject>();
  next["bytes"] = state_->length;
  next["sha256"] = newDigest;
  if (previous) {
    const String oldDigest = fileDigest(previous);
    bool oldValid = true;
    if (LittleFS.exists(manifestPath)) {
      File oldMeta = LittleFS.open(manifestPath, "r");
      JsonDocument known;
      oldValid = oldMeta && !deserializeJson(known, oldMeta) &&
                 acceptedModel(known, oldLength, oldDigest);
    }
    if (oldValid) {
      auto old = entries.add<JsonObject>();
      old["bytes"] = oldLength;
      old["sha256"] = oldDigest;
    }
    previous.close();
  }
  // Persist both permitted hashes first. A reset before replacement can still
  // load the old file; a partial replacement is rejected before
  // deserialization.
  File meta = LittleFS.open(manifestPath + ".new", "w");
  if (!meta) return false;
  const size_t metaLength = serializeJson(accepted, meta);
  meta.flush();
  meta.close();
  if (!metaLength || !LittleFS.rename(manifestPath + ".new", manifestPath))
    return false;
  const String destination =
      hasTemporarySpace ? String(path) + ".pending" : String(path);
  File file = LittleFS.open(destination, "w");
  if (!file) return false;
  const bool written =
      file.write(state_->modelBytes, state_->length) == state_->length;
  file.flush();
  file.close();
  if (!written) {
    return false;
  }
  File verify = LittleFS.open(destination, "r");
  if (!verify || verify.size() != state_->length ||
      fileDigest(verify) != newDigest)
    return false;
  verify.close();
  return destination == String(path) || LittleFS.rename(destination, path);
}
bool S3PoseModel::infer(const uint8_t* jpeg, size_t length, double timestamp,
                        int rotation, bool mirror, S3PoseResult& result) {
  if (!ready()) return false;
  InferencePriority priority;
  const int64_t started = esp_timer_get_time();
  int sourceWidth = 0, sourceHeight = 0;
  auto image = poseguard_image::decode_pose_jpeg(jpeg, length, sourceWidth, sourceHeight,state_->workingLimit());
  if (!image.data) return false;
  const auto imageQuality = poseguard_image::image_quality(
      static_cast<const uint8_t*>(image.data),image.width,image.height);
  int chosen = rotation < 0 ? state_->autoRotation : rotation;
  // Keep the decoder's buffer when the installation needs no transform.
  auto corrected = chosen == 0 && !mirror ? image : rotate(image, chosen, mirror);
  if (!corrected.data) {
    heap_caps_free(image.data);
    return false;
  }
  float modelMs = 0;
  auto observations = state_->detect(corrected, modelMs);
  // Always execute the actual model, including benchmark frames. Unusable
  // images cannot create new observations, counters or orientation evidence.
  if (!imageQuality.usable()) observations.clear();
  float quality = orientationQuality(observations);
  if (rotation < 0 && imageQuality.usable()) {
    std::array<uint8_t, 64> luma{};
    const auto* pixels = static_cast<uint8_t*>(image.data);
    float mean = 0;
    for (int i = 0; i < 64; ++i) {
      unsigned sum = 0;
      for (int by = 0; by < 4; ++by)
        for (int bx = 0; bx < 4; ++bx) {
          const int x = ((i % 8) * 8 + 2 * bx + 1) * image.width / 64,
                    y = ((i / 8) * 8 + 2 * by + 1) * image.height / 64;
          const auto* pixel = pixels + (y * image.width + x) * 3;
          sum += (pixel[0] + 2 * pixel[1] + pixel[2]) / 4;
        }
      luma[i] = sum / 16;
      mean += int(luma[i]) - state_->previousLuma[i];
    }
    mean /= 64;
    float motion = 0;
    for (int i = 0; i < 64; ++i)
      motion += std::abs(int(luma[i]) - int(state_->previousLuma[i]) - mean);
    if (state_->lumaReady && motion / 64 > 6 && quality < 1.4f)
      state_->probeBurst = 3;
    state_->previousLuma = luma;
    state_->lumaReady = true;
  }
  if (rotation < 0 && imageQuality.usable() && (state_->probeBurst || quality < 1.4f) &&
      (state_->probeBurst ||
       uint64_t(esp_timer_get_time()) >= state_->nextProbeUs)) {
    const int alternative = state_->probeRotation == chosen
                                ? (state_->probeRotation + 90) % 360
                                : state_->probeRotation;
    state_->probeRotation = (alternative + 90) % 360;
    if (state_->probeBurst) --state_->probeBurst;
    auto next = rotate(image, alternative, mirror);
    if (next.data) {
      float nextMs = 0;
      auto candidate = state_->detect(next, nextMs);
      modelMs += nextMs;
      const float candidateQuality = orientationQuality(candidate);
      if (candidateQuality >= 1.4f && candidateQuality > quality + .06f) {
        if (corrected.data != image.data) heap_caps_free(corrected.data);
        corrected = next;
        next.data = nullptr;
        observations = std::move(candidate);
        chosen = alternative;
        quality = orientationQuality(observations);
      }
      heap_caps_free(next.data);
    }
    state_->nextProbeUs = esp_timer_get_time() + 2500000;
  }
  state_->autoRotation = chosen;
  if (!state_->core || state_->width != corrected.width ||
      state_->height != corrected.height || state_->activeRotation != chosen ||
      state_->activeMirror != mirror) {
    poseguard::CoreConfig cfg;
    cfg.frame_width = corrected.width;
    cfg.frame_height = corrected.height;
    cfg.missing_track_seconds = 5;
    cfg.confirmation_frames = 3;
    // At roughly 3 FPS the original model can occasionally take more than
    // 350 ms between fresh captures. A tentative track must survive that
    // interval to receive its next observation.
    const auto* input = state_->model->get_input();
    const int networkSide = input->shape[1] * (state_->rgbProxy ? 2 : 1);
    cfg.unconfirmed_missing_seconds = networkSide <= 128 ? .35 : .90;
    state_->core.reset(new poseguard::PoseCore(cfg));
    state_->width = corrected.width;
    state_->height = corrected.height;
    state_->activeRotation = chosen;
    state_->activeMirror = mirror;
  }
  result = {};
  result.width = sourceWidth;
  result.height = sourceHeight;
  result.rotation = chosen;
  result.mirror = mirror;
  result.imageQuality = imageQuality;
  result.orientationAvailable = imageQuality.usable() && (rotation >= 0 || quality >= 1.4f);
  result.tracks = state_->core->update_tracks(observations, timestamp);
  result.risks = state_->core->evaluate(result.tracks, corrected.width,
                                        corrected.height, timestamp);
  if (!imageQuality.usable()) {
    result.tracks.clear();
    result.risks.clear();
  }
  const float sourceScaleX = float(sourceWidth) / image.width;
  const float sourceScaleY = float(sourceHeight) / image.height;
  auto sourceBox = [&](poseguard::BBox box) {
    box = original(box, image.width, image.height, chosen, mirror);
    return poseguard::BBox{box.x1 * sourceScaleX, box.y1 * sourceScaleY,
                           box.x2 * sourceScaleX, box.y2 * sourceScaleY};
  };
  for (auto& track : result.tracks) {
    track.bbox =
        sourceBox(track.bbox);
    track.center =
        original(track.center, image.width, image.height, chosen, mirror);
    track.center.x *= sourceScaleX;
    track.center.y *= sourceScaleY;
    for (auto& k : track.keypoints)
      if (k.valid) {
        const auto p = original(Point{k.x, k.y}, image.width, image.height,
                                chosen, mirror);
        k.x = p.x * sourceScaleX;
        k.y = p.y * sourceScaleY;
      }
  }
  for (auto& risk : result.risks)
    risk.bbox = sourceBox(risk.bbox);
  if (corrected.data != image.data) heap_caps_free(corrected.data);
  heap_caps_free(image.data);
  result.inferenceMs = modelMs;
  result.processingMs = (esp_timer_get_time() - started) / 1000.f;
  return true;
}
void S3PoseModel::metadata(JsonDocument& target, const S3PoseResult& result) {
  target["width"] = result.width;
  target["height"] = result.height;
  target["inference_fps"] =
      result.processingMs > 0 ? 1000.f / result.processingMs : 0;
  target["inference_ms"] = result.inferenceMs;
  target["processing_ms"] = result.processingMs;
  target["runtime_mode"] = state_->dualCore ? "dual" : "single";
  target["internal_budget_bytes"] = state_->loadedInternalBytes;
  target["input_layout"] = state_->rgbProxy ? "rgb_patch32" : "rgb";
  target["rgb_decode_limit"] = state_->workingLimit();
  target["detector_ready"] = ready();
  target["detector_present"] = true;
  target["detector_paused"] = false;
  target["input_quality"] = result.imageQuality.name();
  target["observation_available"] = result.imageQuality.usable();
  target["image_luma_mean"] = result.imageQuality.mean;
  target["image_luma_deviation"] = result.imageQuality.deviation;
  target["orientation"] = result.rotation;
  target["display_rotation"] = result.rotation;
  target["display_mirror"] = result.mirror;
  target["orientation_available"] = result.orientationAvailable;
  target["keypoint_confidence_kind"] = "model";
  auto tracks = target["tracks"].to<JsonArray>();
  int people = 0;
  for (const auto& track : result.tracks) {
    if (track.predicted || !track.confirmed) continue;
    ++people;
    auto item = tracks.add<JsonObject>();
    item["id"] = track.track_id;
    item["predicted"] = false;
    item["confidence"] = track.confidence;
    auto box = item["bbox"].to<JsonArray>();
    box.add(track.bbox.x1 / result.width);
    box.add(track.bbox.y1 / result.height);
    box.add(track.bbox.x2 / result.width);
    box.add(track.bbox.y2 / result.height);
    auto points = item["keypoints"].to<JsonArray>();
    for (const auto& k : track.keypoints)
      if (k.valid) {
        auto point = points.add<JsonArray>();
        point.add(k.x / result.width);
        point.add(k.y / result.height);
        point.add(k.confidence);
      } else
        points.add(nullptr);
  }
  target["people"] = people;
  auto risks = target["risks"].to<JsonArray>();
  for (const auto& risk : result.risks) {
    if (risk.state == poseguard::RiskState::Normal) continue;
    const auto observed=std::find_if(result.tracks.begin(),result.tracks.end(),[&](const auto& track) {
      return track.track_id==risk.track_id&&track.confirmed&&!track.predicted;
    });
    if(observed==result.tracks.end())continue;
    auto item = risks.add<JsonObject>();
    item["id"] = risk.track_id;
    item["kind"] = risk.kind == poseguard::RiskKind::PhoneToEar ? "phone_to_ear"
                   : risk.kind == poseguard::RiskKind::MultiPerson
                       ? "multi_person"
                       : "lingering";
    item["state"] =
        risk.state == poseguard::RiskState::Alert ? "alert" : "candidate";
    item["duration_s"] = risk.duration_seconds;
  }
}
S3Jpeg S3PoseModel::crop(const uint8_t* jpeg, size_t length,
                         const poseguard::BBox& box, int rotation,
                         bool mirror) {
  dl::image::jpeg_img_t source{.data = const_cast<uint8_t*>(jpeg),
                               .data_len = length};
  auto image =
      dl::image::sw_decode_jpeg(source, dl::image::DL_IMAGE_PIX_TYPE_RGB888);
  if (!image.data) return {};
  const int left = std::max(0, std::min(image.width - 1, int(box.x1))),
            top = std::max(0, std::min(image.height - 1, int(box.y1)));
  const int width =
                std::min(image.width - left, std::max(1, int(box.x2) - left)),
            height =
                std::min(image.height - top, std::max(1, int(box.y2) - top));
  auto* pixels = static_cast<uint8_t*>(heap_caps_malloc(
      size_t(width) * height * 3, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!pixels) {
    heap_caps_free(image.data);
    return {};
  }
  for (int y = 0; y < height; ++y)
    memcpy(pixels + y * width * 3,
           static_cast<uint8_t*>(image.data) +
               ((top + y) * image.width + left) * 3,
           width * 3);
  dl::image::img_t crop{.data = pixels,
                        .width = static_cast<uint16_t>(width),
                        .height = static_cast<uint16_t>(height),
                        .pix_type = dl::image::DL_IMAGE_PIX_TYPE_RGB888};
  auto upright = rotate(crop, rotation, mirror);
  auto encoded = upright.data ? dl::image::sw_encode_jpeg(upright, 65)
                              : dl::image::jpeg_img_t{};
  heap_caps_free(upright.data);
  heap_caps_free(pixels);
  heap_caps_free(image.data);
  if (!encoded.data || encoded.data_len > 60000) {
    heap_caps_free(encoded.data);
    return {};
  }
  return {std::shared_ptr<uint8_t>(static_cast<uint8_t*>(encoded.data),
                                   [](uint8_t* p) { heap_caps_free(p); }),
          encoded.data_len};
}
#endif
