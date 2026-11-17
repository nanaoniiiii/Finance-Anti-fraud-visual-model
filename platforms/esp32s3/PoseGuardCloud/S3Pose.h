#pragma once
#if defined(POSEGUARD_S3_MODEL)
#include <Arduino.h>
#include <ArduinoJson.h>
#include "PGUsbConsole.h"
#include "ImageQuality.h"

#include <memory>
#include <vector>

#include "poseguard/core.hpp"

struct S3PoseResult {
  int width{}, height{}, rotation{};
  bool mirror{}, orientationAvailable{};
  poseguard_image::Quality imageQuality;
  float inferenceMs{}, processingMs{};
  std::vector<poseguard::TrackState> tracks;
  std::vector<poseguard::RiskDecision> risks;
};
struct S3Jpeg {
  std::shared_ptr<uint8_t> bytes;
  size_t length{};
};
class S3PoseModel {
 public:
  S3PoseModel();
  ~S3PoseModel();
  bool loadFile(const char* path = "/pose-s3.espdl");
  bool saveFile(const char* path = "/pose-s3.espdl",bool replaceExisting=false);
  bool loadOwned(uint8_t* alignedBytes, size_t length);
  uint8_t* uploadBuffer(size_t length);
  void unload();
  bool ready() const;
  void resetTimeline();
  void runtimeOptions(bool dualCore, unsigned internalBytes);
  void preprocessLimit(unsigned longSide);
  void profile();
  bool infer(const uint8_t* jpeg, size_t length, double timestamp, int rotation,
             bool mirror, S3PoseResult& result);
  void metadata(JsonDocument& target, const S3PoseResult& result);
  static S3Jpeg crop(const uint8_t* jpeg, size_t length,
                     const poseguard::BBox& box,int rotation=0,bool mirror=false);

 private:
  struct Impl;
  std::unique_ptr<Impl> state_;
};
#endif
