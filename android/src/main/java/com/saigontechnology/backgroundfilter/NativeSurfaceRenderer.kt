package com.saigontechnology.backgroundfilter

import android.view.Surface

/**
 * Contract between the renderer and the view that hosts its output.
 *
 * Mirrors VisionCamera's own `NativeFrameRenderer`: the view owns the `Surface`
 * and hands it over on create/change, the renderer draws into it. Kept as our own
 * interface rather than reusing VisionCamera's so the renderer does not have to
 * satisfy an API that also implies VisionCamera-managed frame delivery.
 *
 * ### One renderer, several views
 *
 * The renderer is a **process-wide singleton** (`tryGetBackgroundRenderer` caches
 * it, so the warmed-up segmenter survives an effect being toggled off and on), but
 * a host can easily have more than one view bound to it at a time — two camera
 * screens stacked in a navigator is the ordinary case, since a router keeps the
 * screen underneath MOUNTED.
 *
 * That is why [disconnectSurface] takes the surface being given up rather than
 * meaning "disconnect whatever you are using". A departing view must not be able
 * to tear down a surface that a newer view has already connected — the two
 * lifecycles interleave (`surfaceCreated` for the arriving view routinely lands
 * before `surfaceDestroyed`/`dispose` for the leaving one), so an unconditional
 * disconnect leaves the renderer with no surface at all and no event that would
 * ever give it one back.
 */
interface NativeSurfaceRenderer {
  /** Draw into [surface] from now on, replacing any previous one. */
  fun connectSurface(surface: Surface, width: Int, height: Int)

  /**
   * Give up [surface]. A no-op unless it is the one currently connected, so a
   * view that has already been superseded cannot disconnect its successor.
   */
  fun disconnectSurface(surface: Surface)
}
