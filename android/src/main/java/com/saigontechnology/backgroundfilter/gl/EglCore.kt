package com.saigontechnology.backgroundfilter.gl

import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.view.Surface

/**
 * Minimal EGL setup: one context, and up to two window surfaces.
 *
 * **An EGL context is current per-thread, and this class is deliberately used from
 * two of them.** The window surface is created wherever the surface arrives (the UI
 * thread, from a `SurfaceHolder` callback), while all _drawing_ happens on the
 * frame-delivery thread. So binding is not done at creation time: whoever draws
 * calls [makeCurrent] first, and the creating thread never takes the context.
 *
 * Getting this wrong is silent rather than loud — with no context current, every
 * `GLES20` call is a no-op that sets no error, so `glCreateShader` returns 0 and a
 * shader "fails to compile" with an empty info log.
 *
 * The **encoder surface** is the second one: a `MediaCodec` input `Surface` that the
 * record-time capture draws the same composite into. It shares this context — and
 * therefore every texture and program already uploaded — which is the whole reason
 * capturing costs one extra draw call rather than a second pipeline.
 */
class EglCore {

  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var context: EGLContext = EGL14.EGL_NO_CONTEXT
  private var config: EGLConfig? = null
  private var surface: EGLSurface = EGL14.EGL_NO_SURFACE
  private var encoderSurface: EGLSurface = EGL14.EGL_NO_SURFACE

  val hasSurface: Boolean
    get() = surface != EGL14.EGL_NO_SURFACE

  val hasEncoderSurface: Boolean
    get() = encoderSurface != EGL14.EGL_NO_SURFACE

  private fun ensureContext() {
    if (context != EGL14.EGL_NO_CONTEXT) return

    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    if (display == EGL14.EGL_NO_DISPLAY) throw RuntimeException("eglGetDisplay failed")

    val version = IntArray(2)
    if (!EGL14.eglInitialize(display, version, 0, version, 1)) {
      throw RuntimeException("eglInitialize failed")
    }

    val attributes = intArrayOf(
      EGL14.EGL_RED_SIZE, 8,
      EGL14.EGL_GREEN_SIZE, 8,
      EGL14.EGL_BLUE_SIZE, 8,
      EGL14.EGL_ALPHA_SIZE, 8,
      EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
      EGL14.EGL_NONE,
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val configCount = IntArray(1)
    if (!EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, configCount, 0) ||
      configCount[0] == 0
    ) {
      throw RuntimeException("eglChooseConfig failed")
    }
    config = configs[0]

    val contextAttributes = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
    context = EGL14.eglCreateContext(
      display, config, EGL14.EGL_NO_CONTEXT, contextAttributes, 0,
    )
    if (context == EGL14.EGL_NO_CONTEXT) throw RuntimeException("eglCreateContext failed")
  }

  /**
   * Creates the draw surface for [target], replacing any previous one.
   *
   * Deliberately does **not** make the context current: this runs on whichever
   * thread the `Surface` was handed to us on (the UI thread), and a context can be
   * current on only one thread at a time — taking it here would leave the drawing
   * thread unable to bind it, and `eglMakeCurrent` there would fail with
   * `EGL_BAD_ACCESS`. `eglCreateWindowSurface` needs no current context anyway.
   */
  fun createWindowSurface(target: Surface) {
    ensureContext()
    releaseSurface()
    surface = EGL14.eglCreateWindowSurface(display, config, target, intArrayOf(EGL14.EGL_NONE), 0)
    if (surface == EGL14.EGL_NO_SURFACE) throw RuntimeException("eglCreateWindowSurface failed")
  }

  /**
   * Binds the context to the calling thread. Must be called by the drawing thread
   * before any GL work, and is safe to call every frame — it short-circuits when
   * this thread already holds exactly this context and surface.
   *
   * Returns `false` instead of throwing when the bind fails, and callers must then
   * skip the frame. Failure here is **expected during teardown**: the view destroys
   * its `Surface` on the UI thread, and a frame already in flight on the delivery
   * thread can reach this with an `EGLSurface` whose window is gone. Throwing meant
   * leaving the screen surfaced a spurious render error to JS.
   */
  fun makeCurrent(): Boolean = bind(surface)

  fun swapBuffers(): Boolean = swap(surface)

  /**
   * Creates the second draw surface, over a `MediaCodec` input `Surface`.
   *
   * Must be called on the drawing thread, unlike [createWindowSurface] — the
   * encoder is started by the same thread that draws into it, so there is no
   * cross-thread handover to work around here.
   */
  fun createEncoderSurface(target: Surface) {
    ensureContext()
    releaseEncoderSurface()
    encoderSurface =
      EGL14.eglCreateWindowSurface(display, config, target, intArrayOf(EGL14.EGL_NONE), 0)
    if (encoderSurface == EGL14.EGL_NO_SURFACE) {
      throw RuntimeException("eglCreateWindowSurface failed for the encoder")
    }
  }

  fun makeCurrentEncoder(): Boolean = bind(encoderSurface)

  /**
   * Stamps the frame's timestamp on the encoder surface.
   *
   * `MediaCodec` reads its presentation times from the surface, not from the buffer,
   * so this has to happen between the draw and [swapEncoder] — a swap without it
   * gets the wall-clock time of the swap, which is what turns a variable-rate camera
   * into a clip that drifts out of sync with its audio.
   */
  fun setEncoderPresentationTime(nanos: Long) {
    if (encoderSurface == EGL14.EGL_NO_SURFACE) return
    EGLExt.eglPresentationTimeANDROID(display, encoderSurface, nanos)
  }

  fun swapEncoder(): Boolean = swap(encoderSurface)

  private fun bind(target: EGLSurface): Boolean {
    if (target == EGL14.EGL_NO_SURFACE) return false
    if (
      EGL14.eglGetCurrentContext() == context &&
      EGL14.eglGetCurrentSurface(EGL14.EGL_DRAW) == target
    ) {
      return true
    }
    return EGL14.eglMakeCurrent(display, target, target, context)
  }

  private fun swap(target: EGLSurface): Boolean {
    if (target == EGL14.EGL_NO_SURFACE) return false
    return EGL14.eglSwapBuffers(display, target)
  }

  fun releaseSurface() {
    if (surface != EGL14.EGL_NO_SURFACE) {
      EGL14.eglDestroySurface(display, surface)
      surface = EGL14.EGL_NO_SURFACE
    }
  }

  fun releaseEncoderSurface() {
    if (encoderSurface != EGL14.EGL_NO_SURFACE) {
      EGL14.eglDestroySurface(display, encoderSurface)
      encoderSurface = EGL14.EGL_NO_SURFACE
    }
  }

  fun release() {
    releaseSurface()
    releaseEncoderSurface()
    if (context != EGL14.EGL_NO_CONTEXT) {
      EGL14.eglMakeCurrent(
        display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT,
      )
      EGL14.eglDestroyContext(display, context)
      context = EGL14.EGL_NO_CONTEXT
    }
    if (display != EGL14.EGL_NO_DISPLAY) {
      EGL14.eglTerminate(display)
      display = EGL14.EGL_NO_DISPLAY
    }
    config = null
  }
}
