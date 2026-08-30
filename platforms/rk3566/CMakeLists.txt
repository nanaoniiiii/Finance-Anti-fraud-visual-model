cmake_minimum_required(VERSION 3.16)

project(poseguard_rk3566 LANGUAGES CXX)

option(POSEGUARD_BUILD_TESTS "Build host-side tests" OFF)
option(POSEGUARD_ENABLE_BOARD "Build the RK3566 executable" ON)

add_library(poseguard_core OBJECT src/core.cpp src/rknn_pose.cpp)
target_include_directories(
  poseguard_core
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_features(poseguard_core PUBLIC cxx_std_17)
target_compile_options(poseguard_core PRIVATE -Wall -Wextra -Wpedantic)

if(POSEGUARD_ENABLE_BOARD)
  find_package(Threads REQUIRED)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(
    GSTREAMER
    REQUIRED
    IMPORTED_TARGET
    gstreamer-1.0
    gstreamer-app-1.0
  )
  find_path(
    RKNN_INCLUDE_DIR
    rknn_api.h
    HINTS $ENV{RKNN_ROOT}
    PATH_SUFFIXES include
  )
  find_library(
    RKNN_RUNTIME_LIBRARY
    rknnrt
    HINTS $ENV{RKNN_ROOT}
    PATH_SUFFIXES aarch64 lib
  )
  if(NOT RKNN_INCLUDE_DIR OR NOT RKNN_RUNTIME_LIBRARY)
    message(FATAL_ERROR "RKNN 2.3.2 headers and AArch64 runtime library were not found")
  endif()

  add_executable(
    poseguard-rk3566
    src/main.cpp
    src/rknn_engine.cpp
    src/runtime.cpp
    src/video_source.cpp
  )
  target_link_libraries(poseguard-rk3566 PRIVATE poseguard_core)
  target_link_libraries(poseguard-rk3566 PRIVATE ${RKNN_RUNTIME_LIBRARY})
  target_link_libraries(poseguard-rk3566 PRIVATE PkgConfig::GSTREAMER)
  target_link_libraries(poseguard-rk3566 PRIVATE Threads::Threads)
  target_include_directories(poseguard-rk3566 PRIVATE ${RKNN_INCLUDE_DIR})
  target_compile_definitions(
    poseguard-rk3566
    PRIVATE
      POSEGUARD_WITH_RKNN=1
      POSEGUARD_WITH_GSTREAMER=1
  )
  target_compile_options(poseguard-rk3566 PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(POSEGUARD_BUILD_TESTS)
  enable_testing()
  add_executable(poseguard_types_test tests/test_main.cpp)
  target_link_libraries(poseguard_types_test PRIVATE poseguard_core)
  target_compile_options(poseguard_types_test PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME poseguard_types COMMAND poseguard_types_test)

  add_executable(poseguard_core_test tests/test_core.cpp)
  target_link_libraries(poseguard_core_test PRIVATE poseguard_core)
  target_compile_options(poseguard_core_test PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME poseguard_core COMMAND poseguard_core_test)

  add_executable(poseguard_decoder_test tests/test_decoder.cpp)
  target_link_libraries(poseguard_decoder_test PRIVATE poseguard_core)
  target_compile_options(poseguard_decoder_test PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME poseguard_decoder COMMAND poseguard_decoder_test)

  add_executable(poseguard_uvc_test tests/test_uvc.cpp src/video_source.cpp)
  target_link_libraries(poseguard_uvc_test PRIVATE poseguard_core)
  target_compile_options(poseguard_uvc_test PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME poseguard_uvc COMMAND poseguard_uvc_test)

  add_executable(poseguard_runtime_test tests/test_runtime.cpp src/runtime.cpp)
  target_link_libraries(poseguard_runtime_test PRIVATE poseguard_core)
  target_compile_options(poseguard_runtime_test PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME poseguard_runtime COMMAND poseguard_runtime_test)
endif()
