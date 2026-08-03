package com.saigontechnology.backgroundfilter

/**
 * Native mirror of `src/composite/geometry.ts`.
 *
 * ## Why this exists at all
 *
 * The plan's rule is that fit/crop/mirror math lives in exactly one place. A GPU
 * shader cannot call TypeScript, and the frame's dimensions are only known
 * natively, so the live and offline composites need this math in-process.
 *
 * The rule is preserved as far as it can be:
 * - `geometry.ts` remains the **specification**, and is unit-tested (36 tests).
 * - This file is the **only** native copy, shared by the live renderer AND the
 *   offline processor on this platform — so there are two implementations in
 *   total (spec + native), never one per path.
 * - The golden-frame parity test (plan task 7) is what enforces that they agree;
 *   that is precisely the job the plan assigns it.
 *
 * Keep this in lockstep with `geometry.ts`. If you change one, change both and
 * re-run the parity test.
 */
object BackgroundGeometry {

  data class Rect(val x: Float, val y: Float, val width: Float, val height: Float)

  data class Layout(val source: Rect, val destination: Rect)

  private const val EPSILON = 1e-6f

  private val EMPTY = Layout(Rect(0f, 0f, 0f, 0f), Rect(0f, 0f, 0f, 0f))

  private fun isDegenerate(width: Float, height: Float): Boolean =
    width <= EPSILON || height <= EPSILON

  /**
   * Maps a background of [bgWidth] x [bgHeight] onto a frame of
   * [frameWidth] x [frameHeight].
   *
   * `cover` crops the background's overflowing axis and fills the frame, so the
   * destination is always the full frame. `contain` samples the whole background
   * and letterboxes it centred, so the source is always the full background.
   *
   * Degenerate input yields an empty layout rather than NaNs — callers draw it as
   * a no-op.
   */
  fun computeBackgroundLayout(
    bgWidth: Float,
    bgHeight: Float,
    frameWidth: Float,
    frameHeight: Float,
    fit: BackgroundFitMode,
  ): Layout {
    if (isDegenerate(bgWidth, bgHeight) || isDegenerate(frameWidth, frameHeight)) return EMPTY

    val backgroundRatio = bgWidth / bgHeight
    val frameRatio = frameWidth / frameHeight

    if (fit == BackgroundFitMode.COVER) {
      var cropWidth = bgWidth
      var cropHeight = bgHeight
      if (backgroundRatio > frameRatio) {
        cropWidth = bgHeight * frameRatio
      } else {
        cropHeight = bgWidth / frameRatio
      }
      return Layout(
        source = Rect((bgWidth - cropWidth) / 2f, (bgHeight - cropHeight) / 2f, cropWidth, cropHeight),
        destination = Rect(0f, 0f, frameWidth, frameHeight),
      )
    }

    var drawWidth = frameWidth
    var drawHeight = frameHeight
    if (backgroundRatio > frameRatio) {
      drawHeight = frameWidth / backgroundRatio
    } else {
      drawWidth = frameHeight * backgroundRatio
    }
    return Layout(
      source = Rect(0f, 0f, bgWidth, bgHeight),
      destination = Rect(
        (frameWidth - drawWidth) / 2f,
        (frameHeight - drawHeight) / 2f,
        drawWidth,
        drawHeight,
      ),
    )
  }

  /** Flips a rect horizontally inside a container of [containerWidth]. */
  fun mirrorRectHorizontally(rect: Rect, containerWidth: Float): Rect =
    Rect(containerWidth - rect.x - rect.width, rect.y, rect.width, rect.height)

  /**
   * Converts a [Layout]'s source rect into normalized texture coordinates
   * (0..1) for sampling the background, which is what the shader consumes.
   */
  fun sourceToTextureCoords(
    layout: Layout,
    bgWidth: Float,
    bgHeight: Float,
    mirror: Boolean,
  ): FloatArray {
    if (isDegenerate(bgWidth, bgHeight)) return floatArrayOf(0f, 0f, 1f, 1f)
    val source = if (mirror) mirrorRectHorizontally(layout.source, bgWidth) else layout.source
    return floatArrayOf(
      source.x / bgWidth,
      source.y / bgHeight,
      (source.x + source.width) / bgWidth,
      (source.y + source.height) / bgHeight,
    )
  }
}

/** Mirrors the public `BackgroundFit` union. */
enum class BackgroundFitMode {
  COVER,
  CONTAIN,
}
