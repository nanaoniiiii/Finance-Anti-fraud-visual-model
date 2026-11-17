file(GLOB_RECURSE ws_sources "${CMAKE_SOURCE_DIR}/libraries/ArduinoWebsockets/src/*.cpp")
idf_component_register(SRCS "app.cpp" "../../PoseGuardCloud/S3Pose.cpp" "../../../rk3566/src/core.cpp" ${ws_sources}
    INCLUDE_DIRS "../../PoseGuardCloud" "../../../rk3566/include" "${CMAKE_SOURCE_DIR}/libraries/ArduinoJson/src" "${CMAKE_SOURCE_DIR}/libraries/ArduinoWebsockets/src"
    REQUIRES arduino esp-dl esp32-camera joltwallet__littlefs esp_netif esp_wifi nvs_flash esp_websocket_client)
target_compile_definitions(${COMPONENT_LIB} PUBLIC POSEGUARD_CAMERA_XIAO=1 POSEGUARD_S3_MODEL=1)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error=format -Wno-error=deprecated-declarations)
idf_component_get_property(espdl_dir esp-dl COMPONENT_DIR)
include(${espdl_dir}/cmake/compile_register.cmake)
esp_dl_compile_add_yml("${CMAKE_CURRENT_LIST_DIR}/pose.compile_req.yml")
