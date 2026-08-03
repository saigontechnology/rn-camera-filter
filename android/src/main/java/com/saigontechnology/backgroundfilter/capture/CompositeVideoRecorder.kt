package com.saigontechnology.backgroundfilter.capture

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.view.Surface
import java.io.File

/**
 * Encodes the composited preview frames to a video-only MP4, as they are drawn.
 *
 * ```
 * CompositeGl ─► MediaCodec input Surface ─► MediaCodec encode ─► MediaMuxer ─► video-only .mp4
 * ```
 *
 * This is the record-time half of "what you see is what you upload": the renderer
 * draws the frame it is already showing into this encoder's surface, so the file
 * cannot disagree with the preview — there is only one composite.
 *
 * **No audio, by construction.** The microphone belongs to the camera session, whose
 * samples go to VisionCamera's own `Recorder`. That recorder runs alongside this one
 * and its audio track is remuxed onto this file afterwards
 * (`HybridOfflineVideoProcessor.muxAudio`), so nothing here ever owns A/V sync —
 * the same argument that made the offline bake safe.
 *
 * Every method must be called from the GL thread, which is also the thread that
 * draws: the input surface belongs to that thread's EGL context.
 */
class CompositeVideoRecorder(
  outputPath: String,
  private val maxOutputHeight: Int,
  /**
   * Width/height the recording should have, or 0 to take the frame's own.
   *
   * The frames handed to us are shaped for the PREVIEW (4:3 on Android, to match the
   * preview stream's field of view), while the camera's own recorder writes 16:9.
   * Without this a filtered recording would come out a different shape than an
   * unfiltered one.
   */
  private val aspectRatio: Double,
) {

  /**
   * `MediaMuxer` takes a filesystem path and rejects a URI, but consumers hand us
   * whatever their file API produced — and on Expo that is a `file://` URI
   * (`FileSystem.cacheDirectory`). Passing it through cost a device run: the muxer
   * threw, the capture was silently disabled, and the app fell back to the offline
   * bake as if the device could not capture at all.
   */
  private val outputPath: String = outputPath.removePrefix("file://")

  private companion object {
    const val MIME = "video/avc"
    const val FRAME_RATE = 30
    const val I_FRAME_INTERVAL = 1
    /**
     * Bits per pixel per FRAME. 0.15 puts 720x1280@30 near 4 Mbps, in line with the
     * offline bake's 3 Mbps fallback and with what the app uploads.
     *
     * Note the unit: an earlier value of "4 bits per pixel per second" was multiplied
     * by the frame rate as well, asking the encoder for ~110 Mbps on a 720p clip.
     */
    const val BITS_PER_PIXEL_PER_FRAME = 0.15
    const val TIMEOUT_US = 0L
  }

  class CaptureError(message: String) : Exception(message)

  private var encoder: MediaCodec? = null
  private var muxer: MediaMuxer? = null
  private var muxerTrack = -1
  private var muxerStarted = false
  private val bufferInfo = MediaCodec.BufferInfo()
  private var encodedSamples = 0

  var width: Int = 0
    private set
  var height: Int = 0
    private set

  /**
   * Configures the encoder for a [frameWidth] x [frameHeight] source and returns the
   * `Surface` to draw into. The returned size ([width] x [height]) may be smaller —
   * see [maxOutputHeight] — and is always even, which H.264 encoders require.
   */
  fun start(frameWidth: Int, frameHeight: Int): Surface {
    val (cropWidth, cropHeight) = cropToAspect(frameWidth, frameHeight, aspectRatio)
    val (outWidth, outHeight) = scaleToCap(cropWidth, cropHeight, maxOutputHeight)
    if (outWidth < 2 || outHeight < 2) {
      throw CaptureError("Frame is too small to encode ($frameWidth x $frameHeight).")
    }
    width = outWidth
    height = outHeight

    val format = MediaFormat.createVideoFormat(MIME, outWidth, outHeight).apply {
      setInteger(
        MediaFormat.KEY_COLOR_FORMAT,
        MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
      )
      setInteger(
        MediaFormat.KEY_BIT_RATE,
        (outWidth * outHeight * FRAME_RATE * BITS_PER_PIXEL_PER_FRAME).toInt(),
      )
      setInteger(MediaFormat.KEY_FRAME_RATE, FRAME_RATE)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL)
    }

    val codec = MediaCodec.createEncoderByType(MIME)
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    val surface = codec.createInputSurface()
    codec.start()
    encoder = codec

    // The rotation is already baked into the pixels by the GL pass, so no orientation
    // hint is written — one would rotate the clip a second time on playback.
    muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    return surface
  }

  /**
   * Moves whatever the encoder has produced into the muxer.
   *
   * Called after every frame with `endOfStream = false`, which is why the dequeue
   * timeout is zero: this runs on the frame-delivery thread and must never block the
   * preview waiting for output that has not been produced yet.
   */
  fun drain(endOfStream: Boolean) {
    val codec = encoder ?: return
    val muxer = muxer ?: return

    while (true) {
      val index = codec.dequeueOutputBuffer(bufferInfo, if (endOfStream) 10_000L else TIMEOUT_US)
      when {
        index == MediaCodec.INFO_TRY_AGAIN_LATER -> {
          // Nothing ready. When ending the stream the encoder still owes us an EOS
          // buffer, so keep waiting; otherwise return and try again next frame.
          if (!endOfStream) return
        }
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          if (!muxerStarted) {
            muxerTrack = muxer.addTrack(codec.outputFormat)
            muxer.start()
            muxerStarted = true
          }
        }
        index >= 0 -> {
          val encoded = codec.getOutputBuffer(index)
          val isConfig = bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
          if (encoded != null && !isConfig && bufferInfo.size > 0 && muxerStarted) {
            encoded.position(bufferInfo.offset)
            encoded.limit(bufferInfo.offset + bufferInfo.size)
            muxer.writeSampleData(muxerTrack, encoded, bufferInfo)
            encodedSamples++
          }
          codec.releaseOutputBuffer(index, false)
          if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
        }
      }
    }
  }

  /**
   * Flushes the encoder, closes the file, and returns its path.
   *
   * A capture that encoded nothing is a failure rather than an empty success — the
   * consumer would otherwise upload a file that plays as nothing — and the partial
   * output is deleted, since the caller only learns the path when this succeeds and
   * so has no way to clean it up itself.
   */
  fun finish(): String {
    val codec = encoder ?: throw CaptureError("No capture is running.")
    try {
      codec.signalEndOfInputStream()
      drain(endOfStream = true)
      if (encodedSamples == 0) throw CaptureError("The capture produced no frames.")
      muxer?.stop()
      return outputPath
    } catch (e: Throwable) {
      release(deleteOutput = true)
      throw e
    } finally {
      if (encoder != null) release(deleteOutput = false)
    }
  }

  /** Tears everything down. Safe to call twice, and after [finish]. */
  fun release(deleteOutput: Boolean) {
    runCatching { encoder?.stop() }
    runCatching { encoder?.release() }
    encoder = null
    runCatching { muxer?.release() }
    muxer = null
    muxerStarted = false
    if (deleteOutput) runCatching { File(outputPath).delete() }
  }

  /**
   * The largest region of [width]x[height] with the given width/height ratio, i.e. a
   * centre crop. `ratio <= 0` keeps the frame's own shape. The crop itself is applied
   * by the GL pass sampling a sub-rect; this only decides the encoder's dimensions.
   */
  private fun cropToAspect(width: Int, height: Int, ratio: Double): Pair<Int, Int> {
    if (ratio <= 0.0 || width <= 0 || height <= 0) return width to height
    val frameRatio = width.toDouble() / height
    return if (frameRatio > ratio) {
      // Frame is wider than wanted — keep the height, narrow the width.
      (height * ratio).toInt() to height
    } else {
      width to (width / ratio).toInt()
    }
  }

  /** Fits under [cap] on the long edge, rounded to even dimensions. 0 keeps the size. */
  private fun scaleToCap(width: Int, height: Int, cap: Int): Pair<Int, Int> {
    val longest = maxOf(width, height)
    if (cap <= 0 || longest <= cap) return even(width) to even(height)
    val scale = cap.toDouble() / longest
    return even((width * scale).toInt()) to even((height * scale).toInt())
  }

  private fun even(value: Int): Int = if (value % 2 == 0) value else value - 1
}
