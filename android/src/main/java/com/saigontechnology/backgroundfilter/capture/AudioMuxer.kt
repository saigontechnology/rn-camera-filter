package com.saigontechnology.backgroundfilter.capture

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer

/**
 * Joins a video-only capture with the audio of another recording of the same take.
 *
 * ```
 * captured.mp4 (video) ─┐
 *                       ├─► MediaMuxer ─► output.mp4
 * raw.mp4 (audio)     ──┘
 * ```
 *
 * **Nothing is decoded.** Both tracks move sample-for-sample from a `MediaExtractor`
 * into a `MediaMuxer`, so this costs a file copy rather than a transcode and no code
 * here ever resamples or re-times audio — the same reason the offline bake copies its
 * audio through instead of owning A/V sync.
 *
 * The two files come from one camera session started at one moment, so their
 * timelines already agree. Audio is clipped to the video's duration, which is the
 * shorter of the two by construction: the capture stops before the recorder does.
 *
 * A source with no audio track is not an error — a muted recording should still
 * produce a playable file, so the video is copied through alone.
 *
 * Blocks; call it off the main thread.
 */
object AudioMuxer {

  class MuxError(message: String) : Exception(message)

  fun mux(rawVideoPath: String, rawAudioSourcePath: String, rawOutputPath: String): String {
    // `MediaExtractor`/`MediaMuxer` take filesystem paths, not URIs, and consumers
    // hand us whatever their file API produced — `file://…` on Expo. See the same
    // note in CompositeVideoRecorder; it cost a device run there.
    val videoPath = rawVideoPath.removePrefix("file://")
    val audioSourcePath = rawAudioSourcePath.removePrefix("file://")
    val outputPath = rawOutputPath.removePrefix("file://")

    val videoExtractor = MediaExtractor()
    val audioExtractor = MediaExtractor()
    var muxer: MediaMuxer? = null
    var completed = false

    try {
      videoExtractor.setDataSource(videoPath)
      val videoTrack = videoExtractor.firstTrackOf("video/")
        ?: throw MuxError("The captured file has no video track.")

      var audioTrack: Int? = null
      runCatching {
        audioExtractor.setDataSource(audioSourcePath)
        audioTrack = audioExtractor.firstTrackOf("audio/")
      }

      muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val outVideo = muxer.addTrack(videoExtractor.getTrackFormat(videoTrack))
      val outAudio = audioTrack?.let { muxer.addTrack(audioExtractor.getTrackFormat(it)) }
      muxer.start()

      val videoDurationUs = videoExtractor.getTrackFormat(videoTrack).optLong(MediaFormat.KEY_DURATION, 0L)
      copyTrack(videoExtractor, videoTrack, muxer, outVideo, Long.MAX_VALUE, 0L)
      if (audioTrack != null && outAudio != null) {
        val audioDurationUs = audioExtractor.getTrackFormat(audioTrack).optLong(MediaFormat.KEY_DURATION, 0L)
        // ─── Alignment ───
        //
        // The recording starts BEFORE the capture (the consumer waits for the
        // recorder to actually start, then begins encoding) and stops with it, so
        // the audio is longer, and the excess is at the HEAD: it is sound that was
        // captured before the first composited frame existed. Writing it from zero
        // is what makes the audio run ahead of the picture — measured at 370 ms on
        // the first device run, and a third of that is already audible.
        //
        // The gap between the two durations IS that head offset, so it is skipped
        // rather than guessed at. This holds only while the capture is contained
        // within the recording; `startCompositeCapture` documents that contract,
        // and if it is broken the worst case is the old behaviour (offset 0).
        val headOffsetUs = (audioDurationUs - videoDurationUs).coerceAtLeast(0L)
        // Past the video's end there is nothing to hear against, and a trailing
        // audio-only tail makes the clip's duration disagree with its picture.
        val limit = if (videoDurationUs > 0) headOffsetUs + videoDurationUs else Long.MAX_VALUE
        copyTrack(audioExtractor, audioTrack, muxer, outAudio, limit, headOffsetUs)
      }

      muxer.stop()
      completed = true
      return outputPath
    } finally {
      runCatching { muxer?.release() }
      runCatching { videoExtractor.release() }
      runCatching { audioExtractor.release() }
      // The caller only learns this path on success, so a partial file it cannot see
      // would leak for the lifetime of the install.
      if (!completed) runCatching { File(outputPath).delete() }
    }
  }

  /**
   * Copies samples in `[fromUs, untilUs]`, rebased so the first kept sample lands at
   * zero. `fromUs` is how the audio's head offset is removed — see [mux].
   */
  private fun copyTrack(
    extractor: MediaExtractor,
    trackIndex: Int,
    muxer: MediaMuxer,
    muxerTrack: Int,
    untilUs: Long,
    fromUs: Long,
  ) {
    extractor.selectTrack(trackIndex)
    // SEEK_TO_CLOSEST_SYNC can land before `fromUs`; the loop drops the remainder
    // sample by sample, which matters for audio where every frame is a sync frame
    // and seeking alone would round to an arbitrary boundary.
    extractor.seekTo(fromUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)

    val format = extractor.getTrackFormat(trackIndex)
    val maxSize = format.optInt(MediaFormat.KEY_MAX_INPUT_SIZE, 512 * 1024)
    val buffer = ByteBuffer.allocateDirect(maxSize)
    val info = MediaCodec.BufferInfo()

    while (true) {
      val size = extractor.readSampleData(buffer, 0)
      if (size < 0) break
      val time = extractor.sampleTime
      if (time > untilUs) break
      if (time < fromUs) {
        extractor.advance()
        continue
      }
      info.offset = 0
      info.size = size
      info.presentationTimeUs = time - fromUs
      info.flags = extractor.sampleFlags
      muxer.writeSampleData(muxerTrack, buffer, info)
      extractor.advance()
    }
    extractor.unselectTrack(trackIndex)
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
}
