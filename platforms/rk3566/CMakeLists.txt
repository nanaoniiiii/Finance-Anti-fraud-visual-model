cmake_minimum_required(VERSION 3.16)

project(poseguard_rk3566 LANGUAGES CXX)

option(POSEGUARD_BUILD_TESTS "Build host-side tests" OFF)
option(POSEGUARD_ENABLE_BOARD "Build the RK3566 executable" ON)

add_library(poseguard_core OBJECT src/core.cpp)
target_include_directories(
  poseguard_core
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_features(poseguard_core PUBLIC cxx_std_17)
target_compile_options(poseguard_core PRIVATE -Wall -Wextra -Wpedantic)

if(POSEGUARD_ENABLE_BOARD)
  add_executable(poseguard-rk3566 src/main.cpp)
  target_link_libraries(poseguard-rk3566 PRIVATE poseguard_core)
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
endif()
