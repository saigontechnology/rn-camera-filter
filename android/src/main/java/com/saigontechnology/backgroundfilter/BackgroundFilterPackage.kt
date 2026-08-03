package com.saigontechnology.backgroundfilter

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager
import com.margelo.nitro.backgroundfilter.VisionCameraBackgroundFilterOnLoad
import com.margelo.nitro.backgroundfilter.views.HybridBackgroundRendererViewManager

/**
 * The Android entry point for this library. It exposes no legacy bridge modules —
 * the JS-facing surface is Nitro HybridObjects — but it is **not** inert, and the
 * two things it does are both load-bearing:
 *
 * 1. **It loads the native library.** HybridObjects register themselves from
 *    `JNI_OnLoad`, which only runs once `libVisionCameraBackgroundFilter.so` is
 *    actually loaded — and nothing loads it implicitly. Without the
 *    `initializeNative()` call below, `NitroModules.hasHybridObject("BackgroundRenderer")`
 *    returns false, `getSegmentationSupport()` reports the device unsupported, and
 *    the whole feature disappears behind its own capability gate with no error
 *    anywhere. Everything still compiles, links, and packages the `.so`, which is
 *    why this survived every static check and was only caught on a device.
 * 2. **It registers the renderer's ViewManager.** `<BackgroundRendererView />` is a
 *    Nitro HybridView; nitrogen generates `HybridBackgroundRendererViewManager` but
 *    cannot register it for us. Unregistered, the view has no native counterpart to
 *    mount even once the library is loaded.
 *
 * Autolinking discovers this library by finding a `ReactPackage` implementation, so
 * the class must exist regardless. Mirrors VisionCamera's own `VisionCameraPackage`,
 * which does exactly these two things for the same reasons.
 */
class BackgroundFilterPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    HashMap()
  }

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<in Nothing, in Nothing>> = listOf(HybridBackgroundRendererViewManager())

  companion object {
    // In the companion initialiser, so the library is loaded as soon as autolinking
    // first touches this class — before any JS asks whether the renderer exists.
    init {
      VisionCameraBackgroundFilterOnLoad.initializeNative()
    }
  }
}
