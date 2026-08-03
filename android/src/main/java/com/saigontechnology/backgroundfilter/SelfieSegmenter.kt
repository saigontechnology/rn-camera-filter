package com.saigontechnology.backgroundfilter

import android.graphics.Bitmap
import android.media.Image
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.SegmentationMask
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import com.google.android.gms.tasks.Tasks
import java.nio.ByteBuffer
import java.util.concurrent.TimeUnit

/**
 * How much time the segmenter may spend on a frame.
 *
 * MLKit exposes this as STREAM vs SINGLE_IMAGE mode rather than a quality knob:
 * STREAM keeps temporal state between frames (smoother, cheaper) while
 * SINGLE_IMAGE treats each frame independently (better per-frame accuracy).
 */
enum class SegmentationQuality {
  /** Live preview — STREAM mode, temporally smoothed. */
  BALANCED,

  /** Offline bake — SINGLE_IMAGE mode, no frame deadline. */
  ACCURATE,
}

enum class SegmentationUnsupportedReason(val value: String) {
  OS_VERSION("os-version"),
  NO_MODEL("no-model"),
  UNSUPPORTED_DEVICE("unsupported-device"),
}

/**
 * The segmentation core. Deliberately NOT a Nitro HybridObject: no mask ever
 * crosses into JS. Both the live renderer and the offline bake own an instance
 * and call [segment] directly, which is what keeps the two paths producing
 * identical masks.
 */
class SelfieSegmenter(quality: SegmentationQuality) : AutoCloseable {

  companion object {
    /**
     * The bundled `segmentation-selfie` model ships inside the APK, so there is
     * no first-run download to fail or stall on. Availability is therefore a
     * property of the build, not of the device.
     */
    val isSupported: Boolean = true

    val unsupportedReason: SegmentationUnsupportedReason? = null

    /** Hard ceiling on a single frame's segmentation, so a wedged frame cannot stall the pipeline. */
    private const val FRAME_TIMEOUT_MS = 2_000L
  }

  private val segmenter = Segmentation.getClient(
    SelfieSegmenterOptions.Builder()
      .setDetectorMode(
        when (quality) {
          SegmentationQuality.BALANCED -> SelfieSegmenterOptions.STREAM_MODE
          SegmentationQuality.ACCURATE -> SelfieSegmenterOptions.SINGLE_IMAGE_MODE
        },
      )
      // Raw-size mask: we scale it in the shader rather than paying for MLKit's
      // CPU-side upscale to frame size on every frame.
      .enableRawSizeMask()
      .build(),
  )

  /**
   * Segments a camera image.
   *
   * MLKit's API is Task-based, but the renderer calls this from the camera thread
   * where the frame must be composited before it is released — so we block on the
   * task with a timeout rather than restructuring the whole pipeline as async.
   *
   * The returned [SegmentationMask]'s buffer is a `FloatBuffer` of confidences
   * (1.0 = person) whose dimensions may be SMALLER than the input, because raw-size
   * masks are enabled. Callers must scale when sampling, never assume it matches
   * the frame.
   *
   * Returns `null` when segmentation failed or timed out; callers draw the
   * unmodified frame rather than reusing a stale mask, which would smear the
   * previous frame's silhouette.
   */
  fun segment(image: Image, rotationDegrees: Int): SegmentationMask? {
    return try {
      val input = InputImage.fromMediaImage(image, rotationDegrees)
      Tasks.await(segmenter.process(input), FRAME_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    } catch (_: Throwable) {
      // Swallowed on purpose: a failed frame must not tear down the pipeline,
      // and the package does not log. The caller falls back to the raw frame.
      null
    }
  }

  /** Offline path — the bake decodes to bitmaps rather than camera images. */
  fun segment(bitmap: Bitmap): SegmentationMask? {
    return try {
      val input = InputImage.fromBitmap(bitmap, 0)
      Tasks.await(segmenter.process(input), FRAME_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    } catch (_: Throwable) {
      null
    }
  }

  /** Copies a mask's confidence buffer, since MLKit reuses its backing memory. */
  fun copyMaskBuffer(mask: SegmentationMask): ByteBuffer {
    val source = mask.buffer
    source.rewind()
    val copy = ByteBuffer.allocateDirect(source.remaining())
    copy.put(source)
    copy.rewind()
    source.rewind()
    return copy
  }

  override fun close() {
    segmenter.close()
  }
}
