package com.margelo.nitro.backgroundfilter

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.Image
import android.view.Surface
import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import com.margelo.nitro.camera.HybridFrameSpec
import com.margelo.nitro.camera.`public`.NativeFrame
import com.margelo.nitro.core.Promise
import com.saigontechnology.backgroundfilter.BackgroundFitMode
import com.saigontechnology.backgroundfilter.capture.CompositeVideoRecorder
import com.saigontechnology.backgroundfilter.BackgroundGeometry
import com.saigontechnology.backgroundfilter.NativeSurfaceRenderer
import com.saigontechnology.backgroundfilter.SegmentationQuality
import com.saigontechnology.backgroundfilter.SelfieSegmenter
import com.saigontechnology.backgroundfilter.gl.CompositeGl
import com.saigontechnology.backgroundfilter.gl.EglCore
import java.io.File
import java.net.URL
import java.nio.ByteBuffer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The live compositor.
 *
 * `renderFrame` runs on the `CameraFrameOutput` thread, which is also the thread
 * that owns the EGL context and every GL object. Nothing here is synchronized:
 * thread confinement is the safety argument, and the only cross-thread state is
 * [pendingBackground], which is written from JS and read on the render thread —
 * hence `@Volatile`.
 *
 * This class lives in `com.margelo.nitro.backgroundfilter` because nitrogen
 * hard-codes `com.margelo.nitro` as the base package for generated specs and
 * their implementations. Our own non-Nitro code stays under
 * `com.saigontechnology.backgroundfilter`.
 */
