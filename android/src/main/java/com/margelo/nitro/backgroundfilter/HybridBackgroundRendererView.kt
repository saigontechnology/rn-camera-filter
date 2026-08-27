package com.margelo.nitro.backgroundfilter

import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import com.facebook.react.uimanager.ThemedReactContext
import com.saigontechnology.backgroundfilter.NativeSurfaceRenderer

/**
 * Hosts the surface the composited frames are drawn into.
 *
 * The renderer may be assigned before the surface exists (the camera session
 * starts without waiting on layout) or the surface may exist before a renderer is
 * assigned, so both `renderer`'s setter and the surface callbacks have to be able
 * to complete the connection — whichever happens second wins.
 *
 * The renderer is a singleton shared with every other instance of this view, so
 * this class hands its own [connectedSurface] back on the way out rather than
 * asking the renderer to disconnect whatever it happens to be using. See
 * [NativeSurfaceRenderer.disconnectSurface] for what that protects against.
 */
class HybridBackgroundRendererView(
  val context: ThemedReactContext,
) : HybridBackgroundRendererViewSpec(),
  SurfaceHolder.Callback {

  private val surfaceView = SurfaceView(context)

  /**
   * The surface this view last handed to the renderer, or null if it never did (or
   * has already given it up). Held rather than re-read from the holder because a
   * `SurfaceHolder` keeps returning its `Surface` after the window is gone, and the
   * point of tracking it is to know what THIS view is responsible for.
   */
  private var connectedSurface: Surface? = null

  override val view: View
    get() = surfaceView

  init {
    // This view is always stacked on top of the camera preview, which is ALSO a
    // SurfaceView. Overlapping SurfaceViews are composited by SurfaceFlinger in
    // surface-creation order and ignore the View hierarchy entirely, so without
    // this the composited output is drawn correctly and then hidden behind the raw
    // preview — the filter looks like it does nothing at all, with no error.
    //
    // `setZOrderMediaOverlay` is the documented fix: it raises this surface above
    // other regular SurfaceViews while keeping it BELOW the window's view content,
    // so the host's RN overlays (teleprompter, controls) still draw on top.
    // `setZOrderOnTop` would raise it above those too, and hide them.
    surfaceView.setZOrderMediaOverlay(true)
    surfaceView.holder.addCallback(this)
  }


  override var renderer: HybridBackgroundRendererSpec? = null
    set(value) {
      releaseConnection(field)
      field = value
      connect()
    }

  private fun connect() {
    val nativeRenderer = renderer as? NativeSurfaceRenderer ?: return
    val holder = surfaceView.holder
    // `isCreating` is true between surfaceCreated and the first surfaceChanged,
    // when the surface exists but its size is not final yet.
    if (!holder.surface.isValid) {
      return
    }
    val frame = holder.surfaceFrame
    connectedSurface = holder.surface
    nativeRenderer.connectSurface(holder.surface, frame.width(), frame.height())
  }

  /**
   * Hands this view's surface back, if it still holds one. Safe to call repeatedly,
   * and safe when [target] is a renderer this view never connected to.
   */
  private fun releaseConnection(target: HybridBackgroundRendererSpec?) {
    val surface = connectedSurface ?: return
    connectedSurface = null
    (target as? NativeSurfaceRenderer)?.disconnectSurface(surface)
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    connect()
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    val nativeRenderer = renderer as? NativeSurfaceRenderer ?: return
    connectedSurface = holder.surface
    nativeRenderer.connectSurface(holder.surface, width, height)
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    releaseConnection(renderer)
  }

  override fun dispose() {
    super.dispose()
    surfaceView.holder.removeCallback(this)
    releaseConnection(renderer)
    renderer = null
  }
}
