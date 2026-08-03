package com.saigontechnology.backgroundfilter

import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.opengl.EGL14
import android.opengl.EGLExt
import com.saigontechnology.backgroundfilter.gl.CompositeGl
import com.saigontechnology.backgroundfilter.gl.EglCore
import java.io.File
import java.nio.ByteBuffer

/**
 * Bakes a background into an already-recorded file (Scenario 10, Android half).
 *
 * ```
 * MediaExtractor ─► MediaCodec decode ─► CompositeGl (GL) ─► MediaCodec encode ─► MediaMuxer
 *                                          ▲
 *                   SelfieSegmenter ───────┘
 *                   audio track ─────────────────── copied sample-for-sample ──► MediaMuxer
 * ```
 *
 * Two deliberate choices:
 *
 * 1. **The audio track is copied, never decoded.** Samples move straight from the
 *    extractor to the muxer, so this code never owns A/V sync — the single largest
 *    source of device-specific bugs in a pipeline like this.
 * 2. **The video decoder outputs YUV images, not a SurfaceTexture.** That means the
 *    composite reuses [CompositeGl] — the *same shader* as the live preview — instead
 *    of a second OES-sampler variant. Preview/output parity is then structural rather
 *    than something to test into, which is the same argument as iOS sharing one
 *    CoreImage graph. The cost is a per-frame CPU upload, acceptable off the realtime
 *    budget.
 *
 * Runs entirely on the caller's thread, which must not be the main thread.
 */