@OptIn(ExperimentalGetImage::class)
class HybridBackgroundRenderer :
  HybridBackgroundRendererSpec(),
  NativeSurfaceRenderer {

  private companion object {
    /**
     * Mirrors `MAX_BACKGROUND_EDGE_PX` in `src/assets/background/index.ts`.
     * Duplicated because native cannot read the TS constant; keep them in step.
     */
    const val MAX_BACKGROUND_EDGE_PX = 1920
  }

  private val segmenter = SelfieSegmenter(SegmentationQuality.BALANCED)
  private val egl = EglCore()
  private val composite = CompositeGl()

  private var isGlReady = false
  private var viewportWidth = 0
  private var viewportHeight = 0

  /** Set from JS, consumed on the render thread on the next frame. */
  @Volatile
  private var pendingBackground: PendingBackground? = null

  private var backgroundBitmap: Bitmap? = null
  private var fit: BackgroundFitMode = BackgroundFitMode.COVER
  private var mirror: Boolean = false

  /** Reused across frames so a 1080p mask isn't reallocated 30 times a second. */
  private var maskBytes: ByteBuffer? = null

  /** See `setCameraMirrored`. Plain field: read on the render thread, set from JS. */
  @Volatile
  private var cameraMirrored: Boolean = false

  private data class PendingBackground(val uri: String?, val fit: BackgroundFitMode, val mirror: Boolean)

  // ─── Record-time capture ───────────────────────────────────────────────────
  //
  // The encoder is owned by the GL thread (its input surface lives in that thread's
  // EGL context), but start/stop arrive from JS. So JS only ever posts a REQUEST,
  // which the next frame picks up, and everything that touches [recorder] runs
  // inside [captureLock] — including the per-frame draw, so a stop cannot free the
  // encoder out from under a frame already being drawn into it.

  private data class PendingCapture(
    val outputPath: String,
    val maxOutputHeight: Int,
    val aspectRatio: Double,
  )

  private val captureLock = Any()

  @Volatile
  private var pendingCapture: PendingCapture? = null

  private var recorder: CompositeVideoRecorder? = null

  /** Timestamp of the capture's first frame; every later one is written relative to it. */
  private var captureStartNanos = 0L

  /** Set when the encoder could not be configured; surfaced by `stopCapture`. */
  @Volatile
  private var captureFailure: Throwable? = null

  /**
   * Finishing the encoder blocks — it drains to end-of-stream and writes the moov
   * atom — so it runs off the JS thread. Single-threaded: only one capture can be
   * in flight, and finishing them in order is what the promise contract implies.
   */
  private val captureFinisher: ExecutorService =
    Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "BackgroundFilterCapture").apply { isDaemon = true }
    }

  override val isSupported: Boolean
    get() = SelfieSegmenter.isSupported

  override val unsupportedReason: String?
    get() = SelfieSegmenter.unsupportedReason?.value

  override fun setBackground(uri: String?, fit: BackgroundFit, mirror: Boolean) {
    val mode = when (fit) {
      BackgroundFit.COVER -> BackgroundFitMode.COVER
      BackgroundFit.CONTAIN -> BackgroundFitMode.CONTAIN
    }
    // Decoding and texture upload happen on the render thread; this only records
    // the request so JS never blocks on IO.
    pendingBackground = PendingBackground(uri, mode, mirror)
  }

  override fun setCameraMirrored(mirrored: Boolean) {
    cameraMirrored = mirrored
  }

  /**
   * Every device with a camera has a hardware H.264 encoder, so this tracks the
   * segmentation gate: without a mask there is no composite worth recording, and the
   * consumer would be better off using the camera's own recorder.
   */
  override val isCaptureSupported: Boolean
    get() = SelfieSegmenter.isSupported

  override fun startCapture(outputPath: String, maxOutputHeight: Double, aspectRatio: Double) {
    synchronized(captureLock) {
      if (recorder != null || pendingCapture != null) {
        throw IllegalStateException("A capture is already running.")
      }
      captureFailure = null
      captureStartNanos = 0L
      pendingCapture = PendingCapture(outputPath, maxOutputHeight.toInt(), aspectRatio)
    }
  }

  override fun stopCapture(): Promise<String> {
    val promise = Promise<String>()
    val running: CompositeVideoRecorder?
    val failure: Throwable?
    synchronized(captureLock) {
      running = recorder
      failure = captureFailure
      recorder = null
      pendingCapture = null
      captureFailure = null
    }
    // Clearing [recorder] above is what makes the rest of this safe: the frame thread
    // checks it under the same lock and stops touching the encoder immediately.

    when {
      failure != null -> promise.reject(failure)
      running == null -> promise.reject(IllegalStateException("No capture is running."))
      else -> captureFinisher.execute {
        try {
          promise.resolve(running.finish())
        } catch (e: Throwable) {
          promise.reject(e)
        } finally {
          // AFTER the encoder is done, never before: `finish()` signals end-of-stream
          // on the input surface and drains what comes back, and tearing the surface
          // down first is how that turns into a hang or an IllegalStateException.
          // Destroying it from this thread is fine — EGL defers the destroy while a
          // surface is current elsewhere.
          runCatching { egl.releaseEncoderSurface() }
        }
      }
    }
    return promise
  }

  override fun renderFrame(frame: HybridFrameSpec) {
    if (!egl.hasSurface) return

    val nativeFrame = frame as? NativeFrame ?: throw Error("Frame is not of type `NativeFrame`!")
    val image = nativeFrame.image.image ?: return

    // This runs on the frame-delivery thread, NOT the thread that created the
    // window surface — so the context has to be bound here. Without it every GL
    // call below is a silent no-op (see the note in EglCore). A failed bind means
    // the surface went away underneath us (the screen is being torn down), so drop
    // the frame rather than drawing into nothing.
    if (!egl.makeCurrent()) return

    applyPendingBackground()

    if (!isGlReady) {
      composite.setUp()
      isGlReady = true
    }
    uploadPendingBitmap()

    val rotation = nativeFrame.image.imageInfo.rotationDegrees
    val mask = if (composite.isBackgroundUploaded) segment(image, rotation) else null

    // A 90/270 rotation swaps the frame's DISPLAYED dimensions.
    val quarterTurned = rotation == 90 || rotation == 270
    val displayWidth = if (quarterTurned) image.height else image.width
    val displayHeight = if (quarterTurned) image.width else image.height

    // Everything is composed in the VIEWPORT's aspect, not the frame's. The camera
    // frame is cover-cropped into the viewport exactly as VisionCamera's own
    // PreviewView does (its `resizeMode` defaults to 'cover'), so turning the filter
    // on does not change the subject's shape. Sampling the full frame instead
    // stretched it onto whatever aspect the view had — a 9:16 frame in a 0.71 view
    // came out ~27% too wide.
    val cameraLayout = BackgroundGeometry.computeBackgroundLayout(
      bgWidth = displayWidth.toFloat(),
      bgHeight = displayHeight.toFloat(),
      frameWidth = viewportWidth.toFloat(),
      frameHeight = viewportHeight.toFloat(),
      fit = BackgroundFitMode.COVER,
    )
    val frameUv = BackgroundGeometry.sourceToTextureCoords(
      cameraLayout,
      displayWidth.toFloat(),
      displayHeight.toFloat(),
      // Never mirror via the rect: a centred crop is symmetric, so flipping it is a
      // no-op. Mirroring is applied by swapping the U bounds below.
      false,
    )
    // `Frame.isMirrored` means "the output is mirrored but these pixels are not", so
    // a renderer has to flip X itself — VisionCamera's docs say exactly that. With
    // the default `mirrorMode: 'auto'` this is true on the selfie camera, and
    // ignoring it made the filtered preview a mirror image of the unfiltered one.
    // XOR, so the two mirroring sources cannot cancel into a double flip: the
    // consumer asks for a mirrored *presentation*, while `isMirrored` reports that
    // the buffer's own handedness already differs from the output's.
    if (cameraMirrored != frame.isMirrored) {
      val minU = frameUv[0]
      frameUv[0] = frameUv[2]
      frameUv[2] = minU
    }

    // The background is fitted to the viewport for the same reason as the camera —
    // it is drawn over the same quad, so fitting it to the frame would stretch it by
    // the frame-to-viewport aspect difference.
    val layout = BackgroundGeometry.computeBackgroundLayout(
      bgWidth = (backgroundBitmap?.width ?: 0).toFloat(),
      bgHeight = (backgroundBitmap?.height ?: 0).toFloat(),
      frameWidth = viewportWidth.toFloat(),
      frameHeight = viewportHeight.toFloat(),
      fit = fit,
    )
    val backgroundUv = BackgroundGeometry.sourceToTextureCoords(
      layout,
      (backgroundBitmap?.width ?: 1).toFloat(),
      (backgroundBitmap?.height ?: 1).toFloat(),
      mirror,
    )

    val planes = image.planes
    composite.uploadFrame(
      yPlane = planes[0].buffer,
      uvPlane = planes[1].buffer,
      frameWidth = image.width,
      frameHeight = image.height,
      mask = mask?.buffer,
      maskWidth = mask?.width ?: 0,
      maskHeight = mask?.height ?: 0,
      // Rows are padded to a hardware stride that is not always the width — a
      // 1280x960 buffer on a Galaxy S22 is padded where a 960x720 one is not.
      // Ignoring it shears the image into vertical stripes.
      yRowStride = planes[0].rowStride,
      uvRowStride = planes[1].rowStride,
    )
    composite.drawUploaded(
      backgroundUv = backgroundUv,
      frameUv = frameUv,
      viewportWidth = viewportWidth,
      viewportHeight = viewportHeight,
      rotationDegrees = rotation,
    )
    egl.swapBuffers()

    captureFrame(displayWidth, displayHeight, rotation, nativeFrame.image.imageInfo.timestamp)
  }

  /**
   * Draws the frame just uploaded a second time, into the capture encoder.
   *
   * Deliberately a separate draw rather than a copy of the preview: the two targets
   * want different geometry. The preview is cover-cropped into whatever aspect the
   * view has; the recording is cover-cropped into the ENCODER's aspect, which the
   * consumer sets to whatever the camera's own recorder writes. Both are unmirrored,
   * as the offline bake and the `expo-camera` path are, so a clip made with the
   * filter matches one made without it in shape as well as handedness.
   *
   * The textures are already resident, so this costs one draw call, not a second
   * upload.
   */
  private fun captureFrame(
    displayWidth: Int,
    displayHeight: Int,
    rotation: Int,
    timestampNanos: Long,
  ) {
    synchronized(captureLock) {
      startPendingCapture(displayWidth, displayHeight)
      val recorder = this.recorder ?: return
      if (!egl.makeCurrentEncoder()) return

      val layout = BackgroundGeometry.computeBackgroundLayout(
        bgWidth = (backgroundBitmap?.width ?: 0).toFloat(),
        bgHeight = (backgroundBitmap?.height ?: 0).toFloat(),
        frameWidth = recorder.width.toFloat(),
        frameHeight = recorder.height.toFloat(),
        fit = fit,
      )
      val backgroundUv = BackgroundGeometry.sourceToTextureCoords(
        layout,
        (backgroundBitmap?.width ?: 1).toFloat(),
        (backgroundBitmap?.height ?: 1).toFloat(),
        mirror,
      )

      // Cover-crop the camera into the encoder's aspect, exactly as the preview pass
      // crops it into the view's. `FULL_FRAME_UV` was right only while the two shapes
      // matched; now the frames are 4:3 (to match the preview's field of view) and the
      // recording is the recorder's shape, so sampling the whole frame would squash it.
      val cameraLayout = BackgroundGeometry.computeBackgroundLayout(
        bgWidth = displayWidth.toFloat(),
        bgHeight = displayHeight.toFloat(),
        frameWidth = recorder.width.toFloat(),
        frameHeight = recorder.height.toFloat(),
        fit = BackgroundFitMode.COVER,
      )
      val captureFrameUv = BackgroundGeometry.sourceToTextureCoords(
        cameraLayout,
        displayWidth.toFloat(),
        displayHeight.toFloat(),
        // Never mirrored: recorded files are not, on any path.
        false,
      )

      composite.drawUploaded(
        backgroundUv = backgroundUv,
        frameUv = captureFrameUv,
        viewportWidth = recorder.width,
        viewportHeight = recorder.height,
        rotationDegrees = rotation,
      )
      // The timestamp goes on the surface, not the buffer, and has to be stamped
      // between the draw and the swap. Without it MediaCodec times frames by when
      // the swap happened, which drifts against the audio track we mux in later.
      //
      // Camera timestamps are absolute (nanos since boot), and neither MediaCodec
      // nor MediaMuxer rebases them — a clip whose first frame is at t=12345s is
      // what that produces. So the first captured frame defines zero.
      if (captureStartNanos == 0L) captureStartNanos = timestampNanos
      egl.setEncoderPresentationTime((timestampNanos - captureStartNanos).coerceAtLeast(0L))
      egl.swapEncoder()
      recorder.drain(endOfStream = false)
    }
  }

  /**
   * Configures the encoder on the first frame after `startCapture`.
   *
   * Deferred to the GL thread on purpose: the encoder's input surface has to be
   * wrapped in an `EGLSurface` on the thread that owns the context, and the output
   * size is not known until a frame arrives with its displayed dimensions.
   *
   * A configuration failure disables capture for this run rather than throwing into
   * the frame pipeline — the preview keeps working, and `stopCapture` reports it.
   */
  private fun startPendingCapture(displayWidth: Int, displayHeight: Int) {
    val request = pendingCapture ?: return
    pendingCapture = null

    val recorder =
      CompositeVideoRecorder(request.outputPath, request.maxOutputHeight, request.aspectRatio)
    try {
      val surface = recorder.start(displayWidth, displayHeight)
      egl.createEncoderSurface(surface)
      this.recorder = recorder
    } catch (e: Throwable) {
      runCatching { recorder.release(deleteOutput = true) }
      captureFailure = e
    }
  }

  private class Mask(val buffer: ByteBuffer, val width: Int, val height: Int)

  /**
   * Segments and converts MLKit's float confidences to the 8-bit texture the
   * shader samples. Returns null when the frame produced no mask — the caller then
   * draws the frame unmodified rather than reusing a stale silhouette.
   */
  private fun segment(image: Image, rotationDegrees: Int): Mask? {
    val result = segmenter.segment(image, rotationDegrees) ?: return null
    val floats = result.buffer
    floats.rewind()
    val pixelCount = result.width * result.height
    val target = maskBytes?.takeIf { it.capacity() >= pixelCount }
      ?: ByteBuffer.allocateDirect(pixelCount).also { maskBytes = it }
    target.clear()
    for (i in 0 until pixelCount) {
      target.put((floats.float.coerceIn(0f, 1f) * 255f).toInt().toByte())
    }
    target.rewind()
    floats.rewind()
    return Mask(target, result.width, result.height)
  }

  private fun applyPendingBackground() {
    val request = pendingBackground ?: return
    pendingBackground = null
    fit = request.fit
    mirror = request.mirror

    backgroundBitmap?.recycle()
    backgroundBitmap = request.uri?.let { decode(it) }
    // ALWAYS invalidate the uploaded texture, not just when the new background is
    // null. The texture on the GPU belongs to the bitmap we just recycled, and
    // [uploadPendingBitmap] skips the upload while `isBackgroundUploaded` is set —
    // so clearing it only for `null` meant switching from one background straight to
    // another kept showing the first. Going via "none" appeared to be required,
    // because that was the only path that cleared the flag.
    composite.clearBackground()
  }

  /**
   * Uploads the current background's texture, once per change.
   *
   * The guard is what keeps this off the per-frame path: `isBackgroundUploaded` is
   * cleared by [applyPendingBackground] whenever the bitmap changes and by
   * [connectSurface] when the GL context is rebuilt, so a return here means the
   * texture already matches [backgroundBitmap].
   */
  private fun uploadPendingBitmap() {
    val bitmap = backgroundBitmap ?: return
    if (composite.isBackgroundUploaded) return
    composite.uploadBackground(bitmap)
  }

  /**
   * Decodes a background, downscaled to at most [MAX_BACKGROUND_EDGE_PX] on its
   * longest edge.
   *
   * The downscale is not an optimisation, it is a correctness requirement. The
   * package's own bundled images go up to 8192x5464, which would decode to ~171 MB
   * of RGBA — an OOM on mid-range devices — and exceed the 4096px
   * `GL_MAX_TEXTURE_SIZE` that many GPUs report, making the texture upload fail
   * outright. Consumers can inject arbitrary images, so this cannot rely on assets
   * being well-sized.
   *
   * Supports the URI forms the JS side can produce: a `file://`/absolute path in
   * release, and an `http://` Metro URL in dev.
   *
   * Returns null on any failure — the renderer then passes the camera frame
   * through instead of showing a broken composite, and never logs.
   */
  private fun decode(uri: String): Bitmap? =
    try {
      // Two passes: measure, then decode subsampled. `inSampleSize` only honours
      // powers of two, so this lands at or below the cap, never above it.
      val bytes = readBytes(uri)
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)

      val longest = maxOf(bounds.outWidth, bounds.outHeight)
      var sampleSize = 1
      while (longest / sampleSize > MAX_BACKGROUND_EDGE_PX) {
        sampleSize *= 2
      }

      val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    } catch (_: Throwable) {
      null
    }

  private fun readBytes(uri: String): ByteArray =
    when {
      uri.startsWith("http://") || uri.startsWith("https://") ->
        URL(uri).openStream().use { it.readBytes() }
      uri.startsWith("file://") -> File(java.net.URI(uri)).readBytes()
      else -> File(uri).readBytes()
    }

  override fun connectSurface(surface: Surface, width: Int, height: Int) {
    viewportWidth = width
    viewportHeight = height
    egl.createWindowSurface(surface)
    // The old context's GL objects died with it; rebuild on the next frame.
    isGlReady = false
    composite.clearBackground()
  }

  override fun disconnectSurface() {
    egl.releaseSurface()
  }

  override fun dispose() {
    super.dispose()
    // A screen torn down mid-recording would otherwise leave an encoder running and
    // a half-muxed file nothing else knows the path of.
    synchronized(captureLock) {
      recorder?.release(deleteOutput = true)
      recorder = null
      pendingCapture = null
    }
    captureFinisher.shutdownNow()
    if (isGlReady) composite.release()
    isGlReady = false
    egl.release()
    backgroundBitmap?.recycle()
    backgroundBitmap = null
    segmenter.close()
  }
}
