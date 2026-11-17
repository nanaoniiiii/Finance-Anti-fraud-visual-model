#pragma once
#include "dl_image_jpeg.hpp"
#include "esp_heap_caps.h"
#include "esp_jpeg_dec.h"
#include <algorithm>

namespace poseguard_image {
// Downscale only the private RGB working image. The original JPEG is retained
// for previews/evidence; detections are mapped back to its coordinates.
inline dl::image::img_t decode_pose_jpeg(const uint8_t* bytes, size_t length,
                                        int& sourceWidth, int& sourceHeight,
                                        int workingLimit=384) {
  jpeg_dec_config_t cfg = DEFAULT_JPEG_DEC_CONFIG();
  jpeg_dec_handle_t decoder = nullptr;
  jpeg_dec_io_t io{};
  io.inbuf = const_cast<uint8_t*>(bytes);
  io.inbuf_len = length;
  jpeg_dec_header_info_t header{};
  if (jpeg_dec_open(&cfg, &decoder) != JPEG_ERR_OK) return {};
  if (jpeg_dec_parse_header(decoder, &io, &header) != JPEG_ERR_OK) {
    jpeg_dec_close(decoder); return {};
  }
  sourceWidth = header.width; sourceHeight = header.height;
  int width = sourceWidth, height = sourceHeight;
  const int longest = std::max(width, height);
  if (longest > workingLimit) {
    width = std::max(8, width * workingLimit / longest / 8 * 8);
    height = std::max(8, height * workingLimit / longest / 8 * 8);
    jpeg_dec_close(decoder); decoder = nullptr;
    cfg.scale.width = width; cfg.scale.height = height;
    if (jpeg_dec_open(&cfg, &decoder) != JPEG_ERR_OK) return {};
    io = {}; io.inbuf = const_cast<uint8_t*>(bytes); io.inbuf_len = length;
    if (jpeg_dec_parse_header(decoder, &io, &header) != JPEG_ERR_OK) {
      jpeg_dec_close(decoder); return {};
    }
  }
  int capacity = 0;
  const size_t expected = size_t(width) * height * 3;
  if (jpeg_dec_get_outbuf_len(decoder, &capacity) != JPEG_ERR_OK ||
      capacity < expected || capacity > size_t(sourceWidth) * sourceHeight * 3) {
    jpeg_dec_close(decoder); return {};
  }
  auto* pixels = static_cast<uint8_t*>(heap_caps_aligned_alloc(
      16, capacity, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!pixels) { jpeg_dec_close(decoder); return {}; }
  io.outbuf = pixels;
  const auto error = jpeg_dec_process(decoder, &io);
  jpeg_dec_close(decoder);
  if (error != JPEG_ERR_OK) { heap_caps_free(pixels); return {}; }
  return {.data = pixels, .width = static_cast<uint16_t>(width),
          .height = static_cast<uint16_t>(height),
          .pix_type = dl::image::DL_IMAGE_PIX_TYPE_RGB888};
}
}  // namespace poseguard_image
