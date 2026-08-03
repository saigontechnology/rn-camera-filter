#include "VisionCameraBackgroundFilterOnLoad.hpp"
#include <fbjni/fbjni.h>
#include <jni.h>

// Registers the nitrogen-generated JNI bindings. Everything the JS side reaches
// (BackgroundRenderer, BackgroundRendererView, OfflineVideoProcessor) is
// implemented in Kotlin; this is only the C++ entry point that binds them.
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::backgroundfilter::initialize(vm);
}
