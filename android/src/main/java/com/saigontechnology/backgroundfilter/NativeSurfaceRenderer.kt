package com.saigontechnology.backgroundfilter

import android.view.Surface

/**
 * Contract between the renderer and the view that hosts its output.
 *
 * Mirrors VisionCamera's own `NativeFrameRenderer`: the view owns the `Surface`
 * and hands it over on create/change, the renderer draws into it. Kept as our own
 * interface rather than reusing VisionCamera's so the renderer does not have to
 * satisfy an API that also implies VisionCamera-managed frame delivery.
 */
interface NativeSurfaceRenderer {
  fun connectSurface(surface: Surface, width: Int, height: Int)

  fun disconnectSurface()
}