class OfflineVideoProcessor(
  private val inputPath: String,
  private val outputPath: String,
  private val backgroundUri: String?,
  private val fit: BackgroundFitMode,
  private val mirror: Boolean,
  private val maxOutputHeight: Int,
) {

  companion object {
    /** minU, minV, maxU, maxV covering the whole frame with no mirroring. */
    private val FULL_FRAME_UV = floatArrayOf(0f, 0f, 1f, 1f)
    private const val TIMEOUT_US = 10_000L
    private const val MIME_VIDEO = "video/avc"
    private const val FRAME_RATE_FALLBACK = 30
    private const val I_FRAME_INTERVAL = 1
    /** Matches the app's own upload target so the bake does not undo it. */
    private const val BITRATE_FALLBACK = 3_000_000
    private const val MAX_BACKGROUND_EDGE_PX = 1920
  }

  class ProcessingError(message: String) : Exception(message)

  /** 0..1, called from the processing thread. */
  var onProgress: ((Double) -> Unit)? = null

  @Volatile
  private var cancelled = false

  fun cancel() {
    cancelled = true
  }

  /**
   * Runs the bake to completion.
   *
   * @return the output path
   * @throws ProcessingError on any pipeline failure, or when cancelled
   */
  fun run(): String {
    val extractor = MediaExtractor()
    var decoder: MediaCodec? = null
    var encoder: MediaCodec? = null
    var muxer: MediaMuxer? = null
    val egl = EglCore()
    val composite = CompositeGl()
    var segmenter: SelfieSegmenter? = null
    var glReady = false
    // Anything short of a clean return leaves a half-muxed MP4 at `outputPath`.
    // The caller only learns that path on success, so nothing downstream can clean
    // it up — this flag is what lets the `finally` below tell a completed run from
    // a cancelled or failed one and delete the partial file.
    var completed = false

    try {
      extractor.setDataSource(inputPath)

      val videoIndex = extractor.firstTrackOf("video/")
        ?: throw ProcessingError("The input file has no video track.")
      val audioIndex = extractor.firstTrackOf("audio/")

      val inputFormat = extractor.getTrackFormat(videoIndex)
      val srcWidth = inputFormat.getInteger(MediaFormat.KEY_WIDTH)
      val srcHeight = inputFormat.getInteger(MediaFormat.KEY_HEIGHT)
      val rotation = inputFormat.optInt(MediaFormat.KEY_ROTATION, 0)
      val durationUs = inputFormat.optLong(MediaFormat.KEY_DURATION, 0L)

      // The rotation is baked into the pixels here (the GL pass rotates), so the
      // output needs no orientation hint — writing one would rotate twice on playback.
      val quarterTurned = rotation == 90 || rotation == 270
      val uprightWidth = if (quarterTurned) srcHeight else srcWidth
      val uprightHeight = if (quarterTurned) srcWidth else srcHeight

      // Encoders reject odd dimensions; scaling keeps the aspect and rounds to even.
      val (outWidth, outHeight) = scaleToCap(uprightWidth, uprightHeight, maxOutputHeight)

      val background = backgroundUri?.let { decodeBackground(it) }
      segmenter = SelfieSegmenter(SegmentationQuality.ACCURATE)

      // ─── Encoder first: its input Surface is what GL draws into ───
      val outFormat = MediaFormat.createVideoFormat(MIME_VIDEO, outWidth, outHeight).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, inputFormat.optInt(MediaFormat.KEY_BIT_RATE, BITRATE_FALLBACK))
        setInteger(MediaFormat.KEY_FRAME_RATE, inputFormat.optInt(MediaFormat.KEY_FRAME_RATE, FRAME_RATE_FALLBACK))
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL)
      }
      encoder = MediaCodec.createEncoderByType(MIME_VIDEO)
      encoder.configure(outFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      val inputSurface = encoder.createInputSurface()
      encoder.start()

      egl.createWindowSurface(inputSurface)
      // Bind the context on this thread before any GL work. `createWindowSurface`
      // deliberately does NOT bind (the live renderer creates its surface on the UI
      // thread and draws on another), so every caller has to do it itself. This
      // whole pipeline runs on one thread, so binding once here is enough.
      if (!egl.makeCurrent()) throw ProcessingError("Could not bind the GL context.")

      // ─── Decoder: null surface, so frames come back as YUV_420_888 Images ───
      decoder = MediaCodec.createDecoderByType(
        inputFormat.getString(MediaFormat.KEY_MIME) ?: throw ProcessingError("Unknown video MIME."),
      )
      decoder.configure(inputFormat, null, null, 0)
      decoder.start()
      extractor.selectTrack(videoIndex)

      muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

      var muxerVideoTrack = -1
      var muxerAudioTrack = -1
      var muxerStarted = false
      val encoderInfo = MediaCodec.BufferInfo()

      var sawInputEos = false
      var sawDecoderEos = false
      var sawEncoderEos = false
      var lastPresentationUs = 0L

      while (!sawEncoderEos) {
        if (cancelled) throw ProcessingError("Cancelled.")

        // 1. Feed the decoder.
        if (!sawInputEos) {
          val index = decoder.dequeueInputBuffer(TIMEOUT_US)
          if (index >= 0) {
            val buffer = decoder.getInputBuffer(index)!!
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) {
              decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              sawInputEos = true
            } else {
              decoder.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }

        // 2. Drain the decoder, composite, and hand the result to the encoder.
        if (!sawDecoderEos) {
          val info = MediaCodec.BufferInfo()
          val index = decoder.dequeueOutputBuffer(info, TIMEOUT_US)
          if (index >= 0) {
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
              sawDecoderEos = true
            }
            if (info.size > 0) {
              val image = decoder.getOutputImage(index)
              if (image != null) {
                if (!glReady) {
                  composite.setUp()
                  background?.let { composite.uploadBackground(it) }
                  glReady = true
                }

                val mask = if (composite.isBackgroundUploaded) {
                  segmenter.segment(image, rotation)?.let { toMaskBytes(it, segmenter) }
                } else {
                  null
                }

                val layout = BackgroundGeometry.computeBackgroundLayout(
                  bgWidth = (background?.width ?: 0).toFloat(),
                  bgHeight = (background?.height ?: 0).toFloat(),
                  frameWidth = outWidth.toFloat(),
                  frameHeight = outHeight.toFloat(),
                  fit = fit,
                )
                val backgroundUv = BackgroundGeometry.sourceToTextureCoords(
                  layout,
                  (background?.width ?: 1).toFloat(),
                  (background?.height ?: 1).toFloat(),
                  mirror,
                )

                val planes = image.planes
                composite.draw(
                  yPlane = planes[0].buffer,
                  uvPlane = planes[1].buffer,
                  frameWidth = image.width,
                  frameHeight = image.height,
                  mask = mask?.buffer,
                  maskWidth = mask?.width ?: 0,
                  maskHeight = mask?.height ?: 0,
                  // A decoder pads its rows to a stride just as the camera does, and
                  // ignoring it shears the image. Same bug, same fix, same shader.
                  yRowStride = planes[0].rowStride,
                  uvRowStride = planes[1].rowStride,
                  backgroundUv = backgroundUv,
                  // The whole frame, unmirrored. Unlike the live preview there is no
                  // view to fit: the output IS the frame (`outWidth`/`outHeight` are
                  // derived from it), so there is nothing to crop, and recorded files
                  // are never mirrored.
                  frameUv = FULL_FRAME_UV,
                  viewportWidth = outWidth,
                  viewportHeight = outHeight,
                  rotationDegrees = rotation,
                )
                image.close()

                // The encoder takes its timestamps from the EGL surface, so the
                // source PTS has to be stamped on before the swap.
                EGLExt.eglPresentationTimeANDROID(
                  EGL14.eglGetCurrentDisplay(),
                  EGL14.eglGetCurrentSurface(EGL14.EGL_DRAW),
                  info.presentationTimeUs * 1000,
                )
                egl.swapBuffers()

                lastPresentationUs = info.presentationTimeUs
                if (durationUs > 0) {
                  onProgress?.invoke((info.presentationTimeUs.toDouble() / durationUs).coerceIn(0.0, 1.0))
                }
              }
            }
            decoder.releaseOutputBuffer(index, false)
            if (sawDecoderEos) encoder.signalEndOfInputStream()
          }
        }

        // 3. Drain the encoder into the muxer.
        val encIndex = encoder.dequeueOutputBuffer(encoderInfo, TIMEOUT_US)
        when {
          encIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            // The muxer needs every track added before start(), so the audio track
            // is added here too — at the one moment the video format is known.
            muxerVideoTrack = muxer.addTrack(encoder.outputFormat)
            if (audioIndex != null) {
              muxerAudioTrack = muxer.addTrack(extractor.getTrackFormat(audioIndex))
            }
            muxer.start()
            muxerStarted = true
          }
          encIndex >= 0 -> {
            val encoded = encoder.getOutputBuffer(encIndex)!!
            val isConfig = encoderInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
            if (!isConfig && encoderInfo.size > 0 && muxerStarted) {
              encoded.position(encoderInfo.offset)
              encoded.limit(encoderInfo.offset + encoderInfo.size)
              muxer.writeSampleData(muxerVideoTrack, encoded, encoderInfo)
            }
            encoder.releaseOutputBuffer(encIndex, false)
            if (encoderInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawEncoderEos = true
          }
        }
      }

      // 4. Copy the audio track verbatim — no decode, no re-encode, no sync work.
      if (audioIndex != null && muxerAudioTrack >= 0) {
        copyTrack(extractor, audioIndex, muxer, muxerAudioTrack)
      }

      muxer.stop()
      onProgress?.invoke(1.0)
      completed = true
      return outputPath
    } finally {
      // Ordered teardown: GL objects need their context current, so they go before
      // the EGL release; the encoder's input surface must outlive the EGL surface.
      if (glReady) runCatching { composite.release() }
      runCatching { egl.release() }
      runCatching { decoder?.stop() }
      runCatching { decoder?.release() }
      runCatching { encoder?.stop() }
      runCatching { encoder?.release() }
      runCatching { muxer?.release() }
      runCatching { extractor.release() }
      runCatching { segmenter?.close() }
      if (!completed) runCatching { File(outputPath).delete() }
    }
  }

  private class MaskBytes(val buffer: ByteBuffer, val width: Int, val height: Int)

  /** MLKit hands back float confidences; the shader samples 8-bit. */
  private fun toMaskBytes(
    mask: com.google.mlkit.vision.segmentation.SegmentationMask,
    segmenter: SelfieSegmenter,
  ): MaskBytes {
    val floats = mask.buffer
    floats.rewind()
    val count = mask.width * mask.height
    val target = ByteBuffer.allocateDirect(count)
    for (i in 0 until count) {
      target.put((floats.float.coerceIn(0f, 1f) * 255f).toInt().toByte())
    }
    target.rewind()
    floats.rewind()
    return MaskBytes(target, mask.width, mask.height)
  }

  /**
   * Decodes the background, downscaled — same cap and the same reason as the live
   * renderer: the bundled images reach 8192px, past many GPUs' texture limit.
   */
  private fun decodeBackground(uri: String): Bitmap? =
    runCatching {
      val bytes = when {
        uri.startsWith("http://") || uri.startsWith("https://") ->
          java.net.URL(uri).openStream().use { it.readBytes() }
        uri.startsWith("file://") -> File(java.net.URI(uri)).readBytes()
        else -> File(uri).readBytes()
      }
      val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
      android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
      var sample = 1
      while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_BACKGROUND_EDGE_PX) sample *= 2
      android.graphics.BitmapFactory.decodeByteArray(
        bytes, 0, bytes.size,
        android.graphics.BitmapFactory.Options().apply { inSampleSize = sample },
      )
    }.getOrNull()

  /** Fits [width]x[height] under [cap] on the long edge, rounded to even dimensions. */
  private fun scaleToCap(width: Int, height: Int, cap: Int): Pair<Int, Int> {
    val longest = maxOf(width, height)
    if (cap <= 0 || longest <= cap) return even(width) to even(height)
    val scale = cap.toDouble() / longest
    return even((width * scale).toInt()) to even((height * scale).toInt())
  }

  private fun even(value: Int): Int = if (value % 2 == 0) value else value - 1

  private fun copyTrack(
    extractor: MediaExtractor,
    trackIndex: Int,
    muxer: MediaMuxer,
    muxerTrack: Int,
  ) {
    extractor.unselectTrack(trackIndex)
    extractor.selectTrack(trackIndex)
    extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)

    val format = extractor.getTrackFormat(trackIndex)
    val maxSize = format.optInt(MediaFormat.KEY_MAX_INPUT_SIZE, 256 * 1024)
    val buffer = ByteBuffer.allocateDirect(maxSize)
    val info = MediaCodec.BufferInfo()

    while (!cancelled) {
      val size = extractor.readSampleData(buffer, 0)
      if (size < 0) break
      info.offset = 0
      info.size = size
      info.presentationTimeUs = extractor.sampleTime
      info.flags = extractor.sampleFlags
      muxer.writeSampleData(muxerTrack, buffer, info)
      extractor.advance()
    }
  }
}

private fun MediaExtractor.firstTrackOf(mimePrefix: String): Int? {
  for (i in 0 until trackCount) {
    val mime = getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
    if (mime.startsWith(mimePrefix)) return i
  }
  return null
}

private fun MediaFormat.optInt(key: String, fallback: Int): Int =
  if (containsKey(key)) getInteger(key) else fallback

private fun MediaFormat.optLong(key: String, fallback: Long): Long =
  if (containsKey(key)) getLong(key) else fallback
