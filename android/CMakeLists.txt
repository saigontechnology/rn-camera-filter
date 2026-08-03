project(VisionCameraBackgroundFilter)
cmake_minimum_required(VERSION 3.9.0)

set(PACKAGE_NAME VisionCameraBackgroundFilter)
set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 20)

# The library holds only nitrogen-generated sources for now; the actual
# implementation lives in Kotlin (see src/main/java/.../HybridBackgroundRenderer.kt).
add_library(${PACKAGE_NAME} SHARED src/main/cpp/cpp-adapter.cpp)

# Add Nitrogen specs
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/VisionCameraBackgroundFilter+autolinking.cmake)

include_directories("src/main/cpp")

find_library(LOG_LIB log)

# VisionCamera exports HybridFrameSpec, which BackgroundRenderer.renderFrame takes.
find_package(react-native-vision-camera REQUIRED)

target_link_libraries(
        ${PACKAGE_NAME}
        ${LOG_LIB}
        android
        react-native-vision-camera::VisionCamera
)
